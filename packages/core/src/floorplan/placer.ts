import {
  DesignSpec,
  FloorplanResult,
  PerimeterPin,
  PlacedMacro,
  Rot90,
  SynthesisResult,
} from '../types.js';
import { MacroVariantSet } from '../macro/compile.js';
import { mirrorMacroY, rotateMacro } from '../macro/transform.js';
import {
  alignFloatingPinsToMacros,
  minEdgeLengthForPins,
  resolvePerimeterPins,
} from './pins.js';
import { optimizePortAssignments } from './portSwap.js';
import {
  PlacerMacroState,
  PlacerNetLink,
  compactMacros2D,
  getActiveMacro,
  pairHaloFor,
  rectOverlapArea,
} from './compact.js';
import { buildLayeredPlacement } from './layered.js';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function computeTopoRanks(synth: SynthesisResult): Map<string, number> {
  const inDeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  const rank = new Map<string, number>();

  for (const n of synth.nodes) {
    inDeg.set(n.id, 0);
    adj.set(n.id, []);
    rank.set(n.id, 0);
  }
  for (const net of synth.nets) {
    adj.get(net.source.nodeId)?.push(net.sink.nodeId);
    inDeg.set(net.sink.nodeId, (inDeg.get(net.sink.nodeId) ?? 0) + 1);
  }

  const q: string[] = [];
  for (const [id, deg] of inDeg.entries()) {
    if (deg === 0) q.push(id);
  }

  while (q.length > 0) {
    const u = q.shift()!;
    const ru = rank.get(u) ?? 0;
    for (const v of adj.get(u) ?? []) {
      rank.set(v, Math.max(rank.get(v) ?? 0, ru + 1));
      const d = (inDeg.get(v) ?? 1) - 1;
      inDeg.set(v, d);
      if (d === 0) q.push(v);
    }
  }
  return rank;
}

function buildNetLinks(
  synth: SynthesisResult,
  macroIndexById: Map<string, number>,
  states: PlacerMacroState[],
  pins: PerimeterPin[],
): PlacerNetLink[] {
  const pinIdxById = new Map<string, number>();
  pins.forEach((p, idx) => pinIdxById.set(p.id, idx));

  const links: PlacerNetLink[] = [];
  for (const net of synth.nets) {
    let srcIdx = -1;
    let srcPinIdx = -1;
    if (net.source.nodeId.startsWith('in:')) {
      srcPinIdx = pinIdxById.get(net.source.nodeId) ?? -1;
    } else {
      srcIdx = macroIndexById.get(net.source.nodeId) ?? -1;
      if (srcIdx >= 0) {
        const m = states[srcIdx].orientCache[0][0][0];
        srcPinIdx = m.pins.findIndex((p) => p.id === net.source.pinId);
      }
    }

    let dstIdx = -1;
    let dstPinIdx = -1;
    if (net.sink.nodeId.startsWith('out:')) {
      dstPinIdx = pinIdxById.get(net.sink.nodeId) ?? -1;
    } else {
      dstIdx = macroIndexById.get(net.sink.nodeId) ?? -1;
      if (dstIdx >= 0) {
        const m = states[dstIdx].orientCache[0][0][0];
        dstPinIdx = m.pins.findIndex((p) => p.id === net.sink.pinId);
      }
    }

    if (srcPinIdx >= 0 && dstPinIdx >= 0) {
      links.push({
        srcIdx,
        srcPinIdx,
        dstIdx,
        dstPinIdx,
        weight: Math.max(1, net.ratePerSec / 10),
      });
    }
  }
  return links;
}

function evaluatePlacement(
  states: PlacerMacroState[],
  links: PlacerNetLink[],
  pins: PerimeterPin[],
  W: number,
  H: number,
  margin: number,
  halo: number,
  isFixedDie: boolean,
  aspect: number,
  useLivePinProjection: boolean,
): { cost: number; hpwl: number; overlap: number; outOfBounds: number } {
  let overlap = 0;
  let hardOverlap = 0;
  let outOfBounds = 0;
  let orientPenalty = 0;

  let bMinX = Infinity;
  let bMinY = Infinity;
  let bMaxX = -Infinity;
  let bMaxY = -Infinity;

  for (let i = 0; i < states.length; i++) {
    const si = states[i];
    const mi = getActiveMacro(si);

    if (si.x < bMinX) bMinX = si.x;
    if (si.y < bMinY) bMinY = si.y;
    if (si.x + mi.width > bMaxX) bMaxX = si.x + mi.width;
    if (si.y + mi.height > bMaxY) bMaxY = si.y + mi.height;

    const minX = margin;
    const minY = margin;
    const maxX = W - margin;
    const maxY = H - margin;
    if (si.x < minX) outOfBounds += (minX - si.x) * mi.height;
    if (si.y < minY) outOfBounds += (minY - si.y) * mi.width;
    if (si.x + mi.width > maxX) outOfBounds += (si.x + mi.width - maxX) * mi.height;
    if (si.y + mi.height > maxY) outOfBounds += (si.y + mi.height - maxY) * mi.width;

    // Flow-aligned orientation discipline (strongly prefers clean left-to-right flow)
    if (mi.kind === 'recipe-macro') {
      if (si.rot === 2) orientPenalty += 18;
      else if (si.rot === 1 || si.rot === 3) orientPenalty += 24;
    } else {
      if (si.rot === 2) orientPenalty += 12;
      else if (si.rot === 1 || si.rot === 3) orientPenalty += 6;
    }

    for (let j = i + 1; j < states.length; j++) {
      const sj = states[j];
      const mj = getActiveMacro(sj);
      // Extra 1-tile channel clearance around multi-port (4+ pin) balancers
      const pairHalo = pairHaloFor(mi, mj, halo);
      const ov = rectOverlapArea(
        si.x,
        si.y,
        mi.width + pairHalo,
        mi.height + pairHalo,
        sj.x,
        sj.y,
        mj.width + pairHalo,
        mj.height + pairHalo,
      );
      if (ov > 0) {
        overlap += ov;
        const hov = rectOverlapArea(
          si.x,
          si.y,
          mi.width,
          mi.height,
          sj.x,
          sj.y,
          mj.width,
          mj.height,
        );
        if (hov > 0) hardOverlap += hov;
      }
    }
  }

  let hpwl = 0;
  let flowPenalty = 0;
  for (const link of links) {
    let sx = 0;
    let sy = 0;
    let dx = 0;
    let dy = 0;

    if (link.srcIdx >= 0) {
      const st = states[link.srcIdx];
      const m = getActiveMacro(st);
      const pin = m.pins[link.srcPinIdx] ?? m.pins[0];
      sx = st.x + (pin ? pin.portX : m.width);
      sy = st.y + (pin ? pin.portY : Math.floor(m.height / 2));
    }
    if (link.dstIdx >= 0) {
      const st = states[link.dstIdx];
      const m = getActiveMacro(st);
      const pin = m.pins[link.dstPinIdx] ?? m.pins[0];
      dx = st.x + (pin ? pin.portX : 0);
      dy = st.y + (pin ? pin.portY : Math.floor(m.height / 2));
    }

    if (link.srcIdx < 0) {
      const p = pins[link.srcPinIdx];
      if (useLivePinProjection && !isFixedDie && !p.locked && states.length > 0) {
        sx =
          p.edge === 'W'
            ? bMinX - margin
            : p.edge === 'E'
              ? bMaxX + margin - 1
              : link.dstIdx >= 0
                ? dx
                : p.x;
        sy =
          p.edge === 'N'
            ? bMinY - margin
            : p.edge === 'S'
              ? bMaxY + margin - 1
              : link.dstIdx >= 0
                ? dy
                : p.y;
      } else {
        sx = p.x;
        sy = p.y;
      }
    }

    if (link.dstIdx < 0) {
      const p = pins[link.dstPinIdx];
      if (useLivePinProjection && !isFixedDie && !p.locked && states.length > 0) {
        dx =
          p.edge === 'W'
            ? bMinX - margin
            : p.edge === 'E'
              ? bMaxX + margin - 1
              : link.srcIdx >= 0
                ? sx
                : p.x;
        dy =
          p.edge === 'N'
            ? bMinY - margin
            : p.edge === 'S'
              ? bMaxY + margin - 1
              : link.srcIdx >= 0
                ? sy
                : p.y;
      } else {
        dx = p.x;
        dy = p.y;
      }
    }

    hpwl += Math.abs(sx - dx) + Math.abs(sy - dy);
    if (link.srcIdx >= 0 && link.dstIdx >= 0 && sx > dx) {
      flowPenalty += (sx - dx) * 3.5;
    }
  }

  let bboxPenalty = 0;
  if (!isFixedDie && states.length > 0) {
    const bboxW = Math.max(1, bMaxX - bMinX);
    const bboxH = Math.max(1, bMaxY - bMinY);
    const bboxArea = bboxW * bboxH;
    const aspectPen = Math.abs(bboxW / bboxH - aspect) * 18;
    bboxPenalty = bboxArea * 0.1 + (bboxW + bboxH) * 4.0 + aspectPen;
  }

  const cost =
    hpwl * 1.0 +
    flowPenalty +
    orientPenalty +
    bboxPenalty +
    overlap * 24.0 +
    hardOverlap * 240.0 +
    outOfBounds * 80.0;
  return { cost, hpwl, overlap, outOfBounds };
}

function legalizeMacros(
  states: PlacerMacroState[],
  W: number,
  H: number,
  margin: number,
  halo: number,
  isFixedDie: boolean,
): void {
  const sep = halo;

  const overlapsWithSep = (a: PlacerMacroState, b: PlacerMacroState): boolean => {
    const ma = getActiveMacro(a);
    const mb = getActiveMacro(b);
    const pairSep = pairHaloFor(ma, mb, sep);
    return (
      rectOverlapArea(
        a.x,
        a.y,
        ma.width + pairSep,
        ma.height + pairSep,
        b.x,
        b.y,
        mb.width + pairSep,
        mb.height + pairSep,
      ) > 0
    );
  };

  for (const s of states) {
    if (s.locked) continue;
    const m = getActiveMacro(s);
    if (isFixedDie) {
      const maxX = Math.max(margin, W - margin - m.width);
      const maxY = Math.max(margin, H - margin - m.height);
      s.x = Math.max(margin, Math.min(maxX, Math.round(s.x)));
      s.y = Math.max(margin, Math.min(maxY, Math.round(s.y)));
    } else {
      s.x = Math.max(margin, Math.round(s.x));
      s.y = Math.max(margin, Math.round(s.y));
    }
  }

  for (let pass = 0; pass < 12; pass++) {
    let anyMoved = false;
    for (let i = 0; i < states.length; i++) {
      for (let j = i + 1; j < states.length; j++) {
        const si = states[i];
        const sj = states[j];
        if (si.locked && sj.locked) continue;
        const mi = getActiveMacro(si);
        const mj = getActiveMacro(sj);
        const pairSep = pairHaloFor(mi, mj, sep);

        const ox =
          Math.min(si.x + mi.width + pairSep, sj.x + mj.width + pairSep) -
          Math.max(si.x, sj.x);
        const oy =
          Math.min(si.y + mi.height + pairSep, sj.y + mj.height + pairSep) -
          Math.max(si.y, sj.y);
        if (ox <= 0 || oy <= 0) continue;

        const moveTarget = !sj.locked ? sj : si;
        const other = moveTarget === sj ? si : sj;
        const mTarget = getActiveMacro(moveTarget);
        const mOther = getActiveMacro(other);

        if (ox <= oy) {
          const sign =
            moveTarget.x + mTarget.width / 2 >= other.x + mOther.width / 2 ? 1 : -1;
          moveTarget.x = Math.max(margin, moveTarget.x + sign * Math.ceil(ox / 2 + 1));
        } else {
          const sign =
            moveTarget.y + mTarget.height / 2 >= other.y + mOther.height / 2 ? 1 : -1;
          moveTarget.y = Math.max(margin, moveTarget.y + sign * Math.ceil(oy / 2 + 1));
        }

        if (isFixedDie) {
          moveTarget.x = Math.min(Math.max(margin, W - margin - mTarget.width), moveTarget.x);
          moveTarget.y = Math.min(Math.max(margin, H - margin - mTarget.height), moveTarget.y);
        }
        anyMoved = true;
      }
    }
    if (!anyMoved) break;
  }

  const placed: PlacerMacroState[] = states.filter((s) => s.locked);
  const unlocked = states.filter((s) => !s.locked);

  for (const s of unlocked) {
    if (!placed.some((p) => overlapsWithSep(s, p))) {
      placed.push(s);
      continue;
    }

    const overlapsWithLimit = (
      a: PlacerMacroState,
      b: PlacerMacroState,
      sepLimit: number,
    ): boolean => {
      const ma = getActiveMacro(a);
      const mb = getActiveMacro(b);
      const pairSep = sepLimit > 0 ? pairHaloFor(ma, mb, sepLimit) : 0;
      return (
        rectOverlapArea(
          a.x,
          a.y,
          ma.width + pairSep,
          ma.height + pairSep,
          b.x,
          b.y,
          mb.width + pairSep,
          mb.height + pairSep,
        ) > 0
      );
    };

    const tryFindSpot = (sepLimit: number, stepSize: number): boolean => {
      let foundScore = Infinity;
      let fx = s.x;
      let fy = s.y;
      let fRot = s.rot;
      let fVar = s.variantIdx;

      const varOpts =
        !isFixedDie || s.rowsLocked
          ? [s.variantIdx]
          : s.variants.map((_, idx) => idx);
      const rotOpts: Rot90[] =
        !isFixedDie || s.rotLocked ? [s.rot] : [0, 1];

      for (const vOpt of varOpts) {
        for (const rOpt of rotOpts) {
          const candMacro = s.orientCache[vOpt][s.flipY][rOpt];
          const limX = isFixedDie ? W - margin - candMacro.width : searchW - margin - candMacro.width;
          const limY = isFixedDie ? H - margin - candMacro.height : searchH - margin - candMacro.height;
          if (isFixedDie && (limX < margin || limY < margin)) continue;

          for (let cy = margin; cy <= Math.max(margin, limY); cy += stepSize) {
            for (let cx = margin; cx <= Math.max(margin, limX); cx += stepSize) {
              const cand: PlacerMacroState = {
                ...s,
                variantIdx: vOpt,
                rot: rOpt,
                x: cx,
                y: cy,
              };
              if (placed.some((p) => overlapsWithLimit(cand, p, sepLimit))) continue;
              const distOrig = Math.abs(cx - s.x) + Math.abs(cy - s.y);
              const compactBias =
                (cx + candMacro.width) * 0.25 + (cy + candMacro.height) * 0.25;
              const rotPen = rOpt === s.rot ? 0 : 12;
              const score = distOrig + compactBias + rotPen;
              if (score < foundScore) {
                foundScore = score;
                fx = cx;
                fy = cy;
                fRot = rOpt;
                fVar = vOpt;
              }
            }
          }
        }
      }

      if (foundScore < Infinity) {
        s.x = fx;
        s.y = fy;
        s.rot = fRot;
        s.variantIdx = fVar;
        return true;
      }
      return false;
    };

    const m = getActiveMacro(s);
    const searchW = isFixedDie ? W : Math.max(W, m.width + margin * 2 + 30);
    const searchH = isFixedDie ? H : Math.max(H, m.height + margin * 2 + 30);

    let placedClean = tryFindSpot(sep, 2);
    if (!placedClean && isFixedDie) {
      placedClean =
        tryFindSpot(sep, 1) ||
        (sep > 1 && tryFindSpot(1, 1)) ||
        tryFindSpot(0, 1);
    }

    if (!placedClean && !isFixedDie) {
      const maxBottom = placed.reduce(
        (acc, p) => Math.max(acc, p.y + getActiveMacro(p).height + sep),
        margin,
      );
      s.x = margin;
      s.y = maxBottom;
    }

    placed.push(s);
  }
}

export function runFloorplanAndPlacement(
  synth: SynthesisResult,
  variantSets: MacroVariantSet[],
  spec: DesignSpec,
): FloorplanResult {
  const margin = Math.max(2, spec.floorplan.margin ?? 3);
  const halo = Math.max(2, spec.floorplan.halo ?? 2);
  const aspect = Math.max(0.2, Math.min(5.0, spec.floorplan.aspectRatio ?? 1.35));
  const optLevel = spec.optimization?.level ?? 'compact';
  const doCompact = spec.optimization?.compactFloorplan ?? true;
  const doAlignPins = spec.optimization?.alignPins ?? true;
  const useLayered = spec.optimization?.layeredFloorplan ?? true;
  const doPortSwap = spec.optimization?.portSwap ?? true;
  const allowFlipY = spec.optimization?.allowFlipY ?? true;
  const compactMacros = spec.optimization?.compactMacros ?? true;
  const ranks = computeTopoRanks(synth);

  const states: PlacerMacroState[] = variantSets.map((vs) => {
    const ov = spec.macroOverrides[vs.id];
    const orientCache = vs.variants.map((v) => {
      const mirrored = mirrorMacroY(v);
      return [0, 1].map((flipIdx) =>
        ([0, 1, 2, 3] as Rot90[]).map((r) =>
          rotateMacro(flipIdx === 1 ? mirrored : v, r),
        ),
      );
    });
    let variantIdx = 0;
    if (ov?.rows !== undefined) {
      const idx = vs.variants.findIndex((v) => v.rows === ov.rows);
      if (idx >= 0) variantIdx = idx;
    }
    const noFlip = vs.variants.some((v) => v.noFlipY);
    const rot: Rot90 = ov?.rotation ?? 0;
    const flipY: 0 | 1 = noFlip ? 0 : ov?.flipY ? 1 : 0;
    return {
      id: vs.id,
      variants: vs.variants,
      orientCache,
      variantIdx,
      flipY,
      rot,
      x: ov?.x ?? margin,
      y: ov?.y ?? margin,
      locked: Boolean(ov?.locked && ov?.x !== undefined && ov?.y !== undefined),
      rotLocked: ov?.rotation !== undefined,
      flipLocked: noFlip || ov?.flipY !== undefined,
      rowsLocked: ov?.rows !== undefined,
      rank: ranks.get(vs.id) ?? 1,
    };
  });

  const macroIndexById = new Map<string, number>();
  states.forEach((s, i) => macroIndexById.set(s.id, i));

  const inCount = synth.nodes.filter((n) => n.kind === 'primary-input').length;
  const outCount = synth.nodes.filter((n) => n.kind === 'primary-output').length;
  const minW = Math.max(
    20,
    ...states.map((s) => getActiveMacro(s).width + 2 * margin + 2),
    ...states.filter((s) => s.locked).map((s) => s.x + getActiveMacro(s).width + margin),
  );
  const minH = Math.max(
    16,
    minEdgeLengthForPins(inCount),
    minEdgeLengthForPins(outCount),
    ...states.map((s) => getActiveMacro(s).height + 2 * margin + 2),
    ...states.filter((s) => s.locked).map((s) => s.y + getActiveMacro(s).height + margin),
  );

  let W: number;
  let H: number;
  const isFixed =
    spec.floorplan.mode === 'fixed' &&
    Boolean(spec.floorplan.width) &&
    Boolean(spec.floorplan.height);

  if (isFixed) {
    W = Math.max(16, Math.round(spec.floorplan.width!));
    H = Math.max(16, Math.round(spec.floorplan.height!));
  } else {
    const paddedArea = states.reduce((acc, s) => {
      const m = getActiveMacro(s);
      return acc + (m.width + halo) * (m.height + halo);
    }, 0);
    const channelArea = synth.nets.length * 14;
    const totalArea = Math.max(250, paddedArea * 1.15 + channelArea);
    W = Math.max(minW, Math.ceil(Math.sqrt(totalArea * aspect)));
    H = Math.max(minH, Math.ceil(totalArea / W));
  }

  // Initial spread by topological rank
  const maxRank = Math.max(1, ...states.map((s) => s.rank));
  const byRank = new Map<number, PlacerMacroState[]>();
  for (const s of states) {
    if (!byRank.has(s.rank)) byRank.set(s.rank, []);
    byRank.get(s.rank)!.push(s);
  }
  const usableW = Math.max(10, W - 2 * margin);
  const usableH = Math.max(10, H - 2 * margin);

  for (const [r, group] of byRank.entries()) {
    const colFrac = maxRank <= 1 ? 0.2 : (r - 1) / Math.max(1, maxRank);
    const colX = margin + Math.floor(colFrac * usableW * 0.72);
    let cursorY = margin;
    for (const s of group) {
      if (s.locked) continue;
      const m = getActiveMacro(s);
      s.x = Math.min(Math.max(margin, colX), Math.max(margin, W - margin - m.width));
      s.y = Math.min(Math.max(margin, cursorY), Math.max(margin, H - margin - m.height));
      cursorY += m.height + halo + 1;
      if (cursorY > usableH) cursorY = margin;
    }
  }

  const initialPins = resolvePerimeterPins(synth, spec, W, H);
  const warnings = [...initialPins.warnings];
  const links = buildNetLinks(synth, macroIndexById, states, initialPins.pins);

  let dagEdges: Array<{ src: number; dst: number }> = [];
  let bandByMacro: number[] | undefined;
  let skipSa = false;

  if (useLayered) {
    const layeredRes = buildLayeredPlacement(
      states,
      synth,
      macroIndexById,
      initialPins.pins,
      margin,
      halo,
      isFixed,
      W,
      H,
      aspect,
      allowFlipY,
      compactMacros,
    );
    dagEdges = layeredRes.dagEdges;
    bandByMacro = layeredRes.bandByMacro;
    skipSa = !isFixed || layeredRes.fitsFixed;
    for (const link of links) {
      if (link.srcIdx >= 0 && link.dstIdx >= 0) {
        link.isCrossBand = bandByMacro[link.srcIdx] !== bandByMacro[link.dstIdx];
      }
    }
  }

  // Simulated annealing fallback for fixed tight dies or when layered placement is disabled
  const movableIndices = states
    .map((s, idx) => (!s.locked ? idx : -1))
    .filter((i) => i >= 0);

  if (!skipSa && movableIndices.length > 0) {
    if (isFixed) {
      const innerW = Math.max(4, W - 2 * margin);
      const innerH = Math.max(4, H - 2 * margin);
      for (const idx of movableIndices) {
        const st = states[idx];
        const mCur = getActiveMacro(st);
        if (mCur.width > innerW || mCur.height > innerH) {
          let bestOv =
            Math.max(0, mCur.width - innerW) + Math.max(0, mCur.height - innerH);
          const vOpts = st.rowsLocked ? [st.variantIdx] : st.variants.map((_, i) => i);
          const rOpts: Rot90[] = st.rotLocked ? [st.rot] : [0, 1];
          for (const v of vOpts) {
            for (const r of rOpts) {
              const cand = st.orientCache[v][st.flipY][r];
              const ov =
                Math.max(0, cand.width - innerW) + Math.max(0, cand.height - innerH);
              if (ov < bestOv) {
                bestOv = ov;
                st.variantIdx = v;
                st.rot = r;
              }
            }
          }
        }
        const mFin = getActiveMacro(st);
        st.x = Math.max(margin, Math.min(Math.max(margin, W - margin - mFin.width), st.x));
        st.y = Math.max(margin, Math.min(Math.max(margin, H - margin - mFin.height), st.y));
      }
    }
    const rng = mulberry32(1337);
    let curEval = evaluatePlacement(
      states,
      links,
      initialPins.pins,
      W,
      H,
      margin,
      halo,
      isFixed,
      aspect,
      true,
    );
    let bestCost = curEval.cost;
    const bestSnap = states.map((s) => ({
      x: s.x,
      y: s.y,
      rot: s.rot,
      flipY: s.flipY,
      variantIdx: s.variantIdx,
    }));

    const totalIters =
      optLevel === 'fast'
        ? Math.min(1200, Math.max(500, states.length * 100))
        : optLevel === 'balanced'
          ? Math.min(2800, Math.max(900, states.length * 220))
          : Math.min(4500, Math.max(1400, states.length * 320));
    const maxStep = Math.max(6, Math.floor(Math.max(W, H) * 0.35));

    for (let iter = 0; iter < totalIters; iter++) {
      const progress = iter / totalIters;
      const temp = Math.max(0.2, 42 * Math.pow(0.008, progress));
      const idx = movableIndices[Math.floor(rng() * movableIndices.length)];
      const s = states[idx];

      const prevX = s.x;
      const prevY = s.y;
      const prevRot = s.rot;
      const prevFlip = s.flipY;
      const prevVar = s.variantIdx;

      const movePick = rng();
      if (movePick < 0.65) {
        const step = Math.max(1, Math.round(maxStep * (1 - progress * 0.8)));
        const dx = Math.floor((rng() * 2 - 1) * step);
        const dy = Math.floor((rng() * 2 - 1) * step);
        const m = getActiveMacro(s);
        s.x = Math.max(margin, Math.min(Math.max(margin, W - margin - m.width), s.x + dx));
        s.y = Math.max(margin, Math.min(Math.max(margin, H - margin - m.height), s.y + dy));
      } else if (movePick < 0.78 && allowFlipY && !s.flipLocked) {
        s.flipY = s.flipY ? 0 : 1;
      } else if (movePick < 0.88 && !s.rotLocked) {
        s.rot = (Math.floor(rng() * 4) as Rot90);
        const m = getActiveMacro(s);
        s.x = Math.max(margin, Math.min(Math.max(margin, W - margin - m.width), s.x));
        s.y = Math.max(margin, Math.min(Math.max(margin, H - margin - m.height), s.y));
      } else if (!s.rowsLocked && s.variants.length > 1) {
        s.variantIdx = Math.floor(rng() * s.variants.length);
        const m = getActiveMacro(s);
        s.x = Math.max(margin, Math.min(Math.max(margin, W - margin - m.width), s.x));
        s.y = Math.max(margin, Math.min(Math.max(margin, H - margin - m.height), s.y));
      } else if (movableIndices.length >= 2) {
        const idx2 = movableIndices[Math.floor(rng() * movableIndices.length)];
        if (idx2 !== idx) {
          const s2 = states[idx2];
          const prevX2 = s2.x;
          const prevY2 = s2.y;
          s.x = prevX2;
          s.y = prevY2;
          s2.x = prevX;
          s2.y = prevY;
          const nextEval = evaluatePlacement(
            states,
            links,
            initialPins.pins,
            W,
            H,
            margin,
            halo,
            isFixed,
            aspect,
            true,
          );
          const delta = nextEval.cost - curEval.cost;
          if (delta <= 0 || rng() < Math.exp(-delta / temp)) {
            curEval = nextEval;
            if (curEval.cost < bestCost) {
              bestCost = curEval.cost;
              for (let k = 0; k < states.length; k++) {
                bestSnap[k] = {
                  x: states[k].x,
                  y: states[k].y,
                  rot: states[k].rot,
                  flipY: states[k].flipY,
                  variantIdx: states[k].variantIdx,
                };
              }
            }
          } else {
            s.x = prevX;
            s.y = prevY;
            s2.x = prevX2;
            s2.y = prevY2;
          }
          continue;
        }
      }

      const nextEval = evaluatePlacement(
        states,
        links,
        initialPins.pins,
        W,
        H,
        margin,
        halo,
        isFixed,
        aspect,
        true,
      );
      const delta = nextEval.cost - curEval.cost;
      if (delta <= 0 || rng() < Math.exp(-delta / temp)) {
        curEval = nextEval;
        if (curEval.cost < bestCost) {
          bestCost = curEval.cost;
          for (let k = 0; k < states.length; k++) {
            bestSnap[k] = {
              x: states[k].x,
              y: states[k].y,
              rot: states[k].rot,
              flipY: states[k].flipY,
              variantIdx: states[k].variantIdx,
            };
          }
        }
      } else {
        s.x = prevX;
        s.y = prevY;
        s.rot = prevRot;
        s.flipY = prevFlip;
        s.variantIdx = prevVar;
      }
    }

    for (let k = 0; k < states.length; k++) {
      states[k].x = bestSnap[k].x;
      states[k].y = bestSnap[k].y;
      states[k].rot = bestSnap[k].rot;
      states[k].flipY = bestSnap[k].flipY;
      states[k].variantIdx = bestSnap[k].variantIdx;
    }
  }

  legalizeMacros(states, W, H, margin, halo, isFixed);

  if (doCompact) {
    compactMacros2D(
      states,
      links,
      initialPins.pins,
      W,
      H,
      margin,
      halo,
      isFixed,
      aspect,
      dagEdges,
      allowFlipY,
      bandByMacro,
    );
  }

  // Auto-die refinement around compacted macros
  if (!isFixed && states.length > 0) {
    const anyLocked = states.some((s) => s.locked);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const s of states) {
      const m = getActiveMacro(s);
      minX = Math.min(minX, s.x);
      minY = Math.min(minY, s.y);
      maxX = Math.max(maxX, s.x + m.width);
      maxY = Math.max(maxY, s.y + m.height);
    }

    if (!anyLocked) {
      const shiftX = margin - minX;
      const shiftY = margin - minY;
      for (const s of states) {
        s.x += shiftX;
        s.y += shiftY;
      }
      maxX += shiftX;
      maxY += shiftY;
    }

    const maxLockedNS = initialPins.pins
      .filter((p) => p.locked && (p.edge === 'N' || p.edge === 'S'))
      .reduce((acc, p) => Math.max(acc, p.offset + 2), 0);
    const maxLockedWE = initialPins.pins
      .filter((p) => p.locked && (p.edge === 'W' || p.edge === 'E'))
      .reduce((acc, p) => Math.max(acc, p.offset + 2), 0);

    const pinEdgePadW = Math.max(
      20,
      maxLockedNS,
      minEdgeLengthForPins(initialPins.pins.filter((p) => p.edge === 'N').length),
      minEdgeLengthForPins(initialPins.pins.filter((p) => p.edge === 'S').length),
    );
    const pinEdgePadH = Math.max(
      16,
      maxLockedWE,
      minEdgeLengthForPins(initialPins.pins.filter((p) => p.edge === 'W').length),
      minEdgeLengthForPins(initialPins.pins.filter((p) => p.edge === 'E').length),
    );
    W = Math.max(pinEdgePadW, maxX + margin);
    H = Math.max(pinEdgePadH, maxY + margin);
  }

  // Re-resolve pins on finalized die dimensions and uncross / align ports
  const finalPinsRes = resolvePerimeterPins(synth, spec, W, H);
  warnings.push(...finalPinsRes.warnings);

  const placedMacros: PlacedMacro[] = states.map((s) => ({
    id: s.id,
    macro: getActiveMacro(s),
    x: s.x,
    y: s.y,
    locked: s.locked,
    variants: s.variants,
  }));

  if (doPortSwap) {
    optimizePortAssignments(synth, placedMacros, finalPinsRes.pins);
  }

  const groupByBus = (spec.floorplan.headerMode ?? 'none') !== 'none';
  const finalPins = doAlignPins
    ? alignFloatingPinsToMacros(finalPinsRes.pins, synth, placedMacros, W, H, groupByBus)
    : finalPinsRes.pins;

  if (doPortSwap && doAlignPins) {
    optimizePortAssignments(synth, placedMacros, finalPins);
  }

  const finalLinks = buildNetLinks(synth, macroIndexById, states, finalPins);
  const finalEval = evaluatePlacement(
    states,
    finalLinks,
    finalPins,
    W,
    H,
    margin,
    halo,
    isFixed,
    aspect,
    false,
  );
  if ((finalEval.overlap > 0 || finalEval.outOfBounds > 0) && isFixed) {
    warnings.push(
      `Fixed die (${W}x${H}) is too tight for all macros + routing channels; enlarge W/H or switch to Auto-Compact.`,
    );
  }

  return {
    width: W,
    height: H,
    margin,
    halo,
    macros: placedMacros,
    pins: finalPins,
    hpwl: Math.round(finalEval.hpwl),
    warnings,
  };
}
