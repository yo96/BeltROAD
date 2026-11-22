import {
  BalancerMacroSpec,
  BeltTier,
  DesignSpec,
  Dir,
  EntityInstance,
  FloorplanResult,
  MacroPin,
  PdkConfig,
  PerimeterPin,
  PipelineResult,
  PlacedMacro,
  RecipeMacroSpec,
  RouteResult,
  RoutedNetSegment,
  SynthInputNode,
  SynthNet,
  SynthNode,
  SynthOutputNode,
  SynthesisResult,
  TilingSummary,
} from '../types.js';
import type { PipelineOptions } from '../pipeline.js';
import { BELT_SPECS, MACHINE_SPECS } from '../data/entities.js';
import { dirDelta, flipDirX } from '../geometry.js';
import { synthesizeDesign } from '../synth/synthesize.js';
import { buildPowerGrid } from '../pdn/powerGrid.js';
import { runDrc } from '../verify/drc.js';
import { runSta } from '../verify/sta.js';
import { entitiesToBlueprintString } from '../blueprint/codec.js';

export type FlatPipelineRunner = (
  spec: DesignSpec,
  options?: PipelineOptions,
  synthOpts?: { forceBalancedOutputs?: boolean },
) => PipelineResult;

function countRecipeAndBalancerMacros(synth: SynthesisResult): number {
  let count = 0;
  for (const n of synth.nodes) {
    if (n.kind === 'recipe-macro' || n.kind === 'balancer-macro') count++;
  }
  return count;
}

export function shouldUseTiling(spec: DesignSpec, fullSynth: SynthesisResult): boolean {
  const mode = spec.optimization?.tiling ?? 'auto';
  if (mode === 'off') return false;

  const activeMacroIds = new Set<string>();
  const activePinIds = new Set<string>();
  const activeBusIds = new Set<string>();
  for (const n of fullSynth.nodes) {
    if (n.kind === 'recipe-macro' || n.kind === 'balancer-macro') {
      activeMacroIds.add(n.id);
    } else if (n.kind === 'primary-input' || n.kind === 'primary-output') {
      activePinIds.add(n.pinId);
      const prefix = n.kind === 'primary-input' ? 'in:' : 'out:';
      activeBusIds.add(`${prefix}${n.item}`);
      activeBusIds.add(n.item);
    }
  }

  const isHuge = fullSynth.nets.length > 60 || fullSynth.bom.totalMachines > 200;
  const hasActiveBlockingPin = spec.pins.some((p) => {
    const matchesNode =
      (p.id && activePinIds.has(p.id)) ||
      (p.bus && activeBusIds.has(p.bus));
    if (!matchesNode) return false;
    const isNonStandard = p.offset !== undefined || p.edge === 'N' || p.edge === 'S';
    if (!isNonStandard) return false;
    return isHuge ? p.locked === true : true;
  });

  const hasActiveMacroOverride = Object.entries(spec.macroOverrides).some(([id, ov]) => {
    if (!activeMacroIds.has(id)) return false;
    return isHuge ? ov.locked === true : true;
  });

  if (hasActiveBlockingPin || hasActiveMacroOverride) {
    return false;
  }
  if (typeof mode === 'number') {
    return Number.isFinite(mode) && mode >= 2;
  }
  return (
    fullSynth.nets.length > 38 ||
    countRecipeAndBalancerMacros(fullSynth) > 18 ||
    fullSynth.bom.totalMachines > 120
  );
}

function scaleSpecTargets(spec: DesignSpec, scale: number, suffix: string): DesignSpec {
  return {
    ...spec,
    name: `${spec.name} (${suffix})`,
    targets: spec.targets.map((t) => ({
      item: t.item,
      ratePerMin: t.ratePerMin * scale,
    })),
    pins: [],
    macroOverrides: {},
  };
}

function chooseCandidateTileCounts(
  spec: DesignSpec,
  fullSynth: SynthesisResult,
): number[] {
  const mode = spec.optimization?.tiling ?? 'auto';
  const smooth = [
    2, 3, 4, 5, 6, 8, 9, 10, 12, 14, 15, 16, 18, 20, 24, 25, 30, 32, 36, 40, 48, 50, 60, 64,
  ];
  const candSet = new Set<number>();

  if (typeof mode === 'number' && mode >= 2) {
    const k = Math.round(mode);
    candSet.add(k);
    for (const s of smooth) {
      if (s > k) candSet.add(s);
    }
    return Array.from(candSet).slice(0, 4);
  }

  const estMinK = Math.max(
    2,
    Math.ceil(fullSynth.bom.totalMachines / 95),
    Math.ceil(fullSynth.nets.length / 32),
  );
  const maxK = Math.max(64, Math.min(512, estMinK * 2));

  for (const t of spec.targets) {
    if (Number.isInteger(t.ratePerMin) && t.ratePerMin >= 2) {
      const n = t.ratePerMin;
      for (let d = 2; d <= maxK; d++) {
        if (n % d === 0) {
          candSet.add(d);
          const q = n / d;
          if (q >= 2 && q <= maxK) candSet.add(q);
        }
      }
    }
  }
  for (const s of smooth) candSet.add(s);
  if (estMinK > 32) {
    const dynamic = [
      estMinK,
      estMinK + (estMinK % 2),
      Math.ceil(estMinK * 1.25),
      Math.ceil(estMinK * 1.5),
      Math.ceil(estMinK * 2),
    ];
    for (const k of dynamic) {
      if (k >= 2 && k <= 512) candSet.add(k);
    }
  }

  const candidates = Array.from(candSet)
    .filter((k) => k >= 2 && k <= maxK)
    .sort((a, b) => a - b);

  const fullMachines = Math.max(1, fullSynth.bom.totalMachines);
  const scored: Array<{ k: number; feasible: boolean; penalty: number; score: number }> = [];

  for (const k of candidates) {
    const unitSynth = synthesizeDesign(scaleSpecTargets(spec, 1 / k, `1/${k} tile`), {
      forceBalancedOutputs: true,
    });
    const uNets = unitSynth.nets.length;
    const uMacros = countRecipeAndBalancerMacros(unitSynth);
    const uMachines = unitSynth.bom.totalMachines;

    const feasible = uNets <= 40 && uMacros <= 18 && uMachines <= 125;
    const machineOverhead = Math.max(0, (k * uMachines - fullMachines) / fullMachines);
    const score =
      machineOverhead * 4.0 +
      k * 0.03 +
      Math.max(0, uNets - 32) * 0.02 +
      (k >= 4 && k % 2 === 1 ? 0.08 : 0);
    const penalty =
      Math.max(0, uNets - 40) * 1.5 +
      Math.max(0, uMacros - 18) * 3.0 +
      Math.max(0, uMachines - 125) * 0.15;

    scored.push({ k, feasible, penalty, score });
  }

  const feasibleList = scored.filter((c) => c.feasible).sort((a, b) => a.score - b.score);
  if (feasibleList.length > 0) {
    return feasibleList.slice(0, 6).map((c) => c.k);
  }
  return scored
    .sort((a, b) => a.penalty - b.penalty || a.score - b.score)
    .slice(0, 6)
    .map((c) => c.k);
}

function mirrorMacroX(macro: PlacedMacro['macro']): PlacedMacro['macro'] {
  const W = macro.width;
  const entities: EntityInstance[] = macro.entities.map((ent) => {
    const isDirectional =
      ent.role !== 'machine' &&
      ent.role !== 'pole-macro' &&
      ent.role !== 'pole-pdn' &&
      ent.role !== 'port-marker';
    return {
      ...ent,
      tx: W - (ent.tx + ent.w),
      direction: isDirectional ? flipDirX(ent.direction) : ent.direction,
      laneItems: ent.laneItems ? [ent.laneItems[1], ent.laneItems[0]] : undefined,
    };
  });

  const pins: MacroPin[] = macro.pins.map((pin) => {
    const newX = W - 1 - pin.x;
    const newDir = flipDirX(pin.direction);
    const { dx, dy } = dirDelta(newDir);
    const portX = pin.kind === 'input' ? newX - dx : newX + dx;
    const portY = pin.kind === 'input' ? pin.y - dy : pin.y + dy;
    return {
      ...pin,
      x: newX,
      direction: newDir,
      portX,
      portY,
    };
  });

  const powerTargets = macro.powerTargets.map((pt) => ({
    tx: W - (pt.tx + pt.w),
    ty: pt.ty,
    w: pt.w,
    h: pt.h,
  }));

  return {
    ...macro,
    entities,
    pins,
    powerTargets,
  };
}

interface TileData {
  synthesis: SynthesisResult;
  floorplan: FloorplanResult;
  route: RouteResult;
  pdn: PipelineResult['pdn'];
  bom: PipelineResult['bom'];
}

function mirrorUnitTileX(unit: TileData): TileData {
  const uW = unit.floorplan.width;

  const macros: PlacedMacro[] = unit.floorplan.macros.map((pm) => {
    const mirroredMacro = mirrorMacroX(pm.macro);
    return {
      ...pm,
      x: uW - (pm.x + pm.macro.width),
      macro: mirroredMacro,
      variants: pm.variants.map(mirrorMacroX),
    };
  });

  const pins: PerimeterPin[] = unit.floorplan.pins.map((p) => {
    const nextEdge = p.edge === 'W' ? 'E' : p.edge === 'E' ? 'W' : p.edge;
    return {
      ...p,
      edge: nextEdge,
      x: uW - 1 - p.x,
      dir: flipDirX(p.dir),
    };
  });

  const routeEntities: EntityInstance[] = unit.route.entities.map((e) => ({
    ...e,
    tx: uW - (e.tx + e.w),
    direction: flipDirX(e.direction),
    laneItems: e.laneItems ? [e.laneItems[1], e.laneItems[0]] : undefined,
  }));

  const routedNets: RoutedNetSegment[] = unit.route.routedNets.map((rn) => ({
    ...rn,
    tiles: rn.tiles.map((t) => ({
      ...t,
      tx: uW - 1 - t.tx,
      dir: flipDirX(t.dir),
    })),
  }));

  const pdnEntities: EntityInstance[] = unit.pdn.entities.map((e) => ({
    ...e,
    tx: uW - (e.tx + e.w),
  }));

  return {
    synthesis: unit.synthesis,
    floorplan: {
      ...unit.floorplan,
      macros,
      pins,
    },
    route: {
      ...unit.route,
      entities: routeEntities,
      routedNets,
    },
    pdn: {
      ...unit.pdn,
      entities: pdnEntities,
    },
    bom: unit.bom,
  };
}

interface TrunkSpec {
  pinTemplate: PerimeterPin;
  groupCap: number;
  groups: number[][]; // arrays of row indices in this column
  trunkIdx: number;
}

function planTrunksForColumnPins(
  colPins: PerimeterPin[],
  rowCount: number,
  maxTrunks?: number,
): { trunks: TrunkSpec[]; consolidatedIds: Set<string> } {
  if (rowCount < 2) return { trunks: [], consolidatedIds: new Set() };

  const trunks: TrunkSpec[] = [];
  const consolidatedIds = new Set<string>();

  const ordered = [...colPins].sort((a, b) => a.y - b.y);
  for (const pin of ordered) {
    if (maxTrunks !== undefined && trunks.length >= maxTrunks) break;
    const beltCap = BELT_SPECS[pin.beltTier].itemsPerSec;
    const g = Math.floor((beltCap + 1e-6) / Math.max(1e-6, pin.ratePerSec));
    if (g < 2) continue;

    const groups: number[][] = [];
    for (let r = 0; r < rowCount; r += g) {
      const grp: number[] = [];
      for (let k = r; k < Math.min(rowCount, r + g); k++) grp.push(k);
      groups.push(grp);
    }
    const trunkIdx = trunks.length;
    trunks.push({ pinTemplate: pin, groupCap: g, groups, trunkIdx });
    consolidatedIds.add(pin.id);
  }

  return { trunks, consolidatedIds };
}

function addBeltEntity(
  list: EntityInstance[],
  id: string,
  beltTier: BeltTier,
  tx: number,
  ty: number,
  direction: Dir,
  netId: string | undefined,
  item: string,
): void {
  list.push({
    id,
    name: BELT_SPECS[beltTier].beltName,
    tx,
    ty,
    w: 1,
    h: 1,
    direction,
    netId,
    item,
    role: 'belt-route',
  });
}

function addSplitterEntity(
  list: EntityInstance[],
  id: string,
  beltTier: BeltTier,
  tx: number,
  ty: number,
  direction: Dir,
  item: string,
  macroId?: string,
): void {
  const isEW = direction === Dir.EAST || direction === Dir.WEST;
  list.push({
    id,
    name: BELT_SPECS[beltTier].splitterName,
    tx,
    ty,
    w: isEW ? 1 : 2,
    h: isEW ? 2 : 1,
    direction,
    item,
    macroId,
    role: 'balancer',
  });
}

function addUgPairHorizontal(
  list: EntityInstance[],
  idPrefix: string,
  beltTier: BeltTier,
  y: number,
  inX: number,
  outX: number,
  direction: Dir,
  netId: string | undefined,
  item: string,
): void {
  const ugName = BELT_SPECS[beltTier].undergroundName;
  list.push({
    id: `${idPrefix}:i`,
    name: ugName,
    tx: inX,
    ty: y,
    w: 1,
    h: 1,
    direction,
    type: 'input',
    netId,
    item,
    role: 'ug-route',
  });
  list.push({
    id: `${idPrefix}:o`,
    name: ugName,
    tx: outX,
    ty: y,
    w: 1,
    h: 1,
    direction,
    type: 'output',
    netId,
    item,
    role: 'ug-route',
  });
}

interface BusBuildContext {
  busEntities: EntityInstance[];
  outerPins: PerimeterPin[];
  nodes: SynthNode[];
  nets: SynthNet[];
  netCounter: number;
  entCounter: number;
  pinCounter: number;
  balCounter: number;
}

/**
 * Emits horizontal pass-through or underground hops from `startX` to `endX` inclusive
 * traveling `dir` (`Dir.EAST` has startX <= endX, `Dir.WEST` has startX >= endX).
 * Hopped trunk bases `[ugIn, c0, c1, ugOut]` use `jumpDist = 3` cleanly across all belt tiers.
 */
function emitHorizontalSpanWithHops(
  ctx: BusBuildContext,
  y: number,
  startX: number,
  endX: number,
  dir: Dir,
  beltTier: BeltTier,
  netId: string | undefined,
  item: string,
  trunksToHopCols: number[], // array of leftmost X of each 4-wide trunk `[col, col+1, col+2, col+3]`
): void {
  const hopSet = new Map<number, number>();
  for (const baseCol of trunksToHopCols) {
    if (dir === Dir.EAST) {
      hopSet.set(baseCol, baseCol + 3);
    } else {
      hopSet.set(baseCol + 3, baseCol);
    }
  }

  let x = startX;
  const step = dir === Dir.EAST ? 1 : -1;
  while (dir === Dir.EAST ? x <= endX : x >= endX) {
    const outX = hopSet.get(x);
    if (outX !== undefined) {
      addUgPairHorizontal(
        ctx.busEntities,
        `bus:ug:${ctx.entCounter++}`,
        beltTier,
        y,
        x,
        outX,
        dir,
        netId,
        item,
      );
      x = outX + step;
    } else {
      addBeltEntity(
        ctx.busEntities,
        `bus:b:${ctx.entCounter++}`,
        beltTier,
        x,
        y,
        dir,
        netId,
        item,
      );
      x += step;
    }
  }
}

/**
 * Builds deterministic West (EAST-flowing) or East (WEST-flowing) input bus strips for a column of `rows` tiles.
 * Rewrites `net.source` on `tileNets` so every tile net connects 1:1 with the outer/splitter bus node IDs.
 */
function buildInputBusForColumn(
  ctx: BusBuildContext,
  side: 'W' | 'E',
  unitInPins: PerimeterPin[],
  rowCount: number,
  uH: number,
  busOuterEdgeX: number,
  tileBoundaryAdjacentX: number,
  tilePrefixes: string[],
  tileInputNetByPrefixAndPinId: Map<string, SynthNet>,
): void {
  const { trunks, consolidatedIds } = planTrunksForColumnPins(unitInPins, rowCount);
  const flowDir = side === 'W' ? Dir.EAST : Dir.WEST;
  const step = side === 'W' ? 1 : -1;

  // Trunk base X (leftmost of 4 columns).
  // For 'W': trunk t owns [busOuterEdgeX + 1 + 4*t .. +4] so x=busOuterEdgeX holds the perimeter pin!
  // For 'E': trunk t owns [busOuterEdgeX - 4 - 4*t .. -1] so x=busOuterEdgeX holds the perimeter pin!
  const trunkBaseCol = (t: number) =>
    side === 'W' ? busOuterEdgeX + 1 + 4 * t : busOuterEdgeX - 4 - 4 * t;

  const trunkColsAll = trunks.map((tr) => trunkBaseCol(tr.trunkIdx));

  // 1. Consolidated multi-row trunks
  for (const trunk of trunks) {
    const base = trunkBaseCol(trunk.trunkIdx);
    const ugInX = side === 'W' ? base : base + 3;
    const c0 = side === 'W' ? base + 1 : base + 2;
    const c1 = side === 'W' ? base + 2 : base + 1;
    const ugOutX = side === 'W' ? base + 3 : base;
    const splitLeftX = Math.min(c0, c1);

    const outerTrunksToHop = trunks
      .filter((o) => o.trunkIdx < trunk.trunkIdx)
      .map((o) => trunkBaseCol(o.trunkIdx));
    const innerTrunksToHop = trunks
      .filter((o) => o.trunkIdx > trunk.trunkIdx)
      .map((o) => trunkBaseCol(o.trunkIdx));

    const yLocal = trunk.pinTemplate.y;
    const tier = trunk.pinTemplate.beltTier;
    const item = trunk.pinTemplate.item;
    const unitRate = trunk.pinTemplate.ratePerSec;

    for (let gIdx = 0; gIdx < trunk.groups.length; gIdx++) {
      const grp = trunk.groups[gIdx];
      if (grp.length === 1) {
        const r = grp[0];
        const y = r * uH + yLocal;
        const prefix = tilePrefixes[r];
        const tileNet = tileInputNetByPrefixAndPinId.get(`${prefix}:${trunk.pinTemplate.id}`);
        const netId = tileNet?.id;
        const busInId = `in:${item}:bus${ctx.pinCounter++}`;

        ctx.nodes.push({
          id: busInId,
          kind: 'primary-input',
          item,
          busIndex: ctx.pinCounter,
          ratePerSec: unitRate,
          beltTier: tier,
          pinId: busInId,
        });
        ctx.outerPins.push({
          id: busInId,
          busId: item,
          busIndex: ctx.pinCounter,
          kind: 'input',
          item,
          ratePerSec: unitRate,
          beltTier: tier,
          edge: side,
          offset: y,
          x: busOuterEdgeX,
          y,
          dir: flowDir,
          order: ctx.pinCounter,
          locked: false,
          netId,
        });
        if (tileNet) {
          tileNet.source = { nodeId: busInId, pinId: busInId, kind: 'source', item };
        }
        emitHorizontalSpanWithHops(
          ctx,
          y,
          busOuterEdgeX,
          tileBoundaryAdjacentX,
          flowDir,
          tier,
          netId,
          item,
          trunkColsAll,
        );
        continue;
      }

      // Multi-tile trunk chain: grp = [rStart .. rEnd]
      const rStart = grp[0];
      const y0 = rStart * uH + yLocal;
      const groupRate = grp.length * unitRate;
      const busInId = `in:${item}:bus${ctx.pinCounter++}`;
      const topBalId = `bal:tiler:in:${ctx.balCounter++}`;
      const mainNetId = `net:tiler:${ctx.netCounter++}:${item}`;

      ctx.nodes.push({
        id: busInId,
        kind: 'primary-input',
        item,
        busIndex: ctx.pinCounter,
        ratePerSec: groupRate,
        beltTier: tier,
        pinId: busInId,
      });
      ctx.outerPins.push({
        id: busInId,
        busId: item,
        busIndex: ctx.pinCounter,
        kind: 'input',
        item,
        ratePerSec: groupRate,
        beltTier: tier,
        edge: side,
        offset: y0,
        x: busOuterEdgeX,
        y: y0,
        dir: flowDir,
        order: ctx.pinCounter,
        locked: false,
        netId: mainNetId,
      });
      ctx.nodes.push({
        id: topBalId,
        kind: 'balancer-macro',
        item,
        inputs: 1,
        outputs: 2,
        beltTier: tier,
        totalRatePerSec: groupRate,
        templateId: 'builtin-1x2',
      } satisfies BalancerMacroSpec);

      ctx.nets.push({
        id: mainNetId,
        busId: `${item}:bus`,
        busIndex: ctx.netCounter,
        item,
        ratePerSec: groupRate,
        beltTier: tier,
        source: { nodeId: busInId, pinId: busInId, kind: 'source', item },
        sink: { nodeId: topBalId, pinId: 'in:0', kind: 'sink', item },
      });

      // Route perimeter pin -> (ugInX, y0) hopping over outer trunks
      emitHorizontalSpanWithHops(
        ctx,
        y0,
        busOuterEdgeX,
        ugInX,
        flowDir,
        tier,
        mainNetId,
        item,
        outerTrunksToHop,
      );

      // Top 1x2 splitter at (c0, y0)
      addSplitterEntity(
        ctx.busEntities,
        `bus:sp:${ctx.entCounter++}`,
        tier,
        c0,
        y0,
        flowDir,
        item,
        topBalId,
      );

      // Top splitter top output -> tile rStart across inner trunks
      const prefix0 = tilePrefixes[rStart];
      const tileNet0 = tileInputNetByPrefixAndPinId.get(`${prefix0}:${trunk.pinTemplate.id}`);
      if (tileNet0) {
        tileNet0.source = { nodeId: topBalId, pinId: 'out:0', kind: 'source', item };
      }
      emitHorizontalSpanWithHops(
        ctx,
        y0,
        c1,
        tileBoundaryAdjacentX,
        flowDir,
        tier,
        tileNet0?.id,
        item,
        innerTrunksToHop,
      );

      // Loop trunk downward from top splitter bottom output (c1, y0 + 1) -> c0
      const oppFlowDir = flipDirX(flowDir);
      let prevBalId = topBalId;
      let remRate = groupRate - unitRate;
      const lastNextNetId =
        grp.length === 2
          ? tileInputNetByPrefixAndPinId.get(`${tilePrefixes[grp[1]]}:${trunk.pinTemplate.id}`)?.id
          : undefined;
      let trunkDownNetId = lastNextNetId ?? `net:tiler:${ctx.netCounter++}:${item}`;

      // Jog: (c1, y0 + 1) SOUTH -> (c1, y0 + 2) oppFlow -> (c0, y0 + 2) SOUTH
      addBeltEntity(
        ctx.busEntities,
        `bus:b:${ctx.entCounter++}`,
        tier,
        c1,
        y0 + 1,
        Dir.SOUTH,
        trunkDownNetId,
        item,
      );
      addBeltEntity(
        ctx.busEntities,
        `bus:b:${ctx.entCounter++}`,
        tier,
        c1,
        y0 + 2,
        oppFlowDir,
        trunkDownNetId,
        item,
      );
      addBeltEntity(
        ctx.busEntities,
        `bus:b:${ctx.entCounter++}`,
        tier,
        c0,
        y0 + 2,
        Dir.SOUTH,
        trunkDownNetId,
        item,
      );

      let prevY = y0 + 2;
      for (let idx = 1; idx < grp.length; idx++) {
        const r = grp[idx];
        const yr = r * uH + yLocal;
        const prefix = tilePrefixes[r];
        const tileNet = tileInputNetByPrefixAndPinId.get(`${prefix}:${trunk.pinTemplate.id}`);

        if (idx < grp.length - 1) {
          // Intermediate tile: place 2x1 SOUTH splitter at (splitLeftX, yr - 1)
          for (let y = prevY + 1; y <= yr - 2; y++) {
            addBeltEntity(
              ctx.busEntities,
              `bus:b:${ctx.entCounter++}`,
              tier,
              c0,
              y,
              Dir.SOUTH,
              trunkDownNetId,
              item,
            );
          }

          const tapBalId = `bal:tiler:in:${ctx.balCounter++}`;
          ctx.nodes.push({
            id: tapBalId,
            kind: 'balancer-macro',
            item,
            inputs: 1,
            outputs: 2,
            beltTier: tier,
            totalRatePerSec: remRate,
            templateId: 'builtin-1x2',
          } satisfies BalancerMacroSpec);

          ctx.nets.push({
            id: trunkDownNetId,
            busId: `${item}:bus`,
            busIndex: ctx.netCounter,
            item,
            ratePerSec: remRate,
            beltTier: tier,
            source: { nodeId: prevBalId, pinId: 'out:1', kind: 'source', item },
            sink: { nodeId: tapBalId, pinId: 'in:0', kind: 'sink', item },
          });

          addSplitterEntity(
            ctx.busEntities,
            `bus:sp:${ctx.entCounter++}`,
            tier,
            splitLeftX,
            yr - 1,
            Dir.SOUTH,
            item,
            tapBalId,
          );

          // Inner port (c1, yr) turns into tile r
          if (tileNet) {
            tileNet.source = { nodeId: tapBalId, pinId: 'out:0', kind: 'source', item };
          }
          addBeltEntity(
            ctx.busEntities,
            `bus:b:${ctx.entCounter++}`,
            tier,
            c1,
            yr,
            flowDir,
            tileNet?.id,
            item,
          );
          emitHorizontalSpanWithHops(
            ctx,
            yr,
            ugOutX,
            tileBoundaryAdjacentX,
            flowDir,
            tier,
            tileNet?.id,
            item,
            innerTrunksToHop,
          );

          // Outer port (c0, yr) continues SOUTH down trunk
          prevBalId = tapBalId;
          remRate -= unitRate;
          const nextIsLast = idx === grp.length - 2;
          const nextLastNetId = nextIsLast
            ? tileInputNetByPrefixAndPinId.get(
                `${tilePrefixes[grp[idx + 1]]}:${trunk.pinTemplate.id}`,
              )?.id
            : undefined;
          trunkDownNetId = nextLastNetId ?? `net:tiler:${ctx.netCounter++}:${item}`;
          addBeltEntity(
            ctx.busEntities,
            `bus:b:${ctx.entCounter++}`,
            tier,
            c0,
            yr,
            Dir.SOUTH,
            trunkDownNetId,
            item,
          );
          prevY = yr;
        } else {
          // Last tile in group: trunk flows straight down to (c0, yr) -> (c1, yr) -> tile r
          for (let y = prevY + 1; y < yr; y++) {
            addBeltEntity(
              ctx.busEntities,
              `bus:b:${ctx.entCounter++}`,
              tier,
              c0,
              y,
              Dir.SOUTH,
              trunkDownNetId,
              item,
            );
          }
          if (tileNet) {
            tileNet.source = { nodeId: prevBalId, pinId: 'out:1', kind: 'source', item };
          }
          addBeltEntity(
            ctx.busEntities,
            `bus:b:${ctx.entCounter++}`,
            tier,
            c0,
            yr,
            flowDir,
            trunkDownNetId,
            item,
          );
          addBeltEntity(
            ctx.busEntities,
            `bus:b:${ctx.entCounter++}`,
            tier,
            c1,
            yr,
            flowDir,
            trunkDownNetId,
            item,
          );
          emitHorizontalSpanWithHops(
            ctx,
            yr,
            ugOutX,
            tileBoundaryAdjacentX,
            flowDir,
            tier,
            trunkDownNetId,
            item,
            innerTrunksToHop,
          );
        }
      }
    }
  }

  // 2. Non-consolidated high-rate input pins pass straight through across all trunks
  for (const pin of unitInPins) {
    if (consolidatedIds.has(pin.id)) continue;
    for (let r = 0; r < rowCount; r++) {
      const y = r * uH + pin.y;
      const prefix = tilePrefixes[r];
      const tileNet = tileInputNetByPrefixAndPinId.get(`${prefix}:${pin.id}`);
      const busInId = `in:${pin.item}:bus${ctx.pinCounter++}`;

      ctx.nodes.push({
        id: busInId,
        kind: 'primary-input',
        item: pin.item,
        busIndex: ctx.pinCounter,
        ratePerSec: pin.ratePerSec,
        beltTier: pin.beltTier,
        pinId: busInId,
      });
      ctx.outerPins.push({
        id: busInId,
        busId: pin.item,
        busIndex: ctx.pinCounter,
        kind: 'input',
        item: pin.item,
        ratePerSec: pin.ratePerSec,
        beltTier: pin.beltTier,
        edge: side,
        offset: y,
        x: busOuterEdgeX,
        y,
        dir: flowDir,
        order: ctx.pinCounter,
        locked: false,
        netId: tileNet?.id,
      });
      if (tileNet) {
        tileNet.source = { nodeId: busInId, pinId: busInId, kind: 'source', item: pin.item };
      }
      emitHorizontalSpanWithHops(
        ctx,
        y,
        busOuterEdgeX,
        tileBoundaryAdjacentX,
        flowDir,
        pin.beltTier,
        tileNet?.id,
        pin.item,
        trunkColsAll,
      );
    }
  }
  void step;
}

/**
 * Emits a vertical SOUTH collector column merging `rowCount` wing outputs (`rowCount <= g`)
 * onto a single column `trunkColC1` (with feeder turn at `trunkColC0`), returning `(c1, bottomY)`
 * and the `SynthNode` / `SynthNet` feeding downstream.
 */
function buildWingOutputCollector(
  ctx: BusBuildContext,
  flowInDir: Dir, // Dir.EAST for left wing, Dir.WEST for right wing
  trunk: TrunkSpec,
  rowCount: number,
  uH: number,
  tileStartAdjacentX: number, // first tile-adjacent X outside wing
  baseColX: number, // leftmost of the 4 columns `[col, col+1, col+2, col+3]`
  innerTrunksToHopCols: number[], // trunks lying between wing and this trunk
  targetBottomY: number, // extend vertical c1 belt down to this Y inclusive
  tilePrefixes: string[],
  tileOutputNetByPrefixAndPinId: Map<string, SynthNet>,
): { exitX: number; exitNetId: string; lastNodeId: string; ratePerSec: number; beltTier: BeltTier } {
  const ugInCol = flowInDir === Dir.EAST ? baseColX : baseColX + 3;
  const c0 = flowInDir === Dir.EAST ? baseColX + 1 : baseColX + 2;
  const c1 = flowInDir === Dir.EAST ? baseColX + 2 : baseColX + 1;
  const splitLeftX = Math.min(c0, c1);
  const item = trunk.pinTemplate.item;
  const tier = trunk.pinTemplate.beltTier;
  const unitRate = trunk.pinTemplate.ratePerSec;
  const yLocal = trunk.pinTemplate.y;

  const y0 = 0 * uH + yLocal;
  const prefix0 = tilePrefixes[0];
  const tileNet0 = tileOutputNetByPrefixAndPinId.get(`${prefix0}:${trunk.pinTemplate.id}`)!;

  // Hop from tile edge across inner trunks to ugInCol (stopping before c0)
  emitHorizontalSpanWithHops(
    ctx,
    y0,
    tileStartAdjacentX,
    ugInCol,
    flowInDir,
    tier,
    tileNet0.id,
    item,
    innerTrunksToHopCols,
  );
  addBeltEntity(ctx.busEntities, `bus:b:${ctx.entCounter++}`, tier, c0, y0, flowInDir, tileNet0.id, item);
  addBeltEntity(ctx.busEntities, `bus:b:${ctx.entCounter++}`, tier, c1, y0, Dir.SOUTH, tileNet0.id, item);

  let curRate = unitRate;
  let curNet = tileNet0;
  let prevMergeBalId = '';
  let lastY = y0;

  for (let r = 1; r < rowCount; r++) {
    const yr = r * uH + yLocal;
    const prefixR = tilePrefixes[r];
    const tileNetR = tileOutputNetByPrefixAndPinId.get(`${prefixR}:${trunk.pinTemplate.id}`)!;

    // Carry accumulated trunk down c1 from lastY + 1 .. yr
    for (let y = lastY + 1; y <= yr; y++) {
      addBeltEntity(ctx.busEntities, `bus:b:${ctx.entCounter++}`, tier, c1, y, Dir.SOUTH, curNet.id, item);
    }

    // Bring row r horizontally across inner trunks to c0, turn SOUTH at (c0, yr)
    emitHorizontalSpanWithHops(
      ctx,
      yr,
      tileStartAdjacentX,
      ugInCol,
      flowInDir,
      tier,
      tileNetR.id,
      item,
      innerTrunksToHopCols,
    );
    addBeltEntity(ctx.busEntities, `bus:b:${ctx.entCounter++}`, tier, c0, yr, Dir.SOUTH, tileNetR.id, item);

    // 2x1 SOUTH merger splitter at (splitLeftX, yr + 1) — only c1 exits SOUTH so 100% merges 50/50!
    const mergeBalId = `bal:tiler:out:${ctx.balCounter++}`;
    curRate += unitRate;
    ctx.nodes.push({
      id: mergeBalId,
      kind: 'balancer-macro',
      item,
      inputs: 2,
      outputs: 1,
      beltTier: tier,
      totalRatePerSec: curRate,
      templateId: 'builtin-2x1',
    } satisfies BalancerMacroSpec);

    curNet.sink = { nodeId: mergeBalId, pinId: 'in:0', kind: 'sink', item };
    tileNetR.sink = { nodeId: mergeBalId, pinId: 'in:1', kind: 'sink', item };

    addSplitterEntity(
      ctx.busEntities,
      `bus:sp:${ctx.entCounter++}`,
      tier,
      splitLeftX,
      yr + 1,
      Dir.SOUTH,
      item,
      mergeBalId,
    );

    const nextNetId = `net:tiler:${ctx.netCounter++}:${item}`;
    const nextNet: SynthNet = {
      id: nextNetId,
      busId: `${item}:out`,
      busIndex: ctx.netCounter,
      item,
      ratePerSec: curRate,
      beltTier: tier,
      source: { nodeId: mergeBalId, pinId: 'out:0', kind: 'source', item },
      sink: { nodeId: 'out:pending', pinId: 'out:pending', kind: 'sink', item },
    };
    ctx.nets.push(nextNet);
    addBeltEntity(ctx.busEntities, `bus:b:${ctx.entCounter++}`, tier, c1, yr + 2, Dir.SOUTH, nextNetId, item);

    curNet = nextNet;
    prevMergeBalId = mergeBalId;
    lastY = yr + 2;
  }

  // Extend trunk straight South down c1 to targetBottomY
  for (let y = lastY + 1; y <= targetBottomY; y++) {
    addBeltEntity(ctx.busEntities, `bus:b:${ctx.entCounter++}`, tier, c1, y, Dir.SOUTH, curNet.id, item);
  }

  return {
    exitX: c1,
    exitNetId: curNet.id,
    lastNodeId: prevMergeBalId || curNet.source.nodeId,
    ratePerSec: curRate,
    beltTier: tier,
  };
}

interface TiledGridPlan {
  bayCount: number;
  layout: 'stack' | 'twin';
  desiredUnitAr: number;
}

function clampNum(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function planTiledGridGeometry(
  K: number,
  reqArRaw: number,
  prefLayout: 'auto' | 'stack' | 'twin',
): TiledGridPlan {
  const reqAr = clampNum(reqArRaw || 1.35, 0.2, 5.0);
  if (prefLayout === 'stack' || K < 2) {
    return {
      bayCount: 1,
      layout: 'stack',
      desiredUnitAr: clampNum(reqAr * K - 0.12, 0.55, 2.5),
    };
  }

  let bestScore = Infinity;
  let best: TiledGridPlan = { bayCount: 1, layout: K >= 4 ? 'twin' : 'stack', desiredUnitAr: 1.1 };

  const evalCand = (
    bayCount: number,
    layout: 'stack' | 'twin',
    cols: number,
    rows: number,
  ) => {
    const busFactor = layout === 'twin' ? 0.38 : 0.16;
    const rawUnitAr =
      layout === 'twin'
        ? (reqAr * (rows / bayCount) - busFactor) / 2
        : reqAr * rows - busFactor;
    const desiredUnitAr = clampNum(rawUnitAr, 0.55, 2.5);
    const predAr =
      layout === 'twin'
        ? ((2 * desiredUnitAr + busFactor) * bayCount) / rows
        : (desiredUnitAr + busFactor) / rows;
    const arErr = Math.abs(Math.log(Math.max(0.05, predAr / reqAr)));
    const unitDev = 0.08 * Math.abs(Math.log(desiredUnitAr / 1.35));
    const remPen = bayCount > 1 && K % bayCount !== 0 ? 0.12 : 0;
    const stackPen = layout === 'stack' ? 0.08 : 0;
    const score = arErr + unitDev + remPen + stackPen;
    if (score < bestScore) {
      bestScore = score;
      best = { bayCount, layout, desiredUnitAr };
    }
  };

  if (prefLayout === 'auto') {
    evalCand(1, 'stack', 1, K);
  }

  const maxBays = Math.floor(K / 2);
  for (let G = 1; G <= maxBays; G++) {
    const maxBayK = Math.ceil(K / G);
    const rows = Math.ceil(maxBayK / 2);
    if (G === 1 && prefLayout === 'auto' && K < 4) continue;
    evalCand(G, 'twin', 2 * G, rows);
  }

  return best;
}

function pickBestBayCountForCompiledUnit(
  K: number,
  uW: number,
  uH: number,
  unitInPins: PerimeterPin[],
  unitOutPins: PerimeterPin[],
  maxRowCapOut: number,
  reqArRaw: number,
  prefLayout: 'auto' | 'stack' | 'twin',
): { bayCount: number; layout: 'stack' | 'twin' } {
  const reqAr = clampNum(reqArRaw || 1.35, 0.2, 5.0);
  if (prefLayout === 'stack' || K < 2) {
    return { bayCount: 1, layout: 'stack' };
  }

  const canSingleTwin =
    unitOutPins.length >= 1 &&
    unitOutPins.length <= 2 &&
    Math.ceil(K / 2) <= maxRowCapOut;
  if (prefLayout === 'auto' && !canSingleTwin && Math.ceil(Math.ceil(K / 2) / 2) > maxRowCapOut) {
    return { bayCount: 1, layout: 'stack' };
  }

  let bestScore = Infinity;
  let bestPlan: { bayCount: number; layout: 'stack' | 'twin' } = {
    bayCount: 1,
    layout: prefLayout === 'twin' || (K >= 4 && canSingleTwin) ? 'twin' : 'stack',
  };

  const estBayFootprint = (kBay: number, layout: 'stack' | 'twin') => {
    const rL = layout === 'twin' ? Math.ceil(kBay / 2) : kBay;
    const rR = layout === 'twin' ? Math.floor(kBay / 2) : 0;
    const wPlan = planTrunksForColumnPins(unitInPins, rL);
    const westW = wPlan.trunks.length === 0 ? 0 : 1 + 4 * wPlan.trunks.length;
    const ePlan = rR > 0 ? planTrunksForColumnPins(unitInPins, rR) : { trunks: [] };
    const eastW = ePlan.trunks.length === 0 ? 0 : 1 + 4 * ePlan.trunks.length;
    const spW = layout === 'twin' ? 8 * unitOutPins.length : 4 * unitOutPins.length;
    const w = layout === 'twin' ? westW + 2 * uW + spW + eastW : westW + uW + spW;
    const h = rL * uH + (layout === 'twin' ? 7 : 4);
    return { w, h };
  };

  if (prefLayout === 'auto') {
    const f = estBayFootprint(K, 'stack');
    const err = Math.abs(Math.log(Math.max(0.05, f.w / Math.max(1, f.h) / reqAr)));
    const sc = err + 0.08;
    if (sc < bestScore) {
      bestScore = sc;
      bestPlan = { bayCount: 1, layout: 'stack' };
    }
  }

  const maxBays = Math.floor(K / 2);
  for (let G = 1; G <= maxBays; G++) {
    if (G === 1 && prefLayout === 'auto' && K < 4) continue;
    if (unitOutPins.length < 1 || unitOutPins.length > 2) break;
    const maxBayK = Math.ceil(K / G);
    const maxBayRows = Math.ceil(maxBayK / 2);
    if (maxBayRows > maxRowCapOut) continue;

    let sumW = (G - 1) * 6;
    let maxH = 1;
    const base = Math.floor(K / G);
    const rem = K % G;
    for (let g = 0; g < G; g++) {
      const kBay = base + (g < rem ? 1 : 0);
      const f = estBayFootprint(kBay, 'twin');
      sumW += f.w;
      maxH = Math.max(maxH, f.h);
    }
    const ar = sumW / Math.max(1, maxH);
    const err = Math.abs(Math.log(Math.max(0.05, ar / reqAr)));
    const remPen = rem !== 0 ? 0.08 : 0;
    const sc = err + remPen;
    if (sc < bestScore) {
      bestScore = sc;
      bestPlan = { bayCount: G, layout: 'twin' };
    }
  }

  return bestPlan;
}

interface BuiltBayLayout {
  W: number;
  H: number;
  cols: number;
  rows: number;
  layout: 'stack' | 'twin';
  nodes: SynthNode[];
  nets: SynthNet[];
  macros: PlacedMacro[];
  routeEntities: EntityInstance[];
  routedNets: RoutedNetSegment[];
  pdnEntities: EntityInstance[];
  outerPins: PerimeterPin[];
}

function buildSingleBayLayout(
  unit: TileData,
  mirroredUnit: TileData | null,
  unitInPins: PerimeterPin[],
  unitOutPins: PerimeterPin[],
  K: number,
  layout: 'stack' | 'twin',
): BuiltBayLayout {
  const uW = unit.floorplan.width;
  const uH = unit.floorplan.height;
  const rowsLeft = layout === 'twin' ? Math.ceil(K / 2) : K;
  const rowsRight = layout === 'twin' ? Math.floor(K / 2) : 0;

  // Plan West & East consolidated buses
  const westPlan = planTrunksForColumnPins(unitInPins, rowsLeft);
  const westBusW = westPlan.trunks.length === 0 ? 0 : 1 + 4 * westPlan.trunks.length;

  let eastPlan = { trunks: [] as TrunkSpec[], consolidatedIds: new Set<string>() };
  let eastBusW = 0;

  if (layout === 'twin' && rowsRight > 0 && mirroredUnit) {
    const rightInPins = mirroredUnit.floorplan.pins
      .filter((p) => p.kind === 'input' && p.edge === 'E')
      .sort((a, b) => a.y - b.y);
    eastPlan = planTrunksForColumnPins(rightInPins, rowsRight);
    eastBusW = eastPlan.trunks.length === 0 ? 0 : 1 + 4 * eastPlan.trunks.length;
  }

  // Output collector plan
  let outTrunksCount = 0;
  let stackHasEastPassThrough = false;
  if (layout === 'twin') {
    outTrunksCount = unitOutPins.length;
  } else {
    const outPlan = planTrunksForColumnPins(unitOutPins, rowsLeft);
    // Only consolidate outputs in 1xK stack if all K tiles fit cleanly on 1 collector trunk per item
    const singleGroupTrunks = outPlan.trunks.filter((t) => t.groups.length === 1);
    outTrunksCount = singleGroupTrunks.length;
    stackHasEastPassThrough = outTrunksCount < unitOutPins.length;
  }

  const spineW =
    layout === 'twin'
      ? 8 * outTrunksCount
      : outTrunksCount > 0
        ? 4 * outTrunksCount + (stackHasEastPassThrough ? 1 : 0)
        : 0;

  const leftTilesX = westBusW;
  const spineX0 = leftTilesX + uW;
  const rightTilesX = spineX0 + spineW;
  const eastBusStartX = rightTilesX + (rowsRight > 0 ? uW : 0);
  const W = layout === 'twin' ? eastBusStartX + eastBusW : rightTilesX;

  const needsBottomCollector = outTrunksCount > 0;
  const bottomMargin =
    layout === 'twin'
      ? 7 + (outTrunksCount > 1 ? 4 : 0)
      : needsBottomCollector
        ? 4
        : 0;
  const H = rowsLeft * uH + bottomMargin;

  // Build stamped nodes, nets, macros, and route segments for all K tiles
  const ctx: BusBuildContext = {
    busEntities: [],
    outerPins: [],
    nodes: [],
    nets: [],
    netCounter: 0,
    entCounter: 0,
    pinCounter: 0,
    balCounter: 0,
  };

  const stampedMacros: PlacedMacro[] = [];
  const stampedRouteEntities: EntityInstance[] = [];
  const stampedRoutedNets: RoutedNetSegment[] = [];
  const stampedPdnEntities: EntityInstance[] = [];

  const leftPrefixes: string[] = [];
  const rightPrefixes: string[] = [];
  const tileInputNetByKey = new Map<string, SynthNet>();
  const tileOutputNetByKey = new Map<string, SynthNet>();

  const stampOneTile = (
    tile: TileData,
    tileIdx: number,
    ox: number,
    oy: number,
    isTwinInternalOut: boolean,
  ): string => {
    const prefix = `t${tileIdx}`;
    const pinNetIds = new Map<string, string>();
    for (const p of tile.floorplan.pins) {
      if (p.netId) pinNetIds.set(p.id, `${prefix}:${p.netId}`);
    }

    for (const n of tile.synthesis.nodes) {
      if (n.kind === 'primary-input' || n.kind === 'primary-output') {
        continue; // replaced by bus or top-level outer pins
      }
      ctx.nodes.push({
        ...n,
        id: `${prefix}:${n.id}`,
      });
    }

    for (const net of tile.synthesis.nets) {
      const prefixedNet: SynthNet = {
        ...net,
        id: `${prefix}:${net.id}`,
        source: net.source.nodeId.startsWith('in:')
          ? { ...net.source }
          : { ...net.source, nodeId: `${prefix}:${net.source.nodeId}` },
        sink: net.sink.nodeId.startsWith('out:')
          ? { ...net.sink }
          : { ...net.sink, nodeId: `${prefix}:${net.sink.nodeId}` },
      };
      ctx.nets.push(prefixedNet);
      if (net.source.nodeId.startsWith('in:')) {
        tileInputNetByKey.set(`${prefix}:${net.source.nodeId}`, prefixedNet);
      }
      if (net.sink.nodeId.startsWith('out:')) {
        tileOutputNetByKey.set(`${prefix}:${net.sink.nodeId}`, prefixedNet);
      }
    }

    for (const pm of tile.floorplan.macros) {
      const newMacroId = `${prefix}:${pm.id}`;
      stampedMacros.push({
        id: newMacroId,
        x: ox + pm.x,
        y: oy + pm.y,
        locked: false,
        macro: {
          ...pm.macro,
          id: newMacroId,
          entities: pm.macro.entities.map((e) => ({
            ...e,
            macroId: e.macroId ? newMacroId : undefined,
          })),
        },
        variants: pm.variants,
      });
    }

    for (const e of tile.route.entities) {
      if (isTwinInternalOut && e.id.startsWith('pin-stub:out:')) {
        // Internal tile output stubs remain belts feeding center spine with prefixed netId
      }
      stampedRouteEntities.push({
        ...e,
        id: `${prefix}:${e.id}`,
        tx: ox + e.tx,
        ty: oy + e.ty,
        netId: e.netId ? `${prefix}:${e.netId}` : undefined,
      });
    }

    for (const rn of tile.route.routedNets) {
      stampedRoutedNets.push({
        ...rn,
        netId: `${prefix}:${rn.netId}`,
        tiles: rn.tiles.map((t) => ({ ...t, tx: ox + t.tx, ty: oy + t.ty })),
      });
    }

    for (const pe of tile.pdn.entities) {
      stampedPdnEntities.push({
        ...pe,
        id: `${prefix}:${pe.id}`,
        tx: ox + pe.tx,
        ty: oy + pe.ty,
      });
    }

    void pinNetIds;
    return prefix;
  };

  for (let r = 0; r < rowsLeft; r++) {
    const p = stampOneTile(unit, r, leftTilesX, r * uH, outTrunksCount > 0);
    leftPrefixes.push(p);
  }
  for (let r = 0; r < rowsRight; r++) {
    const p = stampOneTile(mirroredUnit!, rowsLeft + r, rightTilesX, r * uH, true);
    rightPrefixes.push(p);
  }

  // Build West input bus strip
  if (westBusW > 0) {
    buildInputBusForColumn(
      ctx,
      'W',
      unitInPins,
      rowsLeft,
      uH,
      0,
      leftTilesX - 1,
      leftPrefixes,
      tileInputNetByKey,
    );
  } else {
    // Direct West perimeter input pins (no consolidation trunks)
    for (let r = 0; r < rowsLeft; r++) {
      const prefix = leftPrefixes[r];
      for (const pin of unitInPins) {
        const y = r * uH + pin.y;
        const net = tileInputNetByKey.get(`${prefix}:${pin.id}`);
        const newPinId = `in:${pin.item}:${r}:${pin.busIndex}`;
        ctx.nodes.push({
          id: newPinId,
          kind: 'primary-input',
          item: pin.item,
          busIndex: ctx.pinCounter++,
          ratePerSec: pin.ratePerSec,
          beltTier: pin.beltTier,
          pinId: newPinId,
        } satisfies SynthInputNode);
        if (net) net.source = { nodeId: newPinId, pinId: newPinId, kind: 'source', item: pin.item };
        ctx.outerPins.push({
          ...pin,
          id: newPinId,
          busIndex: ctx.pinCounter,
          offset: y,
          x: 0,
          y,
          netId: net?.id,
        });
      }
    }
  }

  // Build East input bus strip (for Twin-Wing Right column)
  if (layout === 'twin' && rowsRight > 0 && mirroredUnit) {
    const rightInPins = mirroredUnit.floorplan.pins
      .filter((p) => p.kind === 'input' && p.edge === 'E')
      .sort((a, b) => a.y - b.y);
    if (eastBusW > 0) {
      buildInputBusForColumn(
        ctx,
        'E',
        rightInPins,
        rowsRight,
        uH,
        W - 1,
        rightTilesX + uW,
        rightPrefixes,
        tileInputNetByKey,
      );
    } else {
      for (let r = 0; r < rowsRight; r++) {
        const prefix = rightPrefixes[r];
        for (const pin of rightInPins) {
          const y = r * uH + pin.y;
          const net = tileInputNetByKey.get(`${prefix}:${pin.id}`);
          const newPinId = `in:${pin.item}:R${r}:${pin.busIndex}`;
          ctx.nodes.push({
            id: newPinId,
            kind: 'primary-input',
            item: pin.item,
            busIndex: ctx.pinCounter++,
            ratePerSec: pin.ratePerSec,
            beltTier: pin.beltTier,
            pinId: newPinId,
          } satisfies SynthInputNode);
          if (net) net.source = { nodeId: newPinId, pinId: newPinId, kind: 'source', item: pin.item };
          ctx.outerPins.push({
            ...pin,
            id: newPinId,
            busIndex: ctx.pinCounter,
            offset: y,
            x: W - 1,
            y,
            netId: net?.id,
          });
        }
      }
    }
  }

  // Build Output Collector (Stack East vs Twin Center Spine)
  if (layout === 'stack') {
    if (outTrunksCount === 0) {
      // Direct East edge outputs
      for (let r = 0; r < rowsLeft; r++) {
        const prefix = leftPrefixes[r];
        for (const pin of unitOutPins) {
          const y = r * uH + pin.y;
          const net = tileOutputNetByKey.get(`${prefix}:${pin.id}`);
          const newOutId = `out:${pin.item}:${r}:${pin.busIndex}`;
          ctx.nodes.push({
            id: newOutId,
            kind: 'primary-output',
            item: pin.item,
            busIndex: ctx.pinCounter++,
            ratePerSec: pin.ratePerSec,
            beltTier: pin.beltTier,
            pinId: newOutId,
          } satisfies SynthOutputNode);
          if (net) net.sink = { nodeId: newOutId, pinId: newOutId, kind: 'sink', item: pin.item };
          ctx.outerPins.push({
            ...pin,
            id: newOutId,
            busIndex: ctx.pinCounter,
            offset: y,
            x: W - 1,
            y,
            netId: net?.id,
          });
        }
      }
    } else {
      const outPlan = planTrunksForColumnPins(unitOutPins, rowsLeft);
      const consolidatedTrunks = outPlan.trunks.filter((t) => t.groups.length === 1);
      const consolidatedOutIds = new Set(consolidatedTrunks.map((t) => t.pinTemplate.id));
      const allOutTrunkCols = consolidatedTrunks.map((_, idx) => spineX0 + 4 * idx);
      const bottomY = H - 1;

      for (let idx = 0; idx < consolidatedTrunks.length; idx++) {
        const trunk = consolidatedTrunks[idx];
        const baseCol = spineX0 + 4 * idx;
        const innerHops = allOutTrunkCols.slice(0, idx);
        const leg = buildWingOutputCollector(
          ctx,
          Dir.EAST,
          trunk,
          rowsLeft,
          uH,
          spineX0,
          baseCol,
          innerHops,
          bottomY,
          leftPrefixes,
          tileOutputNetByKey,
        );
        const outPinId = `out:${trunk.pinTemplate.item}:0`;
        ctx.nodes.push({
          id: outPinId,
          kind: 'primary-output',
          item: trunk.pinTemplate.item,
          busIndex: ctx.pinCounter++,
          ratePerSec: leg.ratePerSec,
          beltTier: leg.beltTier,
          pinId: outPinId,
        } satisfies SynthOutputNode);
        const lastNet = ctx.nets.find((n) => n.id === leg.exitNetId);
        if (lastNet) {
          lastNet.sink = {
            nodeId: outPinId,
            pinId: outPinId,
            kind: 'sink',
            item: trunk.pinTemplate.item,
          };
        }
        ctx.outerPins.push({
          id: outPinId,
          busId: trunk.pinTemplate.item,
          busIndex: ctx.pinCounter,
          kind: 'output',
          item: trunk.pinTemplate.item,
          ratePerSec: leg.ratePerSec,
          beltTier: leg.beltTier,
          edge: 'S',
          offset: leg.exitX,
          x: leg.exitX,
          y: bottomY,
          dir: Dir.SOUTH,
          order: ctx.pinCounter,
          locked: false,
          netId: leg.exitNetId,
        });
      }

      // Pass through non-consolidated East outputs cleanly across all consolidated trunks
      for (const pin of unitOutPins) {
        if (consolidatedOutIds.has(pin.id)) continue;
        for (let r = 0; r < rowsLeft; r++) {
          const y = r * uH + pin.y;
          const prefix = leftPrefixes[r];
          const net = tileOutputNetByKey.get(`${prefix}:${pin.id}`);
          const newOutId = `out:${pin.item}:${r}:${pin.busIndex}`;
          ctx.nodes.push({
            id: newOutId,
            kind: 'primary-output',
            item: pin.item,
            busIndex: ctx.pinCounter++,
            ratePerSec: pin.ratePerSec,
            beltTier: pin.beltTier,
            pinId: newOutId,
          } satisfies SynthOutputNode);
          if (net) net.sink = { nodeId: newOutId, pinId: newOutId, kind: 'sink', item: pin.item };
          emitHorizontalSpanWithHops(
            ctx,
            y,
            spineX0,
            W - 1,
            Dir.EAST,
            pin.beltTier,
            net?.id,
            pin.item,
            allOutTrunkCols,
          );
          ctx.outerPins.push({
            ...pin,
            id: newOutId,
            busIndex: ctx.pinCounter,
            offset: y,
            x: W - 1,
            y,
            dir: Dir.EAST,
            netId: net?.id,
          });
        }
      }
    }
  } else {
    // Twin-Wing Center Spine Collector (1..2 output items mirrored to South edge)
    const rightOutPins = mirroredUnit!.floorplan.pins
      .filter((p) => p.kind === 'output' && p.edge === 'W')
      .sort((a, b) => a.y - b.y);
    const leftTrunks = planTrunksForColumnPins(unitOutPins, rowsLeft).trunks;
    const rightTrunks = planTrunksForColumnPins(rightOutPins, rowsRight).trunks;
    const leftTrunkByPinId = new Map(leftTrunks.map((tr) => [tr.pinTemplate.id, tr]));
    const rightTrunkByPinId = new Map(rightTrunks.map((tr) => [tr.pinTemplate.id, tr]));
    const T = unitOutPins.length;
    const maxYOutPin = Math.max(0, ...unitOutPins.map((p) => p.y));
    const baseMergeY = Math.max(rowsLeft * uH, (rowsLeft - 1) * uH + maxYOutPin + 3);

    const allLeftCols = Array.from({ length: T }, (_, idx) => spineX0 + 4 * idx);
    const allRightCols = Array.from({ length: T }, (_, idx) => spineX0 + 4 * T + 4 * (T - 1 - idx));

    const leftLegs: ReturnType<typeof buildWingOutputCollector>[] = [];
    const rightLegs: ReturnType<typeof buildWingOutputCollector>[] = [];

    for (let t = 0; t < T; t++) {
      const yStopLeft = t === 0 ? baseMergeY : baseMergeY + 2;
      const yStopRight = t === 0 ? baseMergeY : baseMergeY + 2;

      const lTrunk =
        leftTrunkByPinId.get(unitOutPins[t].id) ??
        ({
          pinTemplate: unitOutPins[t],
          groupCap: K,
          groups: [Array.from({ length: rowsLeft }, (_, i) => i)],
          trunkIdx: t,
        } satisfies TrunkSpec);

      leftLegs.push(
        buildWingOutputCollector(
          ctx,
          Dir.EAST,
          lTrunk,
          rowsLeft,
          uH,
          spineX0,
          spineX0 + 4 * t,
          allLeftCols.slice(0, t),
          yStopLeft,
          leftPrefixes,
          tileOutputNetByKey,
        ),
      );

      if (rowsRight > 0) {
        const rPin = rightOutPins[t];
        const rTrunk =
          rightTrunkByPinId.get(rPin.id) ??
          ({
            pinTemplate: rPin,
            groupCap: K,
            groups: [Array.from({ length: rowsRight }, (_, i) => i)],
            trunkIdx: t,
          } satisfies TrunkSpec);

        rightLegs.push(
          buildWingOutputCollector(
            ctx,
            Dir.WEST,
            rTrunk,
            rowsRight,
            uH,
            rightTilesX - 1,
            spineX0 + 4 * T + 4 * (T - 1 - t),
            allRightCols.slice(0, t),
            yStopRight,
            rightPrefixes,
            tileOutputNetByKey,
          ),
        );
      }
    }

    const canMerge = unitOutPins.map((p, t) => {
      const lLeg = leftLegs[t];
      const rLeg = rightLegs[t];
      if (!rLeg) return false;
      const beltCap = BELT_SPECS[p.beltTier].itemsPerSec;
      return lLeg.ratePerSec + rLeg.ratePerSec <= beltCap + 1e-4;
    });

    // Merge leftLegs[t] and rightLegs[t] onto bottom South edge pins
    for (let t = 0; t < T; t++) {
      const lLeg = leftLegs[t];
      const rLeg = rightLegs[t];
      const item = unitOutPins[t].item;
      const tier = unitOutPins[t].beltTier;
      const totalOutRate = lLeg.ratePerSec + (rLeg?.ratePerSec ?? 0);

      if (!canMerge[t] || (T === 2 && t === 0 && !canMerge[1])) {
        // Exit wings independently straight South
        for (const leg of rLeg ? [lLeg, rLeg] : [lLeg]) {
          const topY = t === 0 ? baseMergeY + 1 : baseMergeY + 3;
          for (let y = topY; y <= H - 1; y++) {
            addBeltEntity(ctx.busEntities, `bus:b:${ctx.entCounter++}`, tier, leg.exitX, y, Dir.SOUTH, leg.exitNetId, item);
          }
          const outPinId = `out:${item}:${ctx.pinCounter++}`;
          ctx.nodes.push({
            id: outPinId,
            kind: 'primary-output',
            item,
            busIndex: ctx.pinCounter,
            ratePerSec: leg.ratePerSec,
            beltTier: tier,
            pinId: outPinId,
          } satisfies SynthOutputNode);
          const net = ctx.nets.find((n) => n.id === leg.exitNetId);
          if (net) net.sink = { nodeId: outPinId, pinId: outPinId, kind: 'sink', item };
          ctx.outerPins.push({
            id: outPinId,
            busId: item,
            busIndex: ctx.pinCounter,
            kind: 'output',
            item,
            ratePerSec: leg.ratePerSec,
            beltTier: tier,
            edge: 'S',
            offset: leg.exitX,
            x: leg.exitX,
            y: H - 1,
            dir: Dir.SOUTH,
            order: ctx.pinCounter,
            locked: false,
            netId: leg.exitNetId,
          });
        }
        continue;
      }

      // Single consolidated 2x1 South merger splitter per output item!
      if (t === 0 && T === 1) {
        // leftExit = spineX0 + 2, rightExit = spineX0 + 5 -> splitter at (spineX0 + 3, baseMergeY + 1)
        const sLeftX = spineX0 + 3;
        const yM = baseMergeY;
        addBeltEntity(ctx.busEntities, `bus:b:${ctx.entCounter++}`, tier, sLeftX - 1, yM + 1, Dir.EAST, lLeg.exitNetId, item);
        addBeltEntity(ctx.busEntities, `bus:b:${ctx.entCounter++}`, tier, sLeftX, yM + 1, Dir.SOUTH, lLeg.exitNetId, item);
        addBeltEntity(ctx.busEntities, `bus:b:${ctx.entCounter++}`, tier, sLeftX + 2, yM + 1, Dir.WEST, rLeg.exitNetId, item);
        addBeltEntity(ctx.busEntities, `bus:b:${ctx.entCounter++}`, tier, sLeftX + 1, yM + 1, Dir.SOUTH, rLeg.exitNetId, item);

        const finalBalId = `bal:tiler:final:${ctx.balCounter++}`;
        ctx.nodes.push({
          id: finalBalId,
          kind: 'balancer-macro',
          item,
          inputs: 2,
          outputs: 1,
          beltTier: tier,
          totalRatePerSec: totalOutRate,
          templateId: 'builtin-2x1',
        } satisfies BalancerMacroSpec);
        addSplitterEntity(ctx.busEntities, `bus:sp:${ctx.entCounter++}`, tier, sLeftX, yM + 2, Dir.SOUTH, item, finalBalId);

        const lNet = ctx.nets.find((n) => n.id === lLeg.exitNetId);
        const rNet = ctx.nets.find((n) => n.id === rLeg.exitNetId);
        if (lNet) lNet.sink = { nodeId: finalBalId, pinId: 'in:0', kind: 'sink', item };
        if (rNet) rNet.sink = { nodeId: finalBalId, pinId: 'in:1', kind: 'sink', item };

        const finalNetId = `net:tiler:${ctx.netCounter++}:${item}`;
        const outPinId = `out:${item}:0`;
        ctx.nodes.push({
          id: outPinId,
          kind: 'primary-output',
          item,
          busIndex: ctx.pinCounter++,
          ratePerSec: totalOutRate,
          beltTier: tier,
          pinId: outPinId,
        } satisfies SynthOutputNode);
        ctx.nets.push({
          id: finalNetId,
          busId: `${item}:out`,
          busIndex: 0,
          item,
          ratePerSec: totalOutRate,
          beltTier: tier,
          source: { nodeId: finalBalId, pinId: 'out:0', kind: 'source', item },
          sink: { nodeId: outPinId, pinId: outPinId, kind: 'sink', item },
        });
        for (let y = yM + 3; y <= H - 1; y++) {
          addBeltEntity(ctx.busEntities, `bus:b:${ctx.entCounter++}`, tier, sLeftX, y, Dir.SOUTH, finalNetId, item);
        }
        ctx.outerPins.push({
          id: outPinId,
          busId: item,
          busIndex: ctx.pinCounter,
          kind: 'output',
          item,
          ratePerSec: totalOutRate,
          beltTier: tier,
          edge: 'S',
          offset: sLeftX,
          x: sLeftX,
          y: H - 1,
          dir: Dir.SOUTH,
          order: ctx.pinCounter,
          locked: false,
          netId: finalNetId,
        });
      } else if (t === 1) {
        // Inner pair when T = 2: leftExit = spineX0 + 6, rightExit = spineX0 + 9 -> merge onto col spineX0 + 6 (x=6,7 splitter)
        const sLeftX = spineX0 + 6;
        const yM = baseMergeY + 2;
        addBeltEntity(ctx.busEntities, `bus:b:${ctx.entCounter++}`, tier, sLeftX, yM + 1, Dir.SOUTH, lLeg.exitNetId, item);
        addBeltEntity(ctx.busEntities, `bus:b:${ctx.entCounter++}`, tier, sLeftX + 3, yM + 1, Dir.WEST, rLeg.exitNetId, item);
        addBeltEntity(ctx.busEntities, `bus:b:${ctx.entCounter++}`, tier, sLeftX + 2, yM + 1, Dir.WEST, rLeg.exitNetId, item);
        addBeltEntity(ctx.busEntities, `bus:b:${ctx.entCounter++}`, tier, sLeftX + 1, yM + 1, Dir.SOUTH, rLeg.exitNetId, item);

        const finalBalId = `bal:tiler:final:${ctx.balCounter++}`;
        ctx.nodes.push({
          id: finalBalId,
          kind: 'balancer-macro',
          item,
          inputs: 2,
          outputs: 1,
          beltTier: tier,
          totalRatePerSec: totalOutRate,
          templateId: 'builtin-2x1',
        } satisfies BalancerMacroSpec);
        addSplitterEntity(ctx.busEntities, `bus:sp:${ctx.entCounter++}`, tier, sLeftX, yM + 2, Dir.SOUTH, item, finalBalId);

        const lNet = ctx.nets.find((n) => n.id === lLeg.exitNetId);
        const rNet = ctx.nets.find((n) => n.id === rLeg.exitNetId);
        if (lNet) lNet.sink = { nodeId: finalBalId, pinId: 'in:0', kind: 'sink', item };
        if (rNet) rNet.sink = { nodeId: finalBalId, pinId: 'in:1', kind: 'sink', item };

        const finalNetId = `net:tiler:${ctx.netCounter++}:${item}`;
        const outPinId = `out:${item}:1`;
        ctx.nodes.push({
          id: outPinId,
          kind: 'primary-output',
          item,
          busIndex: ctx.pinCounter++,
          ratePerSec: totalOutRate,
          beltTier: tier,
          pinId: outPinId,
        } satisfies SynthOutputNode);
        ctx.nets.push({
          id: finalNetId,
          busId: `${item}:out`,
          busIndex: 1,
          item,
          ratePerSec: totalOutRate,
          beltTier: tier,
          source: { nodeId: finalBalId, pinId: 'out:0', kind: 'source', item },
          sink: { nodeId: outPinId, pinId: outPinId, kind: 'sink', item },
        });
        for (let y = yM + 3; y <= H - 1; y++) {
          addBeltEntity(ctx.busEntities, `bus:b:${ctx.entCounter++}`, tier, sLeftX, y, Dir.SOUTH, finalNetId, item);
        }
        ctx.outerPins.push({
          id: outPinId,
          busId: item,
          busIndex: ctx.pinCounter,
          kind: 'output',
          item,
          ratePerSec: totalOutRate,
          beltTier: tier,
          edge: 'S',
          offset: sLeftX,
          x: sLeftX,
          y: H - 1,
          dir: Dir.SOUTH,
          order: ctx.pinCounter,
          locked: false,
          netId: finalNetId,
        });
      } else {
        // Outer pair t === 0 when T = 2 merges strictly below t = 1's merger (baseMergeY + 5)
        const yM0 = baseMergeY + 5;
        for (let y = baseMergeY + 1; y < yM0; y++) {
          addBeltEntity(ctx.busEntities, `bus:b:${ctx.entCounter++}`, tier, lLeg.exitX, y, Dir.SOUTH, lLeg.exitNetId, item);
          addBeltEntity(ctx.busEntities, `bus:b:${ctx.entCounter++}`, tier, rLeg.exitX, y, Dir.SOUTH, rLeg.exitNetId, item);
        }
        // Left horizontal + hop over t=1 vertical spine at +6 -> +8 (SOUTH)
        addBeltEntity(ctx.busEntities, `bus:b:${ctx.entCounter++}`, tier, lLeg.exitX, yM0, Dir.EAST, lLeg.exitNetId, item);
        for (let x = lLeg.exitX + 1; x <= spineX0 + 4; x++) {
          addBeltEntity(ctx.busEntities, `bus:b:${ctx.entCounter++}`, tier, x, yM0, Dir.EAST, lLeg.exitNetId, item);
        }
        addUgPairHorizontal(
          ctx.busEntities,
          `bus:ug:${ctx.entCounter++}`,
          tier,
          yM0,
          spineX0 + 5,
          spineX0 + 7,
          Dir.EAST,
          lLeg.exitNetId,
          item,
        );
        addBeltEntity(ctx.busEntities, `bus:b:${ctx.entCounter++}`, tier, spineX0 + 8, yM0, Dir.SOUTH, lLeg.exitNetId, item);

        // Right horizontal +13..+10 WEST -> +9 SOUTH
        addBeltEntity(ctx.busEntities, `bus:b:${ctx.entCounter++}`, tier, rLeg.exitX, yM0, Dir.WEST, rLeg.exitNetId, item);
        for (let x = rLeg.exitX - 1; x >= spineX0 + 10; x--) {
          addBeltEntity(ctx.busEntities, `bus:b:${ctx.entCounter++}`, tier, x, yM0, Dir.WEST, rLeg.exitNetId, item);
        }
        addBeltEntity(ctx.busEntities, `bus:b:${ctx.entCounter++}`, tier, spineX0 + 9, yM0, Dir.SOUTH, rLeg.exitNetId, item);

        const finalBalId = `bal:tiler:final:${ctx.balCounter++}`;
        ctx.nodes.push({
          id: finalBalId,
          kind: 'balancer-macro',
          item,
          inputs: 2,
          outputs: 1,
          beltTier: tier,
          totalRatePerSec: totalOutRate,
          templateId: 'builtin-2x1',
        } satisfies BalancerMacroSpec);
        addSplitterEntity(ctx.busEntities, `bus:sp:${ctx.entCounter++}`, tier, spineX0 + 8, yM0 + 1, Dir.SOUTH, item, finalBalId);

        const lNet = ctx.nets.find((n) => n.id === lLeg.exitNetId);
        const rNet = ctx.nets.find((n) => n.id === rLeg.exitNetId);
        if (lNet) lNet.sink = { nodeId: finalBalId, pinId: 'in:0', kind: 'sink', item };
        if (rNet) rNet.sink = { nodeId: finalBalId, pinId: 'in:1', kind: 'sink', item };

        const finalNetId = `net:tiler:${ctx.netCounter++}:${item}`;
        const outPinId = `out:${item}:0`;
        ctx.nodes.push({
          id: outPinId,
          kind: 'primary-output',
          item,
          busIndex: ctx.pinCounter++,
          ratePerSec: totalOutRate,
          beltTier: tier,
          pinId: outPinId,
        } satisfies SynthOutputNode);
        ctx.nets.push({
          id: finalNetId,
          busId: `${item}:out`,
          busIndex: 0,
          item,
          ratePerSec: totalOutRate,
          beltTier: tier,
          source: { nodeId: finalBalId, pinId: 'out:0', kind: 'source', item },
          sink: { nodeId: outPinId, pinId: outPinId, kind: 'sink', item },
        });
        for (let y = yM0 + 2; y <= H - 1; y++) {
          addBeltEntity(ctx.busEntities, `bus:b:${ctx.entCounter++}`, tier, spineX0 + 8, y, Dir.SOUTH, finalNetId, item);
        }
        ctx.outerPins.push({
          id: outPinId,
          busId: item,
          busIndex: ctx.pinCounter,
          kind: 'output',
          item,
          ratePerSec: totalOutRate,
          beltTier: tier,
          edge: 'S',
          offset: spineX0 + 8,
          x: spineX0 + 8,
          y: H - 1,
          dir: Dir.SOUTH,
          order: ctx.pinCounter,
          locked: false,
          netId: finalNetId,
        });
      }
    }
  }

  return {
    W,
    H,
    cols: layout === 'twin' ? 2 : 1,
    rows: rowsLeft,
    layout,
    nodes: ctx.nodes,
    nets: ctx.nets,
    macros: stampedMacros,
    routeEntities: [...stampedRouteEntities, ...ctx.busEntities],
    routedNets: stampedRoutedNets,
    pdnEntities: stampedPdnEntities,
    outerPins: ctx.outerPins,
  };
}

function offsetAndPrefixBay(
  bay: BuiltBayLayout,
  xOff: number,
  targetH: number,
  bayIdx: number,
  prefixEnabled: boolean,
): BuiltBayLayout {
  const mapNodeId = (id: string): string => {
    if (!prefixEnabled) return id;
    if (id.startsWith('in:')) return `in:b${bayIdx}:${id.slice(3)}`;
    if (id.startsWith('out:')) return `out:b${bayIdx}:${id.slice(4)}`;
    return `b${bayIdx}:${id}`;
  };
  const mapNetId = (id: string): string => (prefixEnabled ? `b${bayIdx}:${id}` : id);
  const mapEntId = (id: string): string => (prefixEnabled ? `b${bayIdx}:${id}` : id);

  const nodes: SynthNode[] = bay.nodes.map((n) => {
    const nid = mapNodeId(n.id);
    if (n.kind === 'primary-input' || n.kind === 'primary-output') {
      return { ...n, id: nid, pinId: mapNodeId(n.pinId) };
    }
    return { ...n, id: nid };
  });

  const nets: SynthNet[] = bay.nets.map((net) => ({
    ...net,
    id: mapNetId(net.id),
    source: { ...net.source, nodeId: mapNodeId(net.source.nodeId) },
    sink: { ...net.sink, nodeId: mapNodeId(net.sink.nodeId) },
  }));

  const macros: PlacedMacro[] = bay.macros.map((pm) => {
    const newId = mapNodeId(pm.id);
    return {
      ...pm,
      id: newId,
      x: pm.x + xOff,
      macro: {
        ...pm.macro,
        id: newId,
        entities: pm.macro.entities.map((e) => ({
          ...e,
          macroId: e.macroId ? mapNodeId(e.macroId) : undefined,
        })),
      },
    };
  });

  const routeEntities: EntityInstance[] = bay.routeEntities.map((e) => ({
    ...e,
    id: mapEntId(e.id),
    tx: e.tx + xOff,
    netId: e.netId ? mapNetId(e.netId) : undefined,
    macroId: e.macroId ? mapNodeId(e.macroId) : undefined,
  }));

  const routedNets: RoutedNetSegment[] = bay.routedNets.map((rn) => ({
    ...rn,
    netId: mapNetId(rn.netId),
    tiles: rn.tiles.map((t) => ({ ...t, tx: t.tx + xOff })),
  }));

  const pdnEntities: EntityInstance[] = bay.pdnEntities.map((pe) => ({
    ...pe,
    id: mapEntId(pe.id),
    tx: pe.tx + xOff,
  }));

  let extCounter = 0;
  const outerPins: PerimeterPin[] = bay.outerPins.map((pin) => {
    const nx = pin.x + xOff;
    const nextNetId = pin.netId ? mapNetId(pin.netId) : undefined;
    let ny = pin.y;
    if (bay.H < targetH && pin.edge === 'S') {
      for (let y = bay.H; y < targetH; y++) {
        addBeltEntity(
          routeEntities,
          `b${bayIdx}:ext:${extCounter++}`,
          pin.beltTier,
          nx,
          y,
          Dir.SOUTH,
          nextNetId,
          pin.item,
        );
      }
      ny = targetH - 1;
    }
    return {
      ...pin,
      id: mapNodeId(pin.id),
      x: nx,
      y: ny,
      offset: pin.edge === 'N' || pin.edge === 'S' ? nx : pin.offset,
      netId: nextNetId,
    };
  });

  return {
    ...bay,
    nodes,
    nets,
    macros,
    routeEntities,
    routedNets,
    pdnEntities,
    outerPins,
  };
}

/**
 * Stitches a verified `K`-tile unit into a DRC-clean, STA-passing megafactory across 1..G bays.
 */
function assembleTiledBlueprint(
  spec: DesignSpec,
  fullSynth: SynthesisResult,
  unit: TileData,
  unitBlueprintString: string,
  K: number,
): PipelineResult | null {
  const uW = unit.floorplan.width;
  const uH = unit.floorplan.height;
  const unitInPins = unit.floorplan.pins
    .filter((p) => p.kind === 'input' && p.edge === 'W')
    .sort((a, b) => a.y - b.y);
  const unitOutPins = unit.floorplan.pins
    .filter((p) => p.kind === 'output' && p.edge === 'E')
    .sort((a, b) => a.y - b.y);

  // Verify every unit pin lies cleanly on W (input) or E (output)
  if (unitInPins.length + unitOutPins.length !== unit.floorplan.pins.length) {
    return null;
  }

  const maxRowCapOut = unitOutPins.reduce(
    (minG, p) =>
      Math.min(
        minG,
        Math.floor((BELT_SPECS[p.beltTier].itemsPerSec + 1e-6) / Math.max(1e-6, p.ratePerSec)),
      ),
    Infinity,
  );
  const prefLayout = spec.optimization?.tileLayout ?? 'auto';
  const reqAr =
    spec.floorplan.mode === 'fixed' && spec.floorplan.width && spec.floorplan.height
      ? clampNum(spec.floorplan.width / Math.max(1, spec.floorplan.height), 0.2, 5.0)
      : spec.floorplan.aspectRatio ?? 1.35;
  const { bayCount, layout } = pickBestBayCountForCompiledUnit(
    K,
    uW,
    uH,
    unitInPins,
    unitOutPins,
    maxRowCapOut,
    reqAr,
    prefLayout,
  );

  const mirroredUnit = layout === 'twin' ? mirrorUnitTileX(unit) : null;
  const rawBays: BuiltBayLayout[] = [];
  const baseTiles = Math.floor(K / bayCount);
  const remTiles = K % bayCount;
  for (let g = 0; g < bayCount; g++) {
    const kBay = baseTiles + (g < remTiles ? 1 : 0);
    rawBays.push(
      buildSingleBayLayout(unit, mirroredUnit, unitInPins, unitOutPins, kBay, layout),
    );
  }

  const BAY_GAP = 6;
  let W =
    rawBays.reduce((sum, b) => sum + b.W, 0) + Math.max(0, bayCount - 1) * BAY_GAP;
  let H = rawBays.reduce((mx, b) => Math.max(mx, b.H), 1);

  const allNodes: SynthNode[] = [];
  const allNets: SynthNet[] = [];
  const stampedMacros: PlacedMacro[] = [];
  const allRouteEntities: EntityInstance[] = [];
  const stampedRoutedNets: RoutedNetSegment[] = [];
  const stampedPdnEntities: EntityInstance[] = [];
  const allOuterPins: PerimeterPin[] = [];

  let xOff = 0;
  let totalCols = 0;
  let maxRows = 0;
  for (let g = 0; g < rawBays.length; g++) {
    const shifted = offsetAndPrefixBay(rawBays[g], xOff, H, g, bayCount > 1);
    allNodes.push(...shifted.nodes);
    allNets.push(...shifted.nets);
    stampedMacros.push(...shifted.macros);
    allRouteEntities.push(...shifted.routeEntities);
    stampedRoutedNets.push(...shifted.routedNets);
    stampedPdnEntities.push(...shifted.pdnEntities);
    allOuterPins.push(...shifted.outerPins);
    totalCols += rawBays[g].cols;
    maxRows = Math.max(maxRows, rawBays[g].rows);
    xOff += rawBays[g].W + BAY_GAP;
  }

  const fixedWarnings: string[] = [];
  if (
    spec.floorplan.mode === 'fixed' &&
    spec.floorplan.width !== undefined &&
    spec.floorplan.height !== undefined
  ) {
    const origW = W;
    const origH = H;
    const fixedW = Math.max(16, Math.round(spec.floorplan.width));
    const fixedH = Math.max(16, Math.round(spec.floorplan.height));
    const targetW = Math.max(origW, fixedW);
    const targetH = Math.max(origH, fixedH);

    if (targetW > origW || targetH > origH) {
      const shiftX = Math.floor((targetW - origW) / 2);
      const shiftY = Math.floor((targetH - origH) / 2);

      for (const pm of stampedMacros) {
        pm.x += shiftX;
        pm.y += shiftY;
      }
      for (const re of allRouteEntities) {
        re.tx += shiftX;
        re.ty += shiftY;
      }
      for (const rn of stampedRoutedNets) {
        for (const t of rn.tiles) {
          t.tx += shiftX;
          t.ty += shiftY;
        }
      }
      for (const pe of stampedPdnEntities) {
        pe.tx += shiftX;
        pe.ty += shiftY;
      }

      let fixedExtCounter = 0;
      const routedByNetId = new Map<string, RoutedNetSegment>();
      for (const rn of stampedRoutedNets) routedByNetId.set(rn.netId, rn);

      for (const pin of allOuterPins) {
        const origX = pin.x;
        const origY = pin.y;
        pin.x += shiftX;
        pin.y += shiftY;

        const addedTiles: Array<{ tx: number; ty: number }> = [];
        if (pin.edge === 'W' && origX === 0 && shiftX > 0) {
          for (let x = 0; x < shiftX; x++) {
            addBeltEntity(
              allRouteEntities,
              `bus:fixedext:${fixedExtCounter++}`,
              pin.beltTier,
              x,
              pin.y,
              pin.dir,
              pin.netId,
              pin.item,
            );
            addedTiles.push({ tx: x, ty: pin.y });
          }
          pin.x = 0;
        } else if (pin.edge === 'E' && origX === origW - 1 && shiftX + origW < targetW) {
          for (let x = shiftX + origW; x < targetW; x++) {
            addBeltEntity(
              allRouteEntities,
              `bus:fixedext:${fixedExtCounter++}`,
              pin.beltTier,
              x,
              pin.y,
              pin.dir,
              pin.netId,
              pin.item,
            );
            addedTiles.push({ tx: x, ty: pin.y });
          }
          pin.x = targetW - 1;
        } else if (pin.edge === 'N' && origY === 0 && shiftY > 0) {
          for (let y = 0; y < shiftY; y++) {
            addBeltEntity(
              allRouteEntities,
              `bus:fixedext:${fixedExtCounter++}`,
              pin.beltTier,
              pin.x,
              y,
              pin.dir,
              pin.netId,
              pin.item,
            );
            addedTiles.push({ tx: pin.x, ty: y });
          }
          pin.y = 0;
        } else if (pin.edge === 'S' && origY === origH - 1 && shiftY + origH < targetH) {
          for (let y = shiftY + origH; y < targetH; y++) {
            addBeltEntity(
              allRouteEntities,
              `bus:fixedext:${fixedExtCounter++}`,
              pin.beltTier,
              pin.x,
              y,
              pin.dir,
              pin.netId,
              pin.item,
            );
            addedTiles.push({ tx: pin.x, ty: y });
          }
          pin.y = targetH - 1;
        }

        if (addedTiles.length > 0 && pin.netId) {
          const rn = routedByNetId.get(pin.netId);
          if (rn) {
            for (const t of addedTiles) {
              rn.tiles.push({ tx: t.tx, ty: t.ty, dir: pin.dir, kind: 'belt' });
            }
            rn.length = rn.tiles.length;
          }
        }
        pin.offset = pin.edge === 'W' || pin.edge === 'E' ? pin.y : pin.x;
      }

      W = targetW;
      H = targetH;
    }

    if (origW > fixedW || origH > fixedH) {
      fixedWarnings.push(
        `Fixed die ${fixedW}×${fixedH} is smaller than minimum tiled footprint ${origW}×${origH}; expanded to ${W}×${H}.`,
      );
    }
  }

  // Build tiled synthesis, floorplan, route, PDN, collect, DRC, STA!
  const tiledSynth: SynthesisResult = {
    spec,
    nodes: allNodes,
    nets: allNets,
    dag: fullSynth.dag,
    bom: fullSynth.bom,
    warnings: [...unit.synthesis.warnings, ...fixedWarnings],
  };

  const tiledFloorplan: FloorplanResult = {
    width: W,
    height: H,
    margin: unit.floorplan.margin,
    halo: unit.floorplan.halo,
    macros: stampedMacros,
    pins: allOuterPins,
    hpwl: unit.floorplan.hpwl * K,
    warnings: fixedWarnings,
  };

  const tiledRoute: RouteResult = {
    width: W,
    height: H,
    routedNets: stampedRoutedNets,
    entities: allRouteEntities,
    iterations: unit.route.iterations,
    conflictsRemaining: 0,
    elapsedMs: 0,
    autoExpandedCount: 0,
  };

  // Pre-PDN entity gather
  const prePdn: EntityInstance[] = [];
  for (const pm of stampedMacros) {
    for (const ent of pm.macro.entities) {
      prePdn.push({ ...ent, id: `${pm.id}:${ent.id}`, tx: pm.x + ent.tx, ty: pm.y + ent.ty });
    }
  }
  for (const re of allRouteEntities) prePdn.push(re);
  for (const pe of stampedPdnEntities) prePdn.push(pe);

  const pdn = buildPowerGrid(prePdn, W, H, spec.pdk);
  const allEntities: EntityInstance[] = [...prePdn, ...pdn.entities];
  const combinedPdn = {
    ...pdn,
    entities: [...stampedPdnEntities, ...pdn.entities],
    poleCount: stampedPdnEntities.length + pdn.entities.length,
  };

  // Add perimeter port markers cleanly relative to each pin
  if (spec.pdk.portMarkers !== 'none') {
    const occupied = new Set<string>();
    for (const e of allEntities) {
      for (let dx = 0; dx < e.w; dx++) {
        for (let dy = 0; dy < e.h; dy++) {
          occupied.add(`${e.tx + dx},${e.ty + dy}`);
        }
      }
    }
    for (const pin of allOuterPins) {
      const outX = pin.edge === 'W' ? pin.x - 1 : pin.edge === 'E' ? pin.x + 1 : pin.x;
      const outY = pin.edge === 'N' ? pin.y - 1 : pin.edge === 'S' ? pin.y + 1 : pin.y;
      if (occupied.has(`${outX},${outY}`)) continue;
      occupied.add(`${outX},${outY}`);
      const isOut = pin.kind === 'output';
      allEntities.push({
        id: `marker:${pin.id}`,
        name:
          spec.pdk.portMarkers === 'display-panel'
            ? 'display-panel'
            : 'constant-combinator',
        tx: outX,
        ty: outY,
        w: 1,
        h: 1,
        direction: 0,
        role: 'port-marker',
        item: pin.item,
        markerText: `${isOut ? 'OUT' : 'IN'}: ${pin.item} (${Math.round(pin.ratePerSec * 60)}/m)`,
        markerIcon: pin.item,
        markerRatePerMin: pin.ratePerSec * 60,
      });
    }
  }

  const drc = runDrc(allEntities, W, H, tiledRoute, true);
  const sta = runSta(tiledSynth, allEntities, spec.pdk);

  const entitiesCount: Record<string, number> = {};
  const modulesCount: Record<string, number> = {};
  let totalMachines = 0;
  for (const e of allEntities) {
    entitiesCount[e.name] = (entitiesCount[e.name] ?? 0) + 1;
    if (e.role === 'machine' && e.name in MACHINE_SPECS) totalMachines++;
    if (e.items) {
      for (const m of e.items) modulesCount[m] = (modulesCount[m] ?? 0) + 1;
    }
  }
  const bom = {
    entities: entitiesCount,
    modules: modulesCount,
    estimatedPowerKw: unit.bom.estimatedPowerKw * K,
    totalMachines,
  };

  const cols = totalCols;
  const rows = maxRows;
  const tilingSummary: TilingSummary = {
    tileCount: K,
    cols,
    rows,
    layout,
    unitWidth: uW,
    unitHeight: uH,
    unitMachines: unit.bom.totalMachines,
    unitBlueprintString,
  };

  const blueprintString = entitiesToBlueprintString(allEntities, {
    label: spec.name,
    description: `Generated by BeltROAD (${K}x tiled ${cols}x${rows}, ${W}x${H}, ${totalMachines} machines)`,
    icons: spec.targets.map((t) => t.item),
    portMarkers: spec.pdk.portMarkers,
  });

  void fullSynth;
  return {
    spec,
    synthesis: tiledSynth,
    floorplan: tiledFloorplan,
    route: tiledRoute,
    pdn: combinedPdn,
    allEntities,
    drc,
    sta,
    bom,
    blueprintString,
    elapsedMs: 0,
    tiling: tilingSummary,
  };
}

export function runTiledPipeline(
  spec: DesignSpec,
  fullSynth: SynthesisResult,
  options: PipelineOptions,
  runFlatFn: FlatPipelineRunner,
): PipelineResult | null {
  const start = Date.now();
  const candidates = chooseCandidateTileCounts(spec, fullSynth);
  const isFixed =
    spec.floorplan.mode === 'fixed' &&
    spec.floorplan.width !== undefined &&
    spec.floorplan.height !== undefined;
  const fixedW = isFixed ? Math.max(16, Math.round(spec.floorplan.width!)) : 0;
  const fixedH = isFixed ? Math.max(16, Math.round(spec.floorplan.height!)) : 0;
  const reqAr = isFixed
    ? clampNum(fixedW / Math.max(1, fixedH), 0.2, 5.0)
    : clampNum(spec.floorplan.aspectRatio ?? 1.35, 0.2, 5.0);
  const fullMachines = Math.max(1, fullSynth.bom.totalMachines);

  let bestResult: PipelineResult | null = null;
  let bestScore = Infinity;

  for (const K of candidates) {
    if (options.shouldCancel?.()) break;
    options.onProgress?.({
      stage: 'floorplan',
      message: `Divide & conquer: compiling 1/${K} unit tile (${K}× array)...`,
    });

    const gridPlan = planTiledGridGeometry(
      K,
      reqAr,
      spec.optimization?.tileLayout ?? 'auto',
    );
    const unitSpec = scaleSpecTargets(spec, 1 / K, `1/${K} tile`);
    unitSpec.floorplan = {
      ...unitSpec.floorplan,
      mode: 'auto',
      width: undefined,
      height: undefined,
      aspectRatio: gridPlan.desiredUnitAr,
    };
    const unitStart = Date.now();
    const unitRes = runFlatFn(
      unitSpec,
      {
        shouldCancel: () =>
          Boolean(options.shouldCancel?.()) || Date.now() - unitStart > 5000,
      },
      { forceBalancedOutputs: true },
    );

    if (unitRes.drc.errorCount > 0 || !unitRes.sta.passed || unitRes.route.conflictsRemaining > 0) {
      continue;
    }

    // Double check outer boundary pins sit on W (inputs) and E (outputs)
    const unitPinsOk = unitRes.floorplan.pins.every(
      (p) => (p.kind === 'input' && p.edge === 'W') || (p.kind === 'output' && p.edge === 'E'),
    );
    if (!unitPinsOk) continue;

    const stitched = assembleTiledBlueprint(
      spec,
      fullSynth,
      unitRes,
      unitRes.blueprintString,
      K,
    );
    if (!stitched) continue;

    if (stitched.drc.passed && stitched.sta.passed) {
      const realAr = stitched.floorplan.width / Math.max(1, stitched.floorplan.height);
      const arErr = Math.abs(Math.log(Math.max(0.05, realAr / reqAr)));
      const overhead = Math.max(0, (stitched.bom.totalMachines - fullMachines) / fullMachines);
      const overflow = isFixed
        ? Math.max(0, stitched.floorplan.width - fixedW) +
          Math.max(0, stitched.floorplan.height - fixedH)
        : 0;
      const score = overflow * 10 + arErr + 0.15 * overhead;
      if (score < bestScore) {
        bestScore = score;
        bestResult = stitched;
      }
      if (overflow === 0 && arErr < 0.22) {
        break;
      }
    }
  }

  if (bestResult) {
    bestResult.elapsedMs = Date.now() - start;
    const t = bestResult.tiling!;
    options.onProgress?.({
      stage: 'done',
      message: `Done in ${bestResult.elapsedMs}ms (${t.tileCount}× tiled ${t.cols}×${t.rows}) — DRC: PASS, STA: PASS`,
      elapsedMs: bestResult.elapsedMs,
    });
  }

  return bestResult;
}
