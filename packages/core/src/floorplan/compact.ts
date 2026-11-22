import { CompiledMacro, PerimeterPin, Rot90 } from '../types.js';

export interface PlacerMacroState {
  id: string;
  variants: CompiledMacro[];
  /** Indexed by [variantIdx][flipY (0|1)][rot90 (0..3)] */
  orientCache: CompiledMacro[][][];
  variantIdx: number;
  flipY: 0 | 1;
  rot: Rot90;
  x: number;
  y: number;
  locked: boolean;
  rotLocked: boolean;
  flipLocked: boolean;
  rowsLocked: boolean;
  rank: number;
}

export interface PlacerNetLink {
  srcIdx: number; // >= 0 for macro, -1 for perimeter pin
  srcPinIdx: number;
  dstIdx: number;
  dstPinIdx: number;
  weight: number;
  isCrossBand?: boolean;
}

export function rectOverlapArea(
  ax: number,
  ay: number,
  aw: number,
  ah: number,
  bx: number,
  by: number,
  bw: number,
  bh: number,
): number {
  const ox = Math.min(ax + aw, bx + bw) - Math.max(ax, bx);
  if (ox <= 0) return 0;
  const oy = Math.min(ay + ah, by + bh) - Math.max(ay, by);
  if (oy <= 0) return 0;
  return ox * oy;
}

export function getActiveMacro(s: PlacerMacroState): CompiledMacro {
  return s.orientCache[s.variantIdx][s.flipY][s.rot];
}

export function pairHaloFor(
  a: CompiledMacro,
  b: CompiledMacro,
  halo: number,
): number {
  const heavyBal =
    (a.kind === 'balancer-macro' && a.pins.length >= 4) ||
    (b.kind === 'balancer-macro' && b.pins.length >= 4);
  return heavyBal ? halo + 1 : halo;
}

function macroBbox(states: PlacerMacroState[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  w: number;
  h: number;
  area: number;
} {
  if (states.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0, w: 0, h: 0, area: 0 };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of states) {
    const m = getActiveMacro(s);
    if (s.x < minX) minX = s.x;
    if (s.y < minY) minY = s.y;
    if (s.x + m.width > maxX) maxX = s.x + m.width;
    if (s.y + m.height > maxY) maxY = s.y + m.height;
  }
  const w = maxX - minX;
  const h = maxY - minY;
  return { minX, minY, maxX, maxY, w, h, area: w * h };
}

function linkEndpoints(
  link: PlacerNetLink,
  states: PlacerMacroState[],
  pins: PerimeterPin[],
  bbox: { minX: number; minY: number; maxX: number; maxY: number },
  margin: number,
  isFixedDie: boolean,
): { sx: number; sy: number; dx: number; dy: number } {
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
    if (!isFixedDie && !p.locked) {
      sx =
        p.edge === 'W'
          ? bbox.minX - margin
          : p.edge === 'E'
            ? bbox.maxX + margin - 1
            : link.dstIdx >= 0
              ? dx
              : p.x;
      sy =
        p.edge === 'N'
          ? bbox.minY - margin
          : p.edge === 'S'
            ? bbox.maxY + margin - 1
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
    if (!isFixedDie && !p.locked) {
      dx =
        p.edge === 'W'
          ? bbox.minX - margin
          : p.edge === 'E'
            ? bbox.maxX + margin - 1
            : link.srcIdx >= 0
              ? sx
              : p.x;
      dy =
        p.edge === 'N'
          ? bbox.minY - margin
          : p.edge === 'S'
            ? bbox.maxY + margin - 1
            : link.srcIdx >= 0
              ? sy
              : p.y;
    } else {
      dx = p.x;
      dy = p.y;
    }
  }

  return { sx, sy, dx, dy };
}

function evalCompactScore(
  states: PlacerMacroState[],
  links: PlacerNetLink[],
  pins: PerimeterPin[],
  margin: number,
  isFixedDie: boolean,
  aspect: number,
): number {
  const bbox = macroBbox(states);
  let hpwl = 0;
  for (const link of links) {
    const { sx, sy, dx, dy } = linkEndpoints(link, states, pins, bbox, margin, isFixedDie);
    hpwl += Math.abs(sx - dx) + Math.abs(sy - dy);
    if (!link.isCrossBand && link.srcIdx >= 0 && link.dstIdx >= 0 && sx > dx) {
      hpwl += (sx - dx) * 3.5;
    }
  }
  if (isFixedDie) {
    return hpwl;
  }
  const curAspect = bbox.w / Math.max(1, bbox.h);
  const arWeight =
    aspect >= 1.1 && aspect <= 1.65
      ? Math.max(8, bbox.area * 0.015)
      : Math.max(35, bbox.area * 0.05);
  const aspectPen =
    Math.abs(Math.log(Math.max(0.1, curAspect / aspect))) * arWeight;
  return hpwl + (bbox.w + bbox.h) * 2.4 + bbox.area * 0.05 + aspectPen;
}

/**
 * Deterministic 2D macro & channel compaction pass:
 * 1) Pulls macros toward connected neighbor centroids and origin.
 * 2) Squeezes outer-edge macros inward to shrink bounding box area.
 * 3) Micro-snaps macro X/Y by +/-1..2 tiles to align connected pins straight-across.
 */
export function compactMacros2D(
  states: PlacerMacroState[],
  links: PlacerNetLink[],
  pins: PerimeterPin[],
  W: number,
  H: number,
  margin: number,
  halo: number,
  isFixedDie: boolean,
  aspect: number,
  dagEdges: Array<{ src: number; dst: number }> = [],
  allowFlipY = true,
  bandByMacro?: number[],
): void {
  if (states.length <= 1) return;

  const preds: number[][] = states.map(() => []);
  const succs: number[][] = states.map(() => []);
  for (const e of dagEdges) {
    preds[e.dst].push(e.src);
    succs[e.src].push(e.dst);
  }

  const hasHaloOverlap = (idx: number, nx: number, ny: number): boolean => {
    const mi = getActiveMacro(states[idx]);
    for (let j = 0; j < states.length; j++) {
      if (j === idx) continue;
      const sj = states[j];
      const mj = getActiveMacro(sj);
      let pairHalo = pairHaloFor(mi, mj, halo);
      if (bandByMacro && bandByMacro[idx] !== bandByMacro[j]) {
        pairHalo = Math.max(pairHalo, halo + 1);
      }
      if (
        rectOverlapArea(
          nx,
          ny,
          mi.width + pairHalo,
          mi.height + pairHalo,
          sj.x,
          sj.y,
          mj.width + pairHalo,
          mj.height + pairHalo,
        ) > 0
      ) {
        return true;
      }
    }
    return false;
  };

  const violatesDagFlow = (idx: number, nx: number): boolean => {
    const si = states[idx];
    if (si.rot !== 0) return false;
    const mi = getActiveMacro(si);
    for (const u of preds[idx]) {
      if (bandByMacro && bandByMacro[idx] !== bandByMacro[u]) continue;
      const su = states[u];
      if (su.locked || su.rot !== 0) continue;
      const mu = getActiveMacro(su);
      const gap = pairHaloFor(mi, mu, halo);
      if (nx < su.x + mu.width + gap) return true;
    }
    for (const v of succs[idx]) {
      if (bandByMacro && bandByMacro[idx] !== bandByMacro[v]) continue;
      const sv = states[v];
      if (sv.locked || sv.rot !== 0) continue;
      const mv = getActiveMacro(sv);
      const gap = pairHaloFor(mi, mv, halo);
      if (nx + mi.width + gap > sv.x) return true;
    }
    return false;
  };

  const isLegalPos = (idx: number, nx: number, ny: number): boolean => {
    const mi = getActiveMacro(states[idx]);
    if (nx < margin || ny < margin) return false;
    if (isFixedDie && (nx + mi.width > W - margin || ny + mi.height > H - margin)) {
      return false;
    }
    return !hasHaloOverlap(idx, nx, ny);
  };

  // Precompute per-macro links for neighbor centroid & pin alignment
  const macroLinks: PlacerNetLink[][] = states.map(() => []);
  for (const l of links) {
    if (l.srcIdx >= 0) macroLinks[l.srcIdx].push(l);
    if (l.dstIdx >= 0 && l.dstIdx !== l.srcIdx) macroLinks[l.dstIdx].push(l);
  }

  let curScore = evalCompactScore(states, links, pins, margin, isFixedDie, aspect);

  for (let pass = 0; pass < 3; pass++) {
    // Sweep A: pull unlocked macros along X and Y toward connected neighbors & origin
    const order = states
      .map((s, idx) => ({ idx, x: s.x, y: s.y }))
      .sort((a, b) => a.x - b.x || a.y - b.y)
      .map((o) => o.idx);

    for (const idx of order) {
      const s = states[idx];
      if (s.locked) continue;
      if (hasHaloOverlap(idx, s.x, s.y)) continue;
      const alreadyViolatesDag = violatesDagFlow(idx, s.x);

      const bbox = macroBbox(states);
      const m = getActiveMacro(s);

      // Compute connected neighbor pin centroid
      let sumTargetX = 0;
      let sumTargetY = 0;
      let count = 0;
      for (const l of macroLinks[idx]) {
        const ep = linkEndpoints(l, states, pins, bbox, margin, isFixedDie);
        if (l.srcIdx === idx) {
          sumTargetX += ep.dx - m.width / 2;
          sumTargetY += ep.dy - m.height / 2;
          count++;
        } else {
          sumTargetX += ep.sx - m.width / 2;
          sumTargetY += ep.sy - m.height / 2;
          count++;
        }
      }

      const xCands = new Set<number>();
      for (const d of [-16, -8, -4, -2, -1, 1, 2, 4, 8]) {
        xCands.add(s.x + d);
      }
      if (count > 0) {
        const idealX = Math.round(sumTargetX / count);
        xCands.add(idealX);
        xCands.add(Math.round((s.x + idealX) / 2));
      }
      // Pack snugly just past rightmost upstream predecessor (or origin margin if source)
      let predMaxRight = margin;
      for (const u of preds[idx]) {
        const su = states[u];
        const mu = getActiveMacro(su);
        predMaxRight = Math.max(predMaxRight, su.x + mu.width + pairHaloFor(m, mu, halo));
      }
      xCands.add(predMaxRight);
      xCands.add(bbox.minX);

      for (const nx of xCands) {
        if (nx === s.x || !isLegalPos(idx, nx, s.y)) continue;
        if (!alreadyViolatesDag && violatesDagFlow(idx, nx)) continue;
        const oldX = s.x;
        s.x = nx;
        const nextScore = evalCompactScore(states, links, pins, margin, isFixedDie, aspect);
        if (nextScore < curScore - 1e-4) {
          curScore = nextScore;
        } else {
          s.x = oldX;
        }
      }

      const yCands = new Set<number>();
      for (const d of [-16, -8, -4, -2, -1, 1, 2, 4, 8]) {
        yCands.add(s.y + d);
      }
      if (count > 0) {
        const idealY = Math.round(sumTargetY / count);
        yCands.add(idealY);
        yCands.add(Math.round((s.y + idealY) / 2));
      }
      yCands.add(bbox.minY);

      for (const ny of yCands) {
        if (ny === s.y || !isLegalPos(idx, s.x, ny)) continue;
        const oldY = s.y;
        s.y = ny;
        const nextScore = evalCompactScore(states, links, pins, margin, isFixedDie, aspect);
        if (nextScore < curScore - 1e-4) {
          curScore = nextScore;
        } else {
          s.y = oldY;
        }
      }
    }

    // Sweep B: Micro-align connected macro pin tracks (eliminates 1-2 tile belt jogs)
    for (const idx of order) {
      const s = states[idx];
      if (s.locked || hasHaloOverlap(idx, s.x, s.y)) continue;
      const bbox = macroBbox(states);

      for (const l of macroLinks[idx]) {
        if (l.srcIdx < 0 || l.dstIdx < 0) continue;
        const ep = linkEndpoints(l, states, pins, bbox, margin, isFixedDie);
        const dy = l.srcIdx === idx ? ep.dy - ep.sy : ep.sy - ep.dy;
        if (Math.abs(dy) >= 1 && Math.abs(dy) <= 4) {
          const ny = s.y + dy;
          if (isLegalPos(idx, s.x, ny)) {
            const oldY = s.y;
            s.y = ny;
            const nextScore = evalCompactScore(states, links, pins, margin, isFixedDie, aspect);
            if (nextScore <= curScore + 0.5) {
              curScore = nextScore;
            } else {
              s.y = oldY;
            }
          }
        }
      }
    }

    // Sweep C: Local FlipY & Variant (1-row <-> 2-row) polish
    for (const idx of order) {
      const s = states[idx];
      if (s.locked) continue;

      if (allowFlipY && !s.flipLocked && s.rot === 0) {
        const oldFlip = s.flipY;
        s.flipY = oldFlip ? 0 : 1;
        const nextScore = evalCompactScore(states, links, pins, margin, isFixedDie, aspect);
        if (nextScore < curScore - 1e-4) {
          curScore = nextScore;
        } else {
          s.flipY = oldFlip;
        }
      }

      if (!s.rowsLocked && s.variants.length > 1) {
        const oldVar = s.variantIdx;
        let bestVar = oldVar;
        const alreadyViolatesDag = violatesDagFlow(idx, s.x);
        for (let v = 0; v < s.variants.length; v++) {
          if (v === oldVar) continue;
          s.variantIdx = v;
          if (
            !isLegalPos(idx, s.x, s.y) ||
            (!alreadyViolatesDag && violatesDagFlow(idx, s.x))
          ) {
            continue;
          }
          const nextScore = evalCompactScore(states, links, pins, margin, isFixedDie, aspect);
          if (nextScore < curScore - 1e-4) {
            curScore = nextScore;
            bestVar = v;
          }
        }
        s.variantIdx = bestVar;
      }
    }
  }
}
