import {
  PerimeterPin,
  PlacedMacro,
  SynthesisResult,
  SynthNet,
} from '../types.js';

interface PortSlot {
  pinId: string;
  x: number;
  y: number;
  faceCoord: number;
}

interface TargetSlot {
  x: number;
  y: number;
  peerCoord: number;
}

/**
 * Finds permutation `assign[portIdx] = targetIdx` minimizing
 * wirelength + crossing count. Uses exact backtracking for k <= 7,
 * and sorted order matching for larger k.
 */
function solveMinCostAssignment(
  ports: PortSlot[],
  targets: TargetSlot[],
): number[] {
  const k = ports.length;
  if (k <= 1) return ports.map((_, i) => i);

  if (k > 7) {
    const pOrder = ports
      .map((p, i) => ({ i, c: p.faceCoord }))
      .sort((a, b) => a.c - b.c || a.i - b.i);
    const tOrder = targets
      .map((t, j) => ({ j, c: t.peerCoord }))
      .sort((a, b) => a.c - b.c || a.j - b.j);
    const assign = new Array<number>(k).fill(0);
    for (let idx = 0; idx < k; idx++) {
      assign[pOrder[idx].i] = tOrder[idx].j;
    }
    return assign;
  }

  // Precompute pairwise Manhattan distances
  const dist: number[][] = Array.from({ length: k }, (_, i) =>
    Array.from({ length: k }, (_, j) =>
      Math.abs(ports[i].x - targets[j].x) + Math.abs(ports[i].y - targets[j].y),
    ),
  );

  // Canonical port order sorted by faceCoord so inversion counting is linear in prefix
  const portOrder = ports
    .map((p, i) => ({ i, c: p.faceCoord }))
    .sort((a, b) => a.c - b.c || a.i - b.i)
    .map((o) => o.i);

  let bestCost = Infinity;
  const bestAssign = new Array<number>(k).fill(0);
  const curAssign = new Array<number>(k).fill(0);
  const used = new Uint8Array(k);

  function dfs(step: number, wlCost: number, crossCount: number): void {
    const curCost = wlCost + crossCount * 12;
    if (curCost >= bestCost) return;

    if (step === k) {
      bestCost = curCost;
      for (let i = 0; i < k; i++) bestAssign[i] = curAssign[i];
      return;
    }

    const pi = portOrder[step];
    const pCoord = ports[pi].faceCoord;

    for (let tj = 0; tj < k; tj++) {
      if (used[tj]) continue;
      let addedCross = 0;
      const tCoord = targets[tj].peerCoord;
      for (let prev = 0; prev < step; prev++) {
        const pPrev = portOrder[prev];
        const tPrev = curAssign[pPrev];
        if (
          (ports[pPrev].faceCoord - pCoord) * (targets[tPrev].peerCoord - tCoord) <
          0
        ) {
          addedCross++;
        }
      }

      used[tj] = 1;
      curAssign[pi] = tj;
      dfs(step + 1, wlCost + dist[pi][tj], crossCount + addedCross);
      used[tj] = 0;
    }
  }

  dfs(0, 0, 0);
  return bestAssign;
}

function getEndpointCoord(
  nodeId: string,
  pinId: string,
  macroById: Map<string, PlacedMacro>,
  pinById: Map<string, PerimeterPin>,
): { x: number; y: number } {
  if (nodeId.startsWith('in:') || nodeId.startsWith('out:')) {
    const p = pinById.get(nodeId);
    if (p) return { x: p.x, y: p.y };
  }
  const pm = macroById.get(nodeId);
  if (pm) {
    const mp = pm.macro.pins.find((p) => p.id === pinId) ?? pm.macro.pins[0];
    if (mp) {
      return { x: pm.x + mp.portX, y: pm.y + mp.portY };
    }
    return { x: pm.x, y: pm.y };
  }
  return { x: 0, y: 0 };
}

function chooseAxis(coords: { x: number; y: number }[]): 'x' | 'y' {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const c of coords) {
    if (c.x < minX) minX = c.x;
    if (c.x > maxX) maxX = c.x;
    if (c.y < minY) minY = c.y;
    if (c.y > maxY) maxY = c.y;
  }
  return maxY - minY >= maxX - minX ? 'y' : 'x';
}

/**
 * Uncrosses interchangeable balancer I/O ports and identical parallel macro slices
 * via minimum-cost bipartite matching with wire-crossing penalty.
 */
export function optimizePortAssignments(
  synth: SynthesisResult,
  macros: PlacedMacro[],
  pins: PerimeterPin[],
): void {
  const macroById = new Map(macros.map((m) => [m.id, m]));
  const pinById = new Map(pins.map((p) => [p.id, p]));

  // Pass 1 & Pass 2: Balancer output & input ports
  for (const pm of macros) {
    if (pm.macro.kind !== 'balancer-macro') continue;

    // Outputs
    const outNets = synth.nets.filter((n) => n.source.nodeId === pm.id);
    const outPins = pm.macro.pins.filter((p) => p.kind === 'output');
    if (outNets.length >= 2 && outNets.length === outPins.length) {
      const pinCoords = outPins.map((p) => ({
        pinId: p.id,
        x: pm.x + p.portX,
        y: pm.y + p.portY,
      }));
      const axis = chooseAxis(pinCoords);
      const ports: PortSlot[] = pinCoords.map((p) => ({
        ...p,
        faceCoord: axis === 'y' ? p.y : p.x,
      }));
      const targets: TargetSlot[] = outNets.map((n) => {
        const c = getEndpointCoord(n.sink.nodeId, n.sink.pinId, macroById, pinById);
        return { x: c.x, y: c.y, peerCoord: axis === 'y' ? c.y : c.x };
      });
      const assign = solveMinCostAssignment(ports, targets);
      for (let i = 0; i < outPins.length; i++) {
        outNets[assign[i]].source.pinId = outPins[i].id;
      }
    }

    // Inputs
    const inNets = synth.nets.filter((n) => n.sink.nodeId === pm.id);
    const inPins = pm.macro.pins.filter((p) => p.kind === 'input');
    if (inNets.length >= 2 && inNets.length === inPins.length) {
      const pinCoords = inPins.map((p) => ({
        pinId: p.id,
        x: pm.x + p.portX,
        y: pm.y + p.portY,
      }));
      const axis = chooseAxis(pinCoords);
      const ports: PortSlot[] = pinCoords.map((p) => ({
        ...p,
        faceCoord: axis === 'y' ? p.y : p.x,
      }));
      const targets: TargetSlot[] = inNets.map((n) => {
        const c = getEndpointCoord(n.source.nodeId, n.source.pinId, macroById, pinById);
        return { x: c.x, y: c.y, peerCoord: axis === 'y' ? c.y : c.x };
      });
      const assign = solveMinCostAssignment(ports, targets);
      for (let i = 0; i < inPins.length; i++) {
        inNets[assign[i]].sink.pinId = inPins[i].id;
      }
    }
  }

  // Pass 3: Identical parallel macro slices (direct connections between homogeneous groups)
  const familyOf = (nodeId: string): string => {
    if (nodeId.startsWith('in:')) return `in:${nodeId.split(':')[1] ?? ''}`;
    if (nodeId.startsWith('out:')) return `out:${nodeId.split(':')[1] ?? ''}`;
    const pm = macroById.get(nodeId);
    if (!pm || pm.macro.kind === 'balancer-macro') return `unique:${nodeId}`;
    return `macro:${pm.macro.recipeId ?? nodeId}`;
  };

  const groups = new Map<string, SynthNet[]>();
  for (const net of synth.nets) {
    const srcM = macroById.get(net.source.nodeId);
    const dstM = macroById.get(net.sink.nodeId);
    if (srcM?.macro.kind === 'balancer-macro' || dstM?.macro.kind === 'balancer-macro') {
      continue;
    }
    const key = [
      net.item,
      net.beltTier,
      net.ratePerSec.toFixed(3),
      familyOf(net.source.nodeId),
      familyOf(net.sink.nodeId),
    ].join('|');
    let arr = groups.get(key);
    if (!arr) {
      arr = [];
      groups.set(key, arr);
    }
    arr.push(net);
  }

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const uniqueSrcs = new Set(group.map((n) => n.source.nodeId));
    const uniqueDsts = new Set(group.map((n) => n.sink.nodeId));
    if (uniqueSrcs.size !== group.length || uniqueDsts.size !== group.length) {
      continue;
    }

    const srcCoords = group.map((n) =>
      getEndpointCoord(n.source.nodeId, n.source.pinId, macroById, pinById),
    );
    const dstCoords = group.map((n) =>
      getEndpointCoord(n.sink.nodeId, n.sink.pinId, macroById, pinById),
    );
    const axis = chooseAxis(srcCoords);

    const ports: PortSlot[] = srcCoords.map((c, idx) => ({
      pinId: group[idx].source.pinId,
      x: c.x,
      y: c.y,
      faceCoord: axis === 'y' ? c.y : c.x,
    }));
    const targets: TargetSlot[] = dstCoords.map((c) => ({
      x: c.x,
      y: c.y,
      peerCoord: axis === 'y' ? c.y : c.x,
    }));

    const origSinks = group.map((n) => ({ ...n.sink }));
    const assign = solveMinCostAssignment(ports, targets);
    for (let i = 0; i < group.length; i++) {
      group[i].sink = { ...origSinks[assign[i]] };
    }
  }

  // Keep PerimeterPin.netId in sync after any slice swapping
  for (const net of synth.nets) {
    if (net.source.nodeId.startsWith('in:')) {
      const p = pinById.get(net.source.nodeId);
      if (p) p.netId = net.id;
    }
    if (net.sink.nodeId.startsWith('out:')) {
      const p = pinById.get(net.sink.nodeId);
      if (p) p.netId = net.id;
    }
  }
}
