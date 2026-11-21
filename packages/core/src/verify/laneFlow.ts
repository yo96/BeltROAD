import {
  Dir,
  EntityInstance,
  RecipeMacroSpec,
  SynthesisResult,
} from '../types.js';
import {
  BELT_SPECS,
  INSERTER_BY_ENTITY_NAME,
  beltTierFromEntityName,
  isSplitterName,
  isUndergroundName,
} from '../data/entities.js';
import { dirDelta, inserterReachTiles, oppositeDir } from '../geometry.js';

export interface LaneRates {
  left: number;
  right: number;
}

export interface MacroLaneSummary {
  outLeft: number;
  outRight: number;
  peakLeft: number;
  peakRight: number;
}

/**
 * In Factorio, an inserter drops items onto the FAR lane of a perpendicular belt
 * and onto the RIGHT lane of a parallel belt relative to belt travel direction.
 * Remember `insDir` points from inserter center toward pickup, so items drop along
 * `dropDir = oppositeDir(insDir)`.
 */
export function inserterDropLane(insDir: Dir, beltDir: Dir): 'left' | 'right' {
  const dropDir = oppositeDir(insDir);
  if (dropDir === beltDir || dropDir === oppositeDir(beltDir)) {
    return 'right';
  }
  const b = dirDelta(beltDir);
  const d = dirDelta(dropDir);
  // Screen coordinates (+x East, +y South): positive 2D cross product points rightward of travel vector
  const cross = b.dx * d.dy - b.dy * d.dx;
  return cross > 0 ? 'right' : 'left';
}

/**
 * When a belt traveling `srcDir` side-loads perpendicular into a straight belt
 * traveling `dstDir`, all items from both lanes of the source belt merge onto
 * the side nearest the incoming belt's arrival edge.
 */
export function sideLoadTargetLane(srcDir: Dir, dstDir: Dir): 'left' | 'right' {
  const b = dirDelta(dstDir);
  const a = dirDelta(srcDir);
  const cross = b.dx * a.dy - b.dy * a.dx;
  return cross > 0 ? 'left' : 'right';
}

function isOutputTransportEntity(e: EntityInstance): boolean {
  return (
    e.role === 'belt-macro' ||
    e.role === 'ug-macro' ||
    e.role === 'splitter-macro' ||
    beltTierFromEntityName(e.name) !== null
  );
}

/**
 * Simulates steady-state per-lane item flow across a recipe macro's output
 * inserters, belts, undergrounds, splitters, and mid-row lane-flip jogs.
 */
export function simulateMacroOutputLanes(
  rm: RecipeMacroSpec,
  macroEnts: EntityInstance[],
): MacroLaneSummary {
  if (macroEnts.length === 0) {
    const half = rm.outputRatePerSec / 2;
    return { outLeft: half, outRight: half, peakLeft: half, peakRight: half };
  }

  const outInserters = macroEnts.filter((e) => e.role === 'inserter-out');
  if (outInserters.length === 0) {
    const half = rm.outputRatePerSec / 2;
    return { outLeft: half, outRight: half, peakLeft: half, peakRight: half };
  }

  const tileEnt = new Map<string, EntityInstance>();
  const transportEnts: EntityInstance[] = [];
  for (const e of macroEnts) {
    if (
      e.role !== 'belt-macro' &&
      e.role !== 'ug-macro' &&
      e.role !== 'splitter-macro' &&
      e.role !== 'machine'
    ) {
      continue;
    }
    for (let dx = 0; dx < e.w; dx++) {
      for (let dy = 0; dy < e.h; dy++) {
        tileEnt.set(`${e.tx + dx},${e.ty + dy}`, e);
      }
    }
    if (e.role !== 'machine' && isOutputTransportEntity(e)) {
      transportEnts.push(e);
    }
  }

  const byId = new Map(transportEnts.map((e) => [e.id, e]));
  const ugByTile = new Map<string, EntityInstance>();
  for (const e of transportEnts) {
    if (isUndergroundName(e.name)) {
      ugByTile.set(`${e.tx},${e.ty}`, e);
    }
  }

  // Group output inserters by source machine to divide total macro output accurately
  const insByMachine = new Map<string, EntityInstance[]>();
  const insDropBelt = new Map<string, EntityInstance>();

  for (const ins of outInserters) {
    const insSpec = INSERTER_BY_ENTITY_NAME[ins.name];
    const reach = insSpec?.reach ?? 1;
    const { pickupX, pickupY, dropX, dropY } = inserterReachTiles(
      ins.tx,
      ins.ty,
      ins.direction,
      reach,
    );
    const mach = tileEnt.get(`${pickupX},${pickupY}`);
    const dropTarget = tileEnt.get(`${dropX},${dropY}`);
    const machKey = mach?.id ?? `__unmatched_${ins.id}`;
    let grp = insByMachine.get(machKey);
    if (!grp) {
      grp = [];
      insByMachine.set(machKey, grp);
    }
    grp.push(ins);
    if (dropTarget && dropTarget.role !== 'machine') {
      insDropBelt.set(ins.id, dropTarget);
    }
  }

  const perMachRate = rm.outputRatePerSec / Math.max(1, rm.machineCount);
  const injected = new Map<string, LaneRates>();
  const dropSeeds: string[] = [];

  for (const grp of insByMachine.values()) {
    const ratePerIns = perMachRate / Math.max(1, grp.length);
    for (const ins of grp) {
      const target = insDropBelt.get(ins.id);
      if (!target) continue;
      const lane = inserterDropLane(ins.direction, target.direction);
      let cur = injected.get(target.id);
      if (!cur) {
        cur = { left: 0, right: 0 };
        injected.set(target.id, cur);
        dropSeeds.push(target.id);
      }
      if (lane === 'left') cur.left += ratePerIns;
      else cur.right += ratePerIns;
    }
  }

  // Build transport graph successors & incoming feeds inside macro
  interface OutEdge {
    toId: string;
    srcDir: Dir;
    weight: number;
  }
  const outgoing = new Map<string, OutEdge[]>();
  const incoming = new Map<string, Array<{ fromId: string; srcDir: Dir; weight: number }>>();

  const addEdge = (fromId: string, toId: string, srcDir: Dir, weight: number) => {
    if (fromId === toId) return;
    let outArr = outgoing.get(fromId);
    if (!outArr) {
      outArr = [];
      outgoing.set(fromId, outArr);
    }
    outArr.push({ toId, srcDir, weight });

    let inArr = incoming.get(toId);
    if (!inArr) {
      inArr = [];
      incoming.set(toId, inArr);
    }
    inArr.push({ fromId, srcDir, weight });
  };

  for (const e of transportEnts) {
    if (isSplitterName(e.name)) {
      const { dx, dy } = dirDelta(e.direction);
      const validTargets: EntityInstance[] = [];
      for (let ox = 0; ox < e.w; ox++) {
        for (let oy = 0; oy < e.h; oy++) {
          const cand = tileEnt.get(`${e.tx + ox + dx},${e.ty + oy + dy}`);
          if (cand && cand.id !== e.id && cand.role !== 'machine') {
            validTargets.push(cand);
          }
        }
      }
      const w = 1 / Math.max(1, validTargets.length);
      for (const t of validTargets) {
        addEdge(e.id, t.id, e.direction, w);
      }
      continue;
    }

    if (isUndergroundName(e.name)) {
      if (e.type === 'input') {
        const tier = beltTierFromEntityName(e.name);
        if (!tier) continue;
        const maxD = BELT_SPECS[tier].maxUgDistance;
        const { dx, dy } = dirDelta(e.direction);
        for (let step = 1; step <= maxD; step++) {
          const partner = ugByTile.get(`${e.tx + dx * step},${e.ty + dy * step}`);
          if (!partner) continue;
          if (partner.direction === e.direction) {
            if (
              partner.type === 'output' &&
              beltTierFromEntityName(partner.name) === tier
            ) {
              addEdge(e.id, partner.id, e.direction, 1);
            }
            break;
          }
        }
      } else {
        const { dx, dy } = dirDelta(e.direction);
        const next = tileEnt.get(`${e.tx + dx},${e.ty + dy}`);
        if (next && next.id !== e.id && next.role !== 'machine') {
          addEdge(e.id, next.id, e.direction, 1);
        }
      }
      continue;
    }

    // Surface belt
    const { dx, dy } = dirDelta(e.direction);
    const next = tileEnt.get(`${e.tx + dx},${e.ty + dy}`);
    if (next && next.id !== e.id && next.role !== 'machine') {
      addEdge(e.id, next.id, e.direction, 1);
    }
  }

  // BFS reachable subset of transport entities fed by output inserters
  const reachable = new Set<string>();
  const q = [...dropSeeds];
  for (const id of dropSeeds) reachable.add(id);
  while (q.length > 0) {
    const cur = q.shift()!;
    for (const edge of outgoing.get(cur) ?? []) {
      if (!reachable.has(edge.toId)) {
        reachable.add(edge.toId);
        q.push(edge.toId);
      }
    }
  }

  const rates = new Map<string, LaneRates>();
  for (const id of reachable) {
    const inj = injected.get(id);
    rates.set(id, { left: inj?.left ?? 0, right: inj?.right ?? 0 });
  }

  // Determine whether each reachable tile acts as straight or curved
  const isStraightMap = new Map<string, boolean>();
  for (const id of reachable) {
    const ent = byId.get(id)!;
    if (ent.intentionalSideLoad || isSplitterName(ent.name) || isUndergroundName(ent.name)) {
      isStraightMap.set(id, true);
      continue;
    }
    const feeds = (incoming.get(id) ?? []).filter((f) => reachable.has(f.fromId));
    const hasBackFeed = feeds.some((f) => f.srcDir === ent.direction);
    const sideDirs = new Set(
      feeds
        .filter((f) => f.srcDir !== ent.direction && f.srcDir !== oppositeDir(ent.direction))
        .map((f) => f.srcDir),
    );
    isStraightMap.set(id, hasBackFeed || sideDirs.size >= 2);
  }

  // Fixed-point propagation along the reachable output network
  const reachList = Array.from(reachable);
  for (let iter = 0; iter < 128; iter++) {
    let maxDelta = 0;
    for (const id of reachList) {
      const ent = byId.get(id)!;
      const inj = injected.get(id);
      let nextL = inj?.left ?? 0;
      let nextR = inj?.right ?? 0;

      const straight = isStraightMap.get(id) ?? true;
      const feeds = incoming.get(id) ?? [];

      for (const f of feeds) {
        if (!reachable.has(f.fromId)) continue;
        const src = rates.get(f.fromId)!;
        const contribL = src.left * f.weight;
        const contribR = src.right * f.weight;

        if (isSplitterName(ent.name) || isUndergroundName(ent.name) || !straight) {
          nextL += contribL;
          nextR += contribR;
        } else if (f.srcDir === ent.direction) {
          nextL += contribL;
          nextR += contribR;
        } else if (f.srcDir !== oppositeDir(ent.direction)) {
          const targetLane = sideLoadTargetLane(f.srcDir, ent.direction);
          if (targetLane === 'left') nextL += contribL + contribR;
          else nextR += contribL + contribR;
        }
      }

      const prev = rates.get(id)!;
      const delta = Math.max(Math.abs(nextL - prev.left), Math.abs(nextR - prev.right));
      if (delta > maxDelta) maxDelta = delta;
      prev.left = nextL;
      prev.right = nextR;
    }
    if (maxDelta < 1e-6) break;
  }

  let peakLeft = 0;
  let peakRight = 0;
  let outLeft = 0;
  let outRight = 0;
  let bestOutTotal = -1;

  for (const id of reachList) {
    const r = rates.get(id)!;
    if (r.left > peakLeft) peakLeft = r.left;
    if (r.right > peakRight) peakRight = r.right;

    const succs = (outgoing.get(id) ?? []).filter((o) => reachable.has(o.toId));
    if (succs.length === 0) {
      const tot = r.left + r.right;
      if (tot > bestOutTotal) {
        bestOutTotal = tot;
        outLeft = r.left;
        outRight = r.right;
      }
    }
  }

  if (bestOutTotal < 0) {
    const half = rm.outputRatePerSec / 2;
    return { outLeft: half, outRight: half, peakLeft, peakRight };
  }

  return { outLeft, outRight, peakLeft, peakRight };
}

export function analyzeNetworkLaneFlow(
  synth: SynthesisResult,
  allEntities: EntityInstance[],
): {
  macroLanes: Map<string, MacroLaneSummary>;
  netLanes: Map<string, LaneRates>;
} {
  const entitiesByMacro = new Map<string, EntityInstance[]>();
  for (const e of allEntities) {
    if (!e.macroId) continue;
    let arr = entitiesByMacro.get(e.macroId);
    if (!arr) {
      arr = [];
      entitiesByMacro.set(e.macroId, arr);
    }
    arr.push(e);
  }

  const macroLanes = new Map<string, MacroLaneSummary>();
  for (const node of synth.nodes) {
    if (node.kind !== 'recipe-macro') continue;
    const ents = entitiesByMacro.get(node.id) ?? [];
    macroLanes.set(node.id, simulateMacroOutputLanes(node, ents));
  }

  const netLanes = new Map<string, LaneRates>();
  const nodeById = new Map(synth.nodes.map((n) => [n.id, n]));
  const inNets = new Map<string, typeof synth.nets>();
  const outNets = new Map<string, typeof synth.nets>();
  const inDeg = new Map<string, number>();

  for (const n of synth.nodes) {
    inNets.set(n.id, []);
    outNets.set(n.id, []);
    inDeg.set(n.id, 0);
  }
  for (const net of synth.nets) {
    outNets.get(net.source.nodeId)?.push(net);
    inNets.get(net.sink.nodeId)?.push(net);
    inDeg.set(net.sink.nodeId, (inDeg.get(net.sink.nodeId) ?? 0) + 1);
  }

  const q: string[] = [];
  for (const [id, deg] of inDeg.entries()) {
    if (deg === 0) q.push(id);
  }

  const visited = new Set<string>();
  const topo: string[] = [];
  while (q.length > 0) {
    const id = q.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    topo.push(id);
    for (const net of outNets.get(id) ?? []) {
      const nextDeg = (inDeg.get(net.sink.nodeId) ?? 1) - 1;
      inDeg.set(net.sink.nodeId, nextDeg);
      if (nextDeg === 0) q.push(net.sink.nodeId);
    }
  }
  for (const n of synth.nodes) {
    if (!visited.has(n.id)) topo.push(n.id);
  }

  for (const nodeId of topo) {
    const node = nodeById.get(nodeId);
    const outs = outNets.get(nodeId) ?? [];
    if (!node || outs.length === 0) continue;

    if (node.kind === 'primary-input') {
      for (const net of outs) {
        netLanes.set(net.id, { left: net.ratePerSec / 2, right: net.ratePerSec / 2 });
      }
      continue;
    }

    if (node.kind === 'recipe-macro') {
      const ml = macroLanes.get(nodeId);
      const totOut = ml ? ml.outLeft + ml.outRight : 0;
      for (const net of outs) {
        if (ml && totOut > 1e-9) {
          netLanes.set(net.id, {
            left: net.ratePerSec * (ml.outLeft / totOut),
            right: net.ratePerSec * (ml.outRight / totOut),
          });
        } else {
          netLanes.set(net.id, { left: net.ratePerSec / 2, right: net.ratePerSec / 2 });
        }
      }
      continue;
    }

    if (node.kind === 'balancer-macro') {
      let inLeft = 0;
      let inRight = 0;
      for (const inNet of inNets.get(nodeId) ?? []) {
        const lr = netLanes.get(inNet.id) ?? {
          left: inNet.ratePerSec / 2,
          right: inNet.ratePerSec / 2,
        };
        inLeft += lr.left;
        inRight += lr.right;
      }
      const totalIn = inLeft + inRight;
      for (const net of outs) {
        if (totalIn > 1e-9) {
          netLanes.set(net.id, {
            left: net.ratePerSec * (inLeft / totalIn),
            right: net.ratePerSec * (inRight / totalIn),
          });
        } else {
          netLanes.set(net.id, { left: net.ratePerSec / 2, right: net.ratePerSec / 2 });
        }
      }
    }
  }

  return { macroLanes, netLanes };
}
