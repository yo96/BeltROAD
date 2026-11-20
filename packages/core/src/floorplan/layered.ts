import {
  CompiledMacro,
  PerimeterPin,
  SynthesisResult,
} from '../types.js';
import {
  PlacerMacroState,
  getActiveMacro,
  pairHaloFor,
  rectOverlapArea,
} from './compact.js';

export interface LayeredPlacementResult {
  fitsFixed: boolean;
  dagEdges: Array<{ src: number; dst: number }>;
  bandByMacro: number[];
}

/**
 * Deterministic Sugiyama-ordered layered column floorplanner with
 * recipe-family area/aspect variant selection and 2-band folding for
 * deep pipelines.
 */
export function buildLayeredPlacement(
  states: PlacerMacroState[],
  synth: SynthesisResult,
  macroIndexById: Map<string, number>,
  pins: PerimeterPin[],
  margin: number,
  halo: number,
  isFixed: boolean,
  fixedW: number,
  fixedH: number,
  aspect: number,
  allowFlipY: boolean,
  compactMacros: boolean,
): LayeredPlacementResult {
  const n = states.length;
  const dagEdges: Array<{ src: number; dst: number }> = [];
  const bandByMacro = new Array<number>(n).fill(0);
  if (n === 0) return { fitsFixed: true, dagEdges, bandByMacro };

  const pinById = new Map(pins.map((p) => [p.id, p]));
  const preds: number[][] = Array.from({ length: n }, () => []);
  const succs: number[][] = Array.from({ length: n }, () => []);
  const seenEdge = new Set<string>();
  const hasPrimaryIn = new Uint8Array(n);
  const hasPrimaryOut = new Uint8Array(n);
  const totalFanIn = new Int32Array(n);
  const totalFanOut = new Int32Array(n);

  const inPinsByMacro: PerimeterPin[][] = Array.from({ length: n }, () => []);
  const outPinsByMacro: PerimeterPin[][] = Array.from({ length: n }, () => []);

  for (const net of synth.nets) {
    const u = net.source.nodeId.startsWith('in:')
      ? -1
      : (macroIndexById.get(net.source.nodeId) ?? -1);
    const v = net.sink.nodeId.startsWith('out:')
      ? -1
      : (macroIndexById.get(net.sink.nodeId) ?? -1);

    if (u >= 0) totalFanOut[u]++;
    if (v >= 0) totalFanIn[v]++;

    if (net.source.nodeId.startsWith('in:') && v >= 0) {
      hasPrimaryIn[v] = 1;
      const p = pinById.get(net.source.nodeId);
      if (p) inPinsByMacro[v].push(p);
    }
    if (net.sink.nodeId.startsWith('out:') && u >= 0) {
      hasPrimaryOut[u] = 1;
      const p = pinById.get(net.sink.nodeId);
      if (p) outPinsByMacro[u].push(p);
    }

    if (u >= 0 && v >= 0 && u !== v) {
      const key = `${u}->${v}`;
      if (!seenEdge.has(key)) {
        seenEdge.add(key);
        preds[v].push(u);
        succs[u].push(v);
        dagEdges.push({ src: u, dst: v });
      }
    }
  }

  // 1. Initialize clean rot=0 orientation & flipY=0 for unlocked macros
  for (let i = 0; i < n; i++) {
    const s = states[i];
    if (s.locked) continue;
    if (!s.rotLocked) s.rot = 0;
    if (!s.flipLocked) s.flipY = 0;
  }

  // 2. Topological ASAP stage assignment
  const inDeg = new Int32Array(n);
  for (const e of dagEdges) inDeg[e.dst]++;

  const q: number[] = [];
  const asap = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    if (inDeg[i] === 0) q.push(i);
  }
  const topoOrder: number[] = [];
  while (q.length > 0) {
    const u = q.shift()!;
    topoOrder.push(u);
    for (const v of succs[u]) {
      asap[v] = Math.max(asap[v], asap[u] + 1);
      if (--inDeg[v] === 0) q.push(v);
    }
  }
  for (let i = 0; i < n; i++) {
    if (!topoOrder.includes(i)) topoOrder.push(i);
  }

  let maxStage = 0;
  for (let i = 0; i < n; i++) {
    if (asap[i] > maxStage) maxStage = asap[i];
  }

  const stage = new Int32Array(asap);
  for (let i = 0; i < n; i++) {
    // Sink macros with primary outputs align to the rightmost column
    if (succs[i].length === 0 && hasPrimaryOut[i]) {
      stage[i] = maxStage;
    }
  }

  // 2b. Recipe-family uniform 1-row vs 2-row variant selection minimizing area + aspect mismatch
  const familyGroups = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const s = states[i];
    if (s.locked || s.rowsLocked || s.variants.length <= 1) continue;
    const base = s.variants[0];
    if (base.kind !== 'recipe-macro') continue;
    const key = base.recipeId ?? s.id;
    let grp = familyGroups.get(key);
    if (!grp) {
      grp = [];
      familyGroups.set(key, grp);
    }
    grp.push(i);
  }

  // Seed initial variants cleanly (1-row by default, or 2-row if compactMacros and very wide)
  for (const grp of familyGroups.values()) {
    for (const i of grp) {
      const s = states[i];
      const oneIdx = s.variants.findIndex((v) => v.rows === 1);
      const twoIdx = s.variants.findIndex((v) => v.rows === 2);
      if (compactMacros && twoIdx >= 0 && oneIdx >= 0 && s.variants[oneIdx].width >= 20) {
        s.variantIdx = twoIdx;
      } else if (oneIdx >= 0) {
        s.variantIdx = oneIdx;
      }
    }
  }

  const estimateGridScore = (): number => {
    const colMaxW = new Int32Array(maxStage + 1);
    const colSumH = new Int32Array(maxStage + 1);
    const colCnt = new Int32Array(maxStage + 1);
    for (let i = 0; i < n; i++) {
      const sIdx = stage[i];
      const m = getActiveMacro(states[i]);
      colMaxW[sIdx] = Math.max(colMaxW[sIdx], m.width);
      colSumH[sIdx] += (colCnt[sIdx] > 0 ? halo : 0) + m.height;
      colCnt[sIdx]++;
    }
    let activeCols = 0;
    let sumW = 0;
    let maxH = 12;
    for (let sIdx = 0; sIdx <= maxStage; sIdx++) {
      if (colCnt[sIdx] === 0) continue;
      activeCols++;
      sumW += colMaxW[sIdx];
      maxH = Math.max(maxH, colSumH[sIdx]);
    }
    const estW = 2 * margin + sumW + Math.max(0, activeCols - 1) * halo;
    const estH = 2 * margin + maxH;
    return estW * estH + Math.abs(estW / Math.max(1, estH) - aspect) * 450;
  };

  if (compactMacros && familyGroups.size > 0) {
    for (let pass = 0; pass < 2; pass++) {
      for (const grp of familyGroups.values()) {
        const oneOption = grp.map((i) => ({
          i,
          oldVar: states[i].variantIdx,
          oneIdx: states[i].variants.findIndex((v) => v.rows === 1),
          twoIdx: states[i].variants.findIndex((v) => v.rows === 2),
        }));
        if (oneOption.some((o) => o.oneIdx < 0 || o.twoIdx < 0)) continue;

        for (const o of oneOption) states[o.i].variantIdx = o.oneIdx;
        const scoreOne = estimateGridScore();

        for (const o of oneOption) states[o.i].variantIdx = o.twoIdx;
        const scoreTwo = estimateGridScore();

        if (scoreOne <= scoreTwo) {
          for (const o of oneOption) states[o.i].variantIdx = o.oneIdx;
        }
      }
    }
  }

  // 2c. Strict no-height-inflation push-forward for multi-output balancers/taps
  const colH = new Int32Array(maxStage + 1);
  const colCnt = new Int32Array(maxStage + 1);
  for (let i = 0; i < n; i++) {
    const m = getActiveMacro(states[i]);
    colH[stage[i]] += (colCnt[stage[i]] > 0 ? halo : 0) + m.height;
    colCnt[stage[i]]++;
  }
  const maxColH = Math.max(16, ...colH);

  for (let k = topoOrder.length - 1; k >= 0; k--) {
    const i = topoOrder[k];
    const m = getActiveMacro(states[i]);
    if (
      m.kind === 'balancer-macro' &&
      totalFanOut[i] > totalFanIn[i] &&
      succs[i].length > 0
    ) {
      let minSuccStage = maxStage;
      for (const v of succs[i]) {
        minSuccStage = Math.min(minSuccStage, stage[v]);
      }
      const targetStage = minSuccStage - 1;
      const addedH = (colCnt[targetStage] > 0 ? halo : 0) + m.height;
      if (targetStage > stage[i] && colH[targetStage] + addedH <= maxColH) {
        const oldStage = stage[i];
        colCnt[oldStage]--;
        colH[oldStage] = Math.max(0, colH[oldStage] - m.height - (colCnt[oldStage] > 0 ? halo : 0));
        stage[i] = targetStage;
        colH[targetStage] += addedH;
        colCnt[targetStage]++;
      }
    }
  }

  // Re-compact any completely empty intermediate columns
  const nonEmptyStages = Array.from(new Set(Array.from(stage))).sort((a, b) => a - b);
  const compactStageMap = new Map<number, number>();
  nonEmptyStages.forEach((s, idx) => compactStageMap.set(s, idx));
  for (let i = 0; i < n; i++) {
    stage[i] = compactStageMap.get(stage[i]) ?? 0;
  }
  const numCols = Math.max(1, nonEmptyStages.length);

  // 3. Sugiyama barycenter vertical ordering per column
  const columns: number[][] = Array.from({ length: numCols }, () => []);
  for (let i = 0; i < n; i++) {
    columns[stage[i]].push(i);
  }

  const seedKey = (i: number): number => {
    const pinsFor = inPinsByMacro[i].length > 0 ? inPinsByMacro[i] : outPinsByMacro[i];
    if (pinsFor.length > 0) {
      const p = pinsFor[0];
      if (p.edge === 'N') return -100000 + (p.locked ? p.offset : p.order);
      if (p.edge === 'S') return 100000 + (p.locked ? p.offset : p.order);
      return p.locked ? p.offset : p.order;
    }
    return 0;
  };
  for (const col of columns) {
    col.sort((a, b) => seedKey(a) - seedKey(b) || states[a].id.localeCompare(states[b].id));
  }

  const normRank = new Float64Array(n);
  const updateNormRanks = () => {
    for (let s = 0; s < numCols; s++) {
      const col = columns[s];
      for (let pos = 0; pos < col.length; pos++) {
        normRank[col[pos]] = (pos + 0.5) / Math.max(1, col.length);
      }
    }
  };
  updateNormRanks();

  const barycenterOf = (idx: number): number => {
    let sum = 0;
    let w = 0;
    for (const u of preds[idx]) {
      sum += normRank[u];
      w += 1;
    }
    for (const v of succs[idx]) {
      sum += normRank[v];
      w += 1;
    }
    for (const p of inPinsByMacro[idx]) {
      if (p.edge === 'N') {
        sum += -0.4;
        w += 0.8;
      } else if (p.edge === 'S') {
        sum += 1.4;
        w += 0.8;
      } else if (p.locked) {
        sum += p.offset / Math.max(20, maxColH);
        w += 1.0;
      } else {
        sum += normRank[idx];
        w += 0.3;
      }
    }
    for (const p of outPinsByMacro[idx]) {
      if (p.edge === 'N') {
        sum += -0.4;
        w += 0.8;
      } else if (p.edge === 'S') {
        sum += 1.4;
        w += 0.8;
      } else if (p.locked) {
        sum += p.offset / Math.max(20, maxColH);
        w += 1.0;
      }
    }
    return w > 0 ? sum / w : normRank[idx];
  };

  for (let sweep = 0; sweep < 5; sweep++) {
    for (let s = 1; s < numCols; s++) {
      columns[s].sort((a, b) => barycenterOf(a) - barycenterOf(b));
      updateNormRanks();
    }
    for (let s = numCols - 2; s >= 0; s--) {
      columns[s].sort((a, b) => barycenterOf(a) - barycenterOf(b));
      updateNormRanks();
    }
  }

  // 4. Column widths, West bypass gutter, and inter-column channel gaps (counting W/E bypass nets)
  const unlockedColIndices = columns.map((col) => col.filter((i) => !states[i].locked));
  const colWidths = unlockedColIndices.map((col) =>
    col.reduce((mw, i) => Math.max(mw, getActiveMacro(states[i]).width), 0),
  );

  let wBypassPins = 0;
  for (const net of synth.nets) {
    if (!net.source.nodeId.startsWith('in:')) continue;
    const p = pinById.get(net.source.nodeId);
    const v = macroIndexById.get(net.sink.nodeId);
    if (p?.edge === 'W' && v !== undefined && stage[v] >= 1) {
      wBypassPins++;
    }
  }
  const westStartX =
    !isFixed && wBypassPins >= 3 ? Math.max(margin, 4) : margin;

  const colGap: number[] = [];
  for (let s = 0; s < numCols - 1; s++) {
    if (colWidths[s] === 0) {
      colGap.push(0);
      continue;
    }
    let crossNets = 0;
    for (const net of synth.nets) {
      const uIdx = macroIndexById.get(net.source.nodeId);
      const vIdx = macroIndexById.get(net.sink.nodeId);
      let us = uIdx !== undefined ? stage[uIdx] : undefined;
      let vs = vIdx !== undefined ? stage[vIdx] : undefined;
      if (us === undefined && net.source.nodeId.startsWith('in:')) {
        const p = pinById.get(net.source.nodeId);
        if (p?.edge === 'W') us = -1;
        else if (p?.edge === 'E') us = numCols;
      }
      if (vs === undefined && net.sink.nodeId.startsWith('out:')) {
        const p = pinById.get(net.sink.nodeId);
        if (p?.edge === 'E') vs = numCols;
        else if (p?.edge === 'W') vs = -1;
      }
      if (us !== undefined && vs !== undefined && us <= s && vs >= s + 1) {
        crossNets++;
      }
    }
    const heavyBal = [...columns[s], ...columns[s + 1]].some((idx) => {
      const m = getActiveMacro(states[idx]);
      return m.kind === 'balancer-macro' && m.pins.length >= 4;
    });
    const gap = Math.max(
      halo + (heavyBal ? 1 : 0),
      Math.min(5, halo + Math.floor(crossNets / 4)),
    );
    colGap.push(gap);
  }

  const colX = new Int32Array(numCols);
  let curX = westStartX;
  for (let s = 0; s < numCols; s++) {
    colX[s] = curX;
    if (colWidths[s] > 0) {
      curX += colWidths[s] + (s < numCols - 1 ? colGap[s] : 0);
    }
  }

  const actualColH = new Int32Array(numCols);
  for (let s = 0; s < numCols; s++) {
    const col = unlockedColIndices[s];
    let hSum = 0;
    for (let pos = 0; pos < col.length; pos++) {
      const curM = getActiveMacro(states[col[pos]]);
      hSum += curM.height;
      if (pos > 0) {
        const prevM = getActiveMacro(states[col[pos - 1]]);
        hSum += pairHaloFor(prevM, curM, halo);
      }
    }
    actualColH[s] = hSum;
  }
  const tallestH = Math.max(12, ...actualColH);

  // 5. General 2-band aspect-constrained column folding for deep wide pipelines
  const rawW = curX + margin;
  const rawH = tallestH + 2 * margin;
  const shouldFold =
    !isFixed &&
    states.every((s) => !s.locked) &&
    numCols >= 5 &&
    rawW / Math.max(1, rawH) > Math.max(2.6, aspect * 1.85);

  let splitCol = numCols;
  let band0H = tallestH;
  let band1H = 0;
  let bandGap = 0;

  if (shouldFold) {
    const rangeWidth = (fromCol: number, toCol: number): number => {
      let w = 0;
      for (let s = fromCol; s < toCol; s++) {
        w += colWidths[s];
        if (s + 1 < toCol && colWidths[s] > 0) w += colGap[s];
      }
      return w;
    };

    let bestScore = Infinity;
    for (let sc = 2; sc <= numCols - 2; sc++) {
      const w0 = rangeWidth(0, sc);
      const w1 = rangeWidth(sc, numCols);
      const score = Math.max(w0, w1) + Math.abs(w0 - w1) * 0.5 + (w0 > w1 + 8 ? 15 : 0);
      if (score < bestScore) {
        bestScore = score;
        splitCol = sc;
      }
    }

    band0H = 10;
    for (let s = 0; s < splitCol; s++) band0H = Math.max(band0H, actualColH[s]);
    band1H = 10;
    for (let s = splitCol; s < numCols; s++) band1H = Math.max(band1H, actualColH[s]);
    bandGap = Math.max(halo + 1, 3);

    // Recompute X starting at westStartX for each band independently
    let bx0 = westStartX;
    for (let s = 0; s < splitCol; s++) {
      colX[s] = bx0;
      if (colWidths[s] > 0) {
        bx0 += colWidths[s] + (s + 1 < splitCol ? colGap[s] : 0);
      }
    }
    let bx1 = westStartX;
    for (let s = splitCol; s < numCols; s++) {
      colX[s] = bx1;
      if (colWidths[s] > 0) {
        bx1 += colWidths[s] + (s + 1 < numCols ? colGap[s] : 0);
      }
    }
    curX = Math.max(bx0, bx1);
  }

  // Initial Y stacking centered within each column's band
  for (let s = 0; s < numCols; s++) {
    const band = shouldFold && s >= splitCol ? 1 : 0;
    const bandMinY = band === 0 ? margin : margin + band0H + bandGap;
    const bandHeight = band === 0 ? band0H : band1H;
    const col = unlockedColIndices[s];
    let cy = bandMinY + Math.floor((bandHeight - actualColH[s]) / 2);
    for (let pos = 0; pos < col.length; pos++) {
      const idx = col[pos];
      const m = getActiveMacro(states[idx]);
      if (pos > 0) {
        const prevM = getActiveMacro(states[col[pos - 1]]);
        cy += pairHaloFor(prevM, m, halo);
      }
      states[idx].x = colX[s];
      states[idx].y = cy;
      bandByMacro[idx] = band;
      cy += m.height;
    }
  }

  // Build per-macro incident nets for port-level Y alignment and flipY evaluation
  interface IncidentNet {
    otherMacroIdx: number;
    otherPinId: string;
    otherPin?: PerimeterPin;
    myPinId: string;
  }
  const incidentByMacro: IncidentNet[][] = Array.from({ length: n }, () => []);
  for (const net of synth.nets) {
    const u = macroIndexById.get(net.source.nodeId);
    const v = macroIndexById.get(net.sink.nodeId);
    if (u !== undefined && v !== undefined) {
      incidentByMacro[u].push({
        otherMacroIdx: v,
        otherPinId: net.sink.pinId,
        myPinId: net.source.pinId,
      });
      incidentByMacro[v].push({
        otherMacroIdx: u,
        otherPinId: net.source.pinId,
        myPinId: net.sink.pinId,
      });
    } else if (u !== undefined && net.sink.nodeId.startsWith('out:')) {
      const p = pinById.get(net.sink.nodeId);
      if (p) {
        incidentByMacro[u].push({
          otherMacroIdx: -1,
          otherPinId: '',
          otherPin: p,
          myPinId: net.source.pinId,
        });
      }
    } else if (v !== undefined && net.source.nodeId.startsWith('in:')) {
      const p = pinById.get(net.source.nodeId);
      if (p) {
        incidentByMacro[v].push({
          otherMacroIdx: -1,
          otherPinId: '',
          otherPin: p,
          myPinId: net.sink.pinId,
        });
      }
    }
  }

  const getPortWorld = (macroIdx: number, pinId: string): { x: number; y: number } => {
    const st = states[macroIdx];
    const m = getActiveMacro(st);
    const p = m.pins.find((mp) => mp.id === pinId) ?? m.pins[0];
    return {
      x: st.x + (p ? p.portX : 0),
      y: st.y + (p ? p.portY : Math.floor(m.height / 2)),
    };
  };

  const totalDieBottom = margin + band0H + bandGap + band1H;

  // 6. Port-level vertical alignment within each column (respecting band boundaries)
  for (let pass = 0; pass < 2; pass++) {
    const colSeq =
      pass % 2 === 0
        ? Array.from({ length: numCols }, (_, i) => i)
        : Array.from({ length: numCols }, (_, i) => numCols - 1 - i);
    for (const s of colSeq) {
      const band = shouldFold && s >= splitCol ? 1 : 0;
      const bandTop = band === 0 ? margin : margin + band0H + bandGap;
      const bandBottom = band === 0 ? margin + band0H : totalDieBottom;
      const col = unlockedColIndices[s];

      for (let pos = 0; pos < col.length; pos++) {
        const idx = col[pos];
        const m = getActiveMacro(states[idx]);
        const dys: number[] = [];

        for (const inc of incidentByMacro[idx]) {
          const myPort = getPortWorld(idx, inc.myPinId);
          if (inc.otherMacroIdx >= 0) {
            if (bandByMacro[inc.otherMacroIdx] !== band) continue;
            const otherPort = getPortWorld(inc.otherMacroIdx, inc.otherPinId);
            dys.push(otherPort.y - myPort.y);
          } else if (inc.otherPin) {
            const p = inc.otherPin;
            if (p.edge === 'N') dys.push(margin - 1 - myPort.y);
            else if (p.edge === 'S') dys.push(totalDieBottom + 1 - myPort.y);
            else if (p.locked || isFixed) dys.push(p.y - myPort.y);
          }
        }
        if (dys.length === 0) continue;
        dys.sort((a, b) => a - b);
        const mid = Math.floor(dys.length / 2);
        const medianDy =
          dys.length % 2 === 1 ? dys[mid] : Math.round((dys[mid - 1] + dys[mid]) / 2);

        const prevIdx = pos > 0 ? col[pos - 1] : -1;
        const nextIdx = pos + 1 < col.length ? col[pos + 1] : -1;
        const minY =
          prevIdx >= 0
            ? states[prevIdx].y +
              getActiveMacro(states[prevIdx]).height +
              pairHaloFor(getActiveMacro(states[prevIdx]), m, halo)
            : bandTop;
        const maxY =
          nextIdx >= 0
            ? states[nextIdx].y -
              m.height -
              pairHaloFor(m, getActiveMacro(states[nextIdx]), halo)
            : Math.max(minY, bandBottom - m.height);

        const candY = Math.max(minY, Math.min(maxY, states[idx].y + medianDy));
        states[idx].y = candY;
      }
    }
  }

  // 7. Greedy Y-mirroring (opt_flip) across all incident nets (including cross-band nets!)
  if (allowFlipY) {
    const scoreFlip = (idx: number): number => {
      let dist = 0;
      for (const inc of incidentByMacro[idx]) {
        const myPort = getPortWorld(idx, inc.myPinId);
        if (inc.otherMacroIdx >= 0) {
          const otherPort = getPortWorld(inc.otherMacroIdx, inc.otherPinId);
          dist += Math.abs(myPort.x - otherPort.x) + Math.abs(myPort.y - otherPort.y);
        } else if (inc.otherPin) {
          const p = inc.otherPin;
          const targetY =
            p.edge === 'N'
              ? margin - 1
              : p.edge === 'S'
                ? totalDieBottom + 1
                : p.locked || isFixed
                  ? p.y
                  : myPort.y;
          dist += Math.abs(myPort.y - targetY);
        }
      }
      return dist;
    };

    for (let pass = 0; pass < 2; pass++) {
      for (let idx = 0; idx < n; idx++) {
        const st = states[idx];
        if (st.locked || st.flipLocked || st.rot !== 0) continue;
        const curFlip = st.flipY;
        const curDist = scoreFlip(idx);
        st.flipY = curFlip === 0 ? 1 : 0;
        const altDist = scoreFlip(idx);
        if (altDist >= curDist) {
          st.flipY = curFlip;
        }
      }
    }
  }

  // 8. Protect locked macros: relocate any overlapping unlocked macro cleanly
  const lockedStates = states.filter((s) => s.locked);
  if (lockedStates.length > 0) {
    const placed: PlacerMacroState[] = [...lockedStates];
    const unlocked = states.filter((s) => !s.locked);

    const overlapsAny = (cand: PlacerMacroState, m: CompiledMacro): boolean => {
      for (const p of placed) {
        const mp = getActiveMacro(p);
        const gap = pairHaloFor(m, mp, halo);
        if (
          rectOverlapArea(
            cand.x,
            cand.y,
            m.width + gap,
            m.height + gap,
            p.x,
            p.y,
            mp.width + gap,
            mp.height + gap,
          ) > 0
        ) {
          return true;
        }
      }
      return false;
    };

    for (const s of unlocked) {
      const m = getActiveMacro(s);
      if (!overlapsAny(s, m)) {
        placed.push(s);
        continue;
      }
      const searchW = isFixed ? fixedW : Math.max(60, curX + m.width + 20);
      const searchH = isFixed ? fixedH : Math.max(48, totalDieBottom + m.height + 20);
      let bestX = s.x;
      let bestY = s.y;
      let bestScore = Infinity;
      for (let cy = margin; cy <= Math.max(margin, searchH - margin - m.height); cy += 1) {
        for (let cx = margin; cx <= Math.max(margin, searchW - margin - m.width); cx += 1) {
          const cand = { ...s, x: cx, y: cy };
          if (overlapsAny(cand, m)) continue;
          const dist = Math.abs(cx - s.x) + Math.abs(cy - s.y);
          if (dist < bestScore) {
            bestScore = dist;
            bestX = cx;
            bestY = cy;
          }
        }
      }
      s.x = bestX;
      s.y = bestY;
      placed.push(s);
    }
  }

  const intraBandEdges = dagEdges.filter((e) => bandByMacro[e.src] === bandByMacro[e.dst]);

  // Check fixed-die feasibility
  if (!isFixed) {
    return { fitsFixed: true, dagEdges: intraBandEdges, bandByMacro };
  }

  let fitsFixed = true;
  for (let i = 0; i < n; i++) {
    const si = states[i];
    const mi = getActiveMacro(si);
    if (
      si.x < margin ||
      si.y < margin ||
      si.x + mi.width > fixedW - margin ||
      si.y + mi.height > fixedH - margin
    ) {
      fitsFixed = false;
      break;
    }
    for (let j = i + 1; j < n; j++) {
      const sj = states[j];
      const mj = getActiveMacro(sj);
      const gap = pairHaloFor(mi, mj, halo);
      if (
        rectOverlapArea(
          si.x,
          si.y,
          mi.width + gap,
          mi.height + gap,
          sj.x,
          sj.y,
          mj.width + gap,
          mj.height + gap,
        ) > 0
      ) {
        fitsFixed = false;
        break;
      }
    }
    if (!fitsFixed) break;
  }

  return { fitsFixed, dagEdges: intraBandEdges, bandByMacro };
}
