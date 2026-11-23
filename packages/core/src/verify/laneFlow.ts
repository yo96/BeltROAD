import {
  BalancerMacroSpec,
  BeltLaneFlowInfo,
  Dir,
  EntityInstance,
  PdkConfig,
  RecipeMacroSpec,
  SynthesisResult,
  SynthNet,
} from '../types.js';
import {
  BELT_SPECS,
  INSERTER_BY_ENTITY_NAME,
  beltTierFromEntityName,
  effectiveBeltCapacity,
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
  entityRates?: Map<string, LaneRates>;
  reachableIds?: Set<string>;
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
 * In Factorio, an inserter picking up from a perpendicular belt pulls from the NEAR
 * lane first. Remember `insDir` points from inserter center toward its pickup tile
 * (the belt), so the inserter itself sits in direction `oppositeDir(insDir)` from the belt.
 */
export function inserterPickupNearLane(insDir: Dir, beltDir: Dir): 'left' | 'right' {
  if (insDir === beltDir || insDir === oppositeDir(beltDir)) {
    return 'left';
  }
  const b = dirDelta(beltDir);
  const p = dirDelta(insDir);
  // Screen coordinates (+x East, +y South): b × p > 0 means vector toward belt points right,
  // so inserter sits on LEFT side of travel vector (near lane = 'left').
  const cross = b.dx * p.dy - b.dy * p.dx;
  return cross > 0 ? 'left' : 'right';
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

interface TransportEdge {
  fromId: string;
  toId: string;
  srcDir: Dir;
  weight: number;
}

function buildMacroTransportGraph(
  transportEnts: EntityInstance[],
  tileEnt: Map<string, EntityInstance>,
): {
  byId: Map<string, EntityInstance>;
  outgoing: Map<string, TransportEdge[]>;
  incoming: Map<string, TransportEdge[]>;
} {
  const byId = new Map(transportEnts.map((e) => [e.id, e]));
  const ugByTile = new Map<string, EntityInstance>();
  for (const e of transportEnts) {
    if (isUndergroundName(e.name)) {
      ugByTile.set(`${e.tx},${e.ty}`, e);
    }
  }

  const outgoing = new Map<string, TransportEdge[]>();
  const incoming = new Map<string, TransportEdge[]>();

  const addEdge = (fromId: string, toId: string, srcDir: Dir, weight: number) => {
    if (fromId === toId || !byId.has(fromId) || !byId.has(toId)) return;
    let outArr = outgoing.get(fromId);
    if (!outArr) {
      outArr = [];
      outgoing.set(fromId, outArr);
    }
    outArr.push({ fromId, toId, srcDir, weight });

    let inArr = incoming.get(toId);
    if (!inArr) {
      inArr = [];
      incoming.set(toId, inArr);
    }
    inArr.push({ fromId, toId, srcDir, weight });
  };

  for (const e of transportEnts) {
    if (isSplitterName(e.name)) {
      const { dx, dy } = dirDelta(e.direction);
      const validTargets: EntityInstance[] = [];
      for (let ox = 0; ox < e.w; ox++) {
        for (let oy = 0; oy < e.h; oy++) {
          const cand = tileEnt.get(`${e.tx + ox + dx},${e.ty + oy + dy}`);
          if (cand && cand.id !== e.id && cand.role !== 'machine' && byId.has(cand.id)) {
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
        if (next && next.id !== e.id && next.role !== 'machine' && byId.has(next.id)) {
          addEdge(e.id, next.id, e.direction, 1);
        }
      }
      continue;
    }

    // Surface belt
    const { dx, dy } = dirDelta(e.direction);
    const next = tileEnt.get(`${e.tx + dx},${e.ty + dy}`);
    if (next && next.id !== e.id && next.role !== 'machine' && byId.has(next.id)) {
      addEdge(e.id, next.id, e.direction, 1);
    }
  }

  return { byId, outgoing, incoming };
}

function computeIsStraightMap(
  nodeIds: Iterable<string>,
  byId: Map<string, EntityInstance>,
  incoming: Map<string, TransportEdge[]>,
  activeSet?: Set<string>,
): Map<string, boolean> {
  const isStraightMap = new Map<string, boolean>();
  for (const id of nodeIds) {
    const ent = byId.get(id);
    if (!ent) continue;
    if (ent.intentionalSideLoad || isSplitterName(ent.name) || isUndergroundName(ent.name)) {
      isStraightMap.set(id, true);
      continue;
    }
    const feeds = (incoming.get(id) ?? []).filter((f) => !activeSet || activeSet.has(f.fromId));
    const hasBackFeed = feeds.some((f) => f.srcDir === ent.direction);
    const sideDirs = new Set(
      feeds
        .filter((f) => f.srcDir !== ent.direction && f.srcDir !== oppositeDir(ent.direction))
        .map((f) => f.srcDir),
    );
    isStraightMap.set(id, hasBackFeed || sideDirs.size >= 2);
  }
  return isStraightMap;
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
    return {
      outLeft: half,
      outRight: half,
      peakLeft: half,
      peakRight: half,
      entityRates: new Map(),
      reachableIds: new Set(),
    };
  }

  const outInserters = macroEnts.filter((e) => e.role === 'inserter-out');
  if (outInserters.length === 0) {
    const half = rm.outputRatePerSec / 2;
    return {
      outLeft: half,
      outRight: half,
      peakLeft: half,
      peakRight: half,
      entityRates: new Map(),
      reachableIds: new Set(),
    };
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

  const { byId, outgoing, incoming } = buildMacroTransportGraph(transportEnts, tileEnt);

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

  const outputDenom = rm.directInsert
    ? rm.directInsert.unitCount * rm.directInsert.consumerMachinesPerUnit
    : Math.max(1, rm.machineCount);
  const perMachRate = rm.outputRatePerSec / Math.max(1, outputDenom);
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

  const isStraightMap = computeIsStraightMap(reachable, byId, incoming, reachable);

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

  const entityRates = new Map<string, LaneRates>();
  for (const id of reachList) {
    const r = rates.get(id)!;
    if (r.left > peakLeft) peakLeft = r.left;
    if (r.right > peakRight) peakRight = r.right;
    entityRates.set(id, {
      left: r.left < 1e-6 ? 0 : r.left,
      right: r.right < 1e-6 ? 0 : r.right,
    });

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

  // Include upstream stub output belt tiles not reached by any inserter
  const ingItems = new Set(rm.ingredientRates.map((r) => r.item));
  const reachableIds = new Set<string>(reachable);
  if (!ingItems.has(rm.outputItem)) {
    for (const e of transportEnts) {
      if (!reachableIds.has(e.id) && e.item === rm.outputItem && !e.laneItems) {
        entityRates.set(e.id, { left: 0, right: 0 });
        reachableIds.add(e.id);
      }
    }
  }

  if (bestOutTotal < 0) {
    const half = rm.outputRatePerSec / 2;
    return {
      outLeft: half,
      outRight: half,
      peakLeft,
      peakRight,
      entityRates,
      reachableIds,
    };
  }

  return {
    outLeft,
    outRight,
    peakLeft,
    peakRight,
    entityRates,
    reachableIds,
  };
}

function topologicalOrder(
  ids: string[],
  outgoing: Map<string, TransportEdge[]>,
  incoming: Map<string, TransportEdge[]>,
): string[] {
  const inDeg = new Map<string, number>();
  for (const id of ids) {
    inDeg.set(id, (incoming.get(id) ?? []).length);
  }
  const q: string[] = [];
  for (const id of ids) {
    if ((inDeg.get(id) ?? 0) === 0) q.push(id);
  }
  const visited = new Set<string>();
  const topo: string[] = [];
  while (q.length > 0) {
    const cur = q.shift()!;
    if (visited.has(cur)) continue;
    visited.add(cur);
    topo.push(cur);
    for (const edge of outgoing.get(cur) ?? []) {
      const nextDeg = (inDeg.get(edge.toId) ?? 1) - 1;
      inDeg.set(edge.toId, nextDeg);
      if (nextDeg === 0) q.push(edge.toId);
    }
  }
  for (const id of ids) {
    if (!visited.has(id)) topo.push(id);
  }
  return topo;
}

/**
 * Simulates steady-state per-lane item flow across a recipe macro's input
 * manifold (single-item tracks, dual-lane side-load headers, UG bridges, and
 * inserter near-lane-first pickup). Records flow arriving at each belt tile
 * before local inserter consumption (`beforeDraw`).
 */
export function simulateMacroInputLanes(
  rm: RecipeMacroSpec,
  macroEnts: EntityInstance[],
  incomingNets: SynthNet[],
  netLanes: Map<string, LaneRates>,
  outputEntityIds: Set<string>,
  pdk?: Pick<PdkConfig, 'beltStackSize'>,
): Map<string, BeltLaneFlowInfo> {
  const result = new Map<string, BeltLaneFlowInfo>();
  if (macroEnts.length === 0) return result;

  const tileEnt = new Map<string, EntityInstance>();
  const inputTransport: EntityInstance[] = [];
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
    if (e.role !== 'machine' && !outputEntityIds.has(e.id) && isOutputTransportEntity(e)) {
      inputTransport.push(e);
    }
  }

  if (inputTransport.length === 0) return result;

  const { byId, outgoing, incoming } = buildMacroTransportGraph(inputTransport, tileEnt);
  const ids = inputTransport.map((e) => e.id);
  const isStraightMap = computeIsStraightMap(ids, byId, incoming);
  const topo = topologicalOrder(ids, outgoing, incoming);

  // Sum incoming net (L, R) rates per item
  const itemNetRates = new Map<string, LaneRates>();
  for (const net of incomingNets) {
    const lr = netLanes.get(net.id) ?? {
      left: net.ratePerSec / 2,
      right: net.ratePerSec / 2,
    };
    const prev = itemNetRates.get(net.item);
    if (prev) {
      prev.left += lr.left;
      prev.right += lr.right;
    } else {
      itemNetRates.set(net.item, { left: lr.left, right: lr.right });
    }
  }

  // Fallback to spec ingredient rates if incoming nets are omitted (e.g., standalone unit tests)
  const specRateByItem = new Map<string, LaneRates>();
  for (const ing of rm.ingredientRates) {
    const prev = specRateByItem.get(ing.item);
    const half = ing.ratePerSec / 2;
    if (prev) {
      prev.left += half;
      prev.right += half;
    } else {
      specRateByItem.set(ing.item, { left: half, right: half });
    }
  }

  // Group single-item source tiles by item
  const sourceTilesByItem = new Map<string, EntityInstance[]>();
  for (const e of inputTransport) {
    if ((incoming.get(e.id)?.length ?? 0) > 0) continue;
    if (!e.laneItems && e.item) {
      let arr = sourceTilesByItem.get(e.item);
      if (!arr) {
        arr = [];
        sourceTilesByItem.set(e.item, arr);
      }
      arr.push(e);
    }
  }

  const seededRates = new Map<string, LaneRates>();
  const totalSeededByItem = new Map<string, number>();
  for (const [item, srcs] of sourceTilesByItem.entries()) {
    const lr = itemNetRates.get(item) ?? specRateByItem.get(item) ?? { left: 0, right: 0 };
    totalSeededByItem.set(item, lr.left + lr.right);
    const perSrcL = lr.left / Math.max(1, srcs.length);
    const perSrcR = lr.right / Math.max(1, srcs.length);
    for (const s of srcs) {
      seededRates.set(s.id, { left: perSrcL, right: perSrcR });
    }
  }

  // Pass 1: Propagate item identities along topology (fills header UG bridges without metadata)
  const laneItemState = new Map<string, { leftItem?: string; rightItem?: string }>();
  for (const id of topo) {
    const ent = byId.get(id)!;
    let leftItem = ent.laneItems ? ent.laneItems[0] : ent.item;
    let rightItem = ent.laneItems ? ent.laneItems[1] : ent.item;
    const straight = isStraightMap.get(id) ?? true;

    for (const f of incoming.get(id) ?? []) {
      const srcEnt = byId.get(f.fromId);
      const srcItems = laneItemState.get(f.fromId);
      const sLeft = srcItems?.leftItem ?? srcEnt?.laneItems?.[0] ?? srcEnt?.item;
      const sRight = srcItems?.rightItem ?? srcEnt?.laneItems?.[1] ?? srcEnt?.item;

      if (isSplitterName(ent.name) || isUndergroundName(ent.name) || !straight || f.srcDir === ent.direction) {
        if (!leftItem && sLeft) leftItem = sLeft;
        if (!rightItem && sRight) rightItem = sRight;
      } else if (f.srcDir !== oppositeDir(ent.direction)) {
        const targetLane = sideLoadTargetLane(f.srcDir, ent.direction);
        const sideItem = sLeft ?? sRight;
        if (targetLane === 'left' && !leftItem && sideItem) leftItem = sideItem;
        else if (targetLane === 'right' && !rightItem && sideItem) rightItem = sideItem;
      }
    }

    laneItemState.set(id, { leftItem, rightItem });
  }

  // Inserter demand attribution
  const insertersByMachineAndItem = new Map<string, Map<string, EntityInstance[]>>();
  const machinesForItem = new Map<string, Set<string>>();
  const insPickupBelt = new Map<string, EntityInstance>();
  const insDropMachKey = new Map<string, string>();

  for (const ins of macroEnts) {
    if (ins.role !== 'inserter-in') continue;
    const insSpec = INSERTER_BY_ENTITY_NAME[ins.name];
    const reach = insSpec?.reach ?? 1;
    const { pickupX, pickupY, dropX, dropY } = inserterReachTiles(
      ins.tx,
      ins.ty,
      ins.direction,
      reach,
    );
    const pickupBelt = tileEnt.get(`${pickupX},${pickupY}`);
    if (!pickupBelt || !byId.has(pickupBelt.id)) continue;

    const { dx, dy } = dirDelta(ins.direction);
    let dropMachine = tileEnt.get(`${dropX},${dropY}`);
    if ((!dropMachine || dropMachine.role !== 'machine') && reach === 2) {
      dropMachine = tileEnt.get(`${ins.tx - dx},${ins.ty - dy}`);
    }
    const machKey = dropMachine?.id ?? `__unmatched_${ins.id}`;
    insPickupBelt.set(ins.id, pickupBelt);
    insDropMachKey.set(ins.id, machKey);

    const items = laneItemState.get(pickupBelt.id);
    const distinctItems = new Set<string>();
    if (items?.leftItem) distinctItems.add(items.leftItem);
    if (items?.rightItem) distinctItems.add(items.rightItem);

    for (const item of distinctItems) {
      let byMach = insertersByMachineAndItem.get(item);
      if (!byMach) {
        byMach = new Map();
        insertersByMachineAndItem.set(item, byMach);
      }
      let insList = byMach.get(machKey);
      if (!insList) {
        insList = [];
        byMach.set(machKey, insList);
      }
      insList.push(ins);

      let mSet = machinesForItem.get(item);
      if (!mSet) {
        mSet = new Set();
        machinesForItem.set(item, mSet);
      }
      mSet.add(machKey);
    }
  }

  interface TileDemand {
    insDir: Dir;
    item: string;
    rate: number;
  }
  const demandsByTile = new Map<string, TileDemand[]>();
  for (const [item, byMach] of insertersByMachineAndItem.entries()) {
    const machSet = machinesForItem.get(item);
    const totalRate =
      totalSeededByItem.get(item) ??
      ((specRateByItem.get(item)?.left ?? 0) + (specRateByItem.get(item)?.right ?? 0));
    const perMachRate = totalRate / Math.max(1, machSet?.size ?? 1);

    for (const insList of byMach.values()) {
      const perInsRate = perMachRate / Math.max(1, insList.length);
      for (const ins of insList) {
        const belt = insPickupBelt.get(ins.id);
        if (!belt) continue;
        let arr = demandsByTile.get(belt.id);
        if (!arr) {
          arr = [];
          demandsByTile.set(belt.id, arr);
        }
        arr.push({ insDir: ins.direction, item, rate: perInsRate });
      }
    }
  }

  // Pass 2: Propagate steady-state lane rates in topological order, recording beforeDraw
  const afterRates = new Map<string, LaneRates>();
  for (const id of topo) {
    const ent = byId.get(id)!;
    const seed = seededRates.get(id);
    let inL = seed?.left ?? 0;
    let inR = seed?.right ?? 0;

    const straight = isStraightMap.get(id) ?? true;
    for (const f of incoming.get(id) ?? []) {
      const src = afterRates.get(f.fromId);
      if (!src) continue;
      const contribL = src.left * f.weight;
      const contribR = src.right * f.weight;

      if (isSplitterName(ent.name) || isUndergroundName(ent.name) || !straight) {
        inL += contribL;
        inR += contribR;
      } else if (f.srcDir === ent.direction) {
        inL += contribL;
        inR += contribR;
      } else if (f.srcDir !== oppositeDir(ent.direction)) {
        const targetLane = sideLoadTargetLane(f.srcDir, ent.direction);
        if (targetLane === 'left') inL += contribL + contribR;
        else inR += contribL + contribR;
      }
    }

    const items = laneItemState.get(id);
    const tier = beltTierFromEntityName(ent.name) ?? rm.beltTier;
    const cap = effectiveBeltCapacity(tier, pdk);

    result.set(id, {
      leftRatePerSec: inL < 1e-6 ? 0 : inL,
      rightRatePerSec: inR < 1e-6 ? 0 : inR,
      leftItem: items?.leftItem,
      rightItem: items?.rightItem,
      beltTier: tier,
      capacityPerSec: cap,
      source: 'macro-input',
    });

    let afterL = inL;
    let afterR = inR;
    const demands = demandsByTile.get(id);
    if (demands) {
      const isDual = Boolean(items?.leftItem && items?.rightItem && items.leftItem !== items.rightItem);
      for (const d of demands) {
        if (isDual) {
          if (d.item === items?.leftItem) {
            afterL = Math.max(0, afterL - d.rate);
          } else if (d.item === items?.rightItem) {
            afterR = Math.max(0, afterR - d.rate);
          }
        } else {
          const near = inserterPickupNearLane(d.insDir, ent.direction);
          if (near === 'left') {
            const takeNear = Math.min(Math.max(0, afterL), d.rate);
            afterL -= takeNear;
            const rem = d.rate - takeNear;
            if (rem > 0) afterR = Math.max(0, afterR - rem);
          } else {
            const takeNear = Math.min(Math.max(0, afterR), d.rate);
            afterR -= takeNear;
            const rem = d.rate - takeNear;
            if (rem > 0) afterL = Math.max(0, afterL - rem);
          }
        }
      }
    }

    afterRates.set(id, {
      left: afterL < 1e-6 ? 0 : afterL,
      right: afterR < 1e-6 ? 0 : afterR,
    });
  }

  return result;
}

function simulateBalancerLanes(
  balNode: BalancerMacroSpec,
  balEnts: EntityInstance[],
  inLeft: number,
  inRight: number,
  pdk?: Pick<PdkConfig, 'beltStackSize'>,
): Map<string, BeltLaneFlowInfo> {
  const result = new Map<string, BeltLaneFlowInfo>();
  const transportEnts = balEnts.filter((e) => beltTierFromEntityName(e.name) !== null);
  if (transportEnts.length === 0) return result;

  const tileEnt = new Map<string, EntityInstance>();
  for (const e of transportEnts) {
    for (let dx = 0; dx < e.w; dx++) {
      for (let dy = 0; dy < e.h; dy++) {
        tileEnt.set(`${e.tx + dx},${e.ty + dy}`, e);
      }
    }
  }

  const { byId, outgoing, incoming } = buildMacroTransportGraph(transportEnts, tileEnt);
  const ids = transportEnts.map((e) => e.id);
  const isStraightMap = computeIsStraightMap(ids, byId, incoming);

  let sources = transportEnts.filter((e) => (incoming.get(e.id)?.length ?? 0) === 0);
  if (sources.length === 0) {
    sources = transportEnts.slice(0, Math.max(1, balNode.inputs));
  }

  const seeded = new Map<string, LaneRates>();
  const seedL = inLeft / Math.max(1, sources.length);
  const seedR = inRight / Math.max(1, sources.length);
  for (const s of sources) {
    seeded.set(s.id, { left: seedL, right: seedR });
  }

  const rates = new Map<string, LaneRates>();
  for (const id of ids) {
    const s = seeded.get(id);
    rates.set(id, { left: s?.left ?? 0, right: s?.right ?? 0 });
  }

  const clampCap = Math.max(1e-3, (inLeft + inRight) * 4);
  for (let iter = 0; iter < 64; iter++) {
    let maxDelta = 0;
    for (const id of ids) {
      const ent = byId.get(id)!;
      const s = seeded.get(id);
      let nextL = s?.left ?? 0;
      let nextR = s?.right ?? 0;

      const straight = isStraightMap.get(id) ?? true;
      for (const f of incoming.get(id) ?? []) {
        const src = rates.get(f.fromId);
        if (!src) continue;
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

      nextL = Math.min(clampCap, nextL);
      nextR = Math.min(clampCap, nextR);

      const prev = rates.get(id)!;
      const delta = Math.max(Math.abs(nextL - prev.left), Math.abs(nextR - prev.right));
      if (delta > maxDelta) maxDelta = delta;
      prev.left = nextL;
      prev.right = nextR;
    }
    if (maxDelta < 1e-6) break;
  }

  void outgoing;
  for (const e of transportEnts) {
    const r = rates.get(e.id) ?? { left: 0, right: 0 };
    const l = r.left < 1e-6 ? 0 : r.left;
    const rr = r.right < 1e-6 ? 0 : r.right;
    const tier = beltTierFromEntityName(e.name) ?? balNode.beltTier;
    const baseCap = effectiveBeltCapacity(tier, pdk);
    const isParallelSplitter =
      isSplitterName(e.name) &&
      ((balNode.inputs >= 2 && balNode.outputs >= 2) || l + rr > baseCap + 1e-4);
    result.set(e.id, {
      leftRatePerSec: l,
      rightRatePerSec: rr,
      leftItem: balNode.item,
      rightItem: balNode.item,
      beltTier: tier,
      capacityPerSec: isParallelSplitter ? baseCap * 2 : baseCap,
      source: 'balancer',
    });
  }

  return result;
}

export function analyzeNetworkLaneFlow(
  synth: SynthesisResult,
  allEntities: EntityInstance[],
): {
  macroLanes: Map<string, MacroLaneSummary>;
  netLanes: Map<string, LaneRates>;
  entityLanes: Record<string, BeltLaneFlowInfo>;
} {
  const entitiesByMacro = new Map<string, EntityInstance[]>();
  const entityById = new Map<string, EntityInstance>();
  for (const e of allEntities) {
    entityById.set(e.id, e);
    if (!e.macroId) continue;
    let arr = entitiesByMacro.get(e.macroId);
    if (!arr) {
      arr = [];
      entitiesByMacro.set(e.macroId, arr);
    }
    arr.push(e);
  }

  const macroLanes = new Map<string, MacroLaneSummary>();
  const entityLanes: Record<string, BeltLaneFlowInfo> = {};

  for (const node of synth.nodes) {
    if (node.kind !== 'recipe-macro') continue;
    const ents = entitiesByMacro.get(node.id) ?? [];
    const summary = simulateMacroOutputLanes(node, ents);
    macroLanes.set(node.id, summary);

    if (summary.entityRates) {
      for (const [eid, lr] of summary.entityRates.entries()) {
        const ent = entityById.get(eid);
        const tier = (ent ? beltTierFromEntityName(ent.name) : null) ?? node.beltTier;
        entityLanes[eid] = {
          leftRatePerSec: lr.left,
          rightRatePerSec: lr.right,
          leftItem: node.outputItem,
          rightItem: node.outputItem,
          beltTier: tier,
          capacityPerSec: effectiveBeltCapacity(tier, synth.spec.pdk),
          source: 'macro-output',
        };
      }
    }
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
    if (!node) continue;
    const outs = outNets.get(nodeId) ?? [];

    if (node.kind === 'balancer-macro') {
      const ins = inNets.get(nodeId) ?? [];
      let inLeft = 0;
      let inRight = 0;
      if (ins.length === 0) {
        inLeft = node.totalRatePerSec / 2;
        inRight = node.totalRatePerSec / 2;
      } else {
        for (const inNet of ins) {
          const lr = netLanes.get(inNet.id) ?? {
            left: inNet.ratePerSec / 2,
            right: inNet.ratePerSec / 2,
          };
          inLeft += lr.left;
          inRight += lr.right;
        }
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

      const balLanes = simulateBalancerLanes(
        node,
        entitiesByMacro.get(nodeId) ?? [],
        inLeft,
        inRight,
        synth.spec.pdk,
      );
      for (const [eid, info] of balLanes.entries()) {
        entityLanes[eid] = info;
      }
      continue;
    }

    if (outs.length === 0) continue;

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
    }
  }

  // Compute macro-internal input lane rates once all incoming netLanes are known
  for (const node of synth.nodes) {
    if (node.kind !== 'recipe-macro') continue;
    const ml = macroLanes.get(node.id);
    const inFlow = simulateMacroInputLanes(
      node,
      entitiesByMacro.get(node.id) ?? [],
      inNets.get(node.id) ?? [],
      netLanes,
      ml?.reachableIds ?? new Set(),
      synth.spec.pdk,
    );
    for (const [eid, info] of inFlow.entries()) {
      entityLanes[eid] = info;
    }
  }

  return { macroLanes, netLanes, entityLanes };
}
