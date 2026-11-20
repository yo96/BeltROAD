import {
  BomSummary,
  DesignSpec,
  DrcReport,
  EntityInstance,
  FloorplanResult,
  PdnResult,
  PipelineProgress,
  PipelineResult,
  RouteResult,
  StaReport,
  SynthesisResult,
} from './types.js';
import {
  MACHINE_SPECS,
  POLE_BY_ENTITY_NAME,
} from './data/entities.js';
import { synthesizeDesign } from './synth/synthesize.js';
import { compileAllMacros } from './macro/compile.js';
import { runFloorplanAndPlacement } from './floorplan/placer.js';
import { routeGrid } from './router/pathfinder.js';
import { buildPowerGrid } from './pdn/powerGrid.js';
import { runDrc } from './verify/drc.js';
import { runSta } from './verify/sta.js';
import { entitiesToBlueprintString } from './blueprint/codec.js';

export interface PipelineOptions {
  onProgress?: (progress: PipelineProgress) => void;
  shouldCancel?: () => boolean;
}

export function runSynthesisStage(spec: DesignSpec): SynthesisResult {
  return synthesizeDesign(spec);
}

export function runFloorplanStage(
  synth: SynthesisResult,
  spec: DesignSpec,
): FloorplanResult {
  const variantSets = compileAllMacros(synth, spec);
  return runFloorplanAndPlacement(synth, variantSets, spec);
}

export function runRouteStage(
  synth: SynthesisResult,
  floorplan: FloorplanResult,
  onProgress?: PipelineOptions['onProgress'],
  shouldCancel?: () => boolean,
  optimizeRoutes = true,
): RouteResult {
  return routeGrid(
    synth,
    floorplan,
    (info) =>
      onProgress?.({
        stage: 'route',
        message: `Routing iter ${info.iteration}/${info.maxIterations} (${info.conflicts} conflicts)`,
        iteration: info.iteration,
        maxIterations: info.maxIterations,
        conflicts: info.conflicts,
        elapsedMs: info.elapsedMs,
      }),
    shouldCancel,
    optimizeRoutes,
  );
}

export function collectLayoutEntities(
  floorplan: FloorplanResult,
  route: RouteResult,
  pdn: PdnResult,
  spec: DesignSpec,
): EntityInstance[] {
  const all: EntityInstance[] = [];

  for (const pm of floorplan.macros) {
    for (const ent of pm.macro.entities) {
      all.push({
        ...ent,
        id: `${pm.id}:${ent.id}`,
        tx: pm.x + ent.tx,
        ty: pm.y + ent.ty,
      });
    }
  }

  for (const re of route.entities) {
    all.push(re);
  }

  for (const pe of pdn.entities) {
    all.push(pe);
  }

  // Optional port markers outside perimeter pins
  if (spec.pdk.portMarkers !== 'none') {
    const occupied = new Set<string>();
    for (const e of all) {
      for (let dx = 0; dx < e.w; dx++) {
        for (let dy = 0; dy < e.h; dy++) {
          occupied.add(`${e.tx + dx},${e.ty + dy}`);
        }
      }
    }

    for (const pin of floorplan.pins) {
      // Place marker 1 tile outside the die perimeter along the pin's outward normal
      const outX = pin.edge === 'W' ? -1 : pin.edge === 'E' ? floorplan.width : pin.x;
      const outY = pin.edge === 'N' ? -1 : pin.edge === 'S' ? floorplan.height : pin.y;
      if (occupied.has(`${outX},${outY}`)) continue;
      occupied.add(`${outX},${outY}`);
      const isOut = pin.kind === 'output';
      all.push({
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

  return all;
}

function computeActualBom(allEntities: EntityInstance[], synthBom: BomSummary): BomSummary {
  const entities: Record<string, number> = {};
  const modules: Record<string, number> = {};
  let totalMachines = 0;
  let totalPoles = 0;

  for (const e of allEntities) {
    entities[e.name] = (entities[e.name] ?? 0) + 1;
    if (e.role === 'machine' && e.name in MACHINE_SPECS) {
      totalMachines++;
    }
    if (e.name in POLE_BY_ENTITY_NAME) {
      totalPoles++;
    }
    if (e.items) {
      for (const m of e.items) {
        modules[m] = (modules[m] ?? 0) + 1;
      }
    }
  }

  void totalPoles;
  return {
    entities,
    modules,
    estimatedPowerKw: synthBom.estimatedPowerKw,
    totalMachines,
  };
}

export function runFullPipeline(
  spec: DesignSpec,
  options: PipelineOptions = {},
): PipelineResult {
  const start = Date.now();
  const { onProgress, shouldCancel } = options;

  onProgress?.({ stage: 'synth', message: 'Synthesizing netlist & machine sizing...' });
  const synthesis = runSynthesisStage(spec);

  let effectiveSpec = spec;
  let floorplan = runFloorplanStage(synthesis, effectiveSpec);
  onProgress?.({
    stage: 'floorplan',
    message: `Placed ${floorplan.macros.length} macros on ${floorplan.width}×${floorplan.height} die`,
  });

  const optimizeRoutes = spec.optimization?.optimizeRoutes ?? true;
  let route = runRouteStage(synthesis, floorplan, onProgress, shouldCancel, optimizeRoutes);
  let autoExpandedCount = 0;

  // Auto-die expansion fallback if auto-mode placement had unresolvable routing congestion
  while (
    route.conflictsRemaining > 0 &&
    spec.floorplan.mode === 'auto' &&
    autoExpandedCount < 2 &&
    !shouldCancel?.()
  ) {
    autoExpandedCount++;
    effectiveSpec = {
      ...effectiveSpec,
      floorplan: {
        ...effectiveSpec.floorplan,
        margin: (effectiveSpec.floorplan.margin ?? 3) + 1,
        halo: (effectiveSpec.floorplan.halo ?? 2) + 1,
      },
    };
    onProgress?.({
      stage: 'floorplan',
      message: `Expanding die channels (retry ${autoExpandedCount})...`,
    });
    floorplan = runFloorplanStage(synthesis, effectiveSpec);
    route = runRouteStage(synthesis, floorplan, onProgress, shouldCancel, optimizeRoutes);
  }
  route.autoExpandedCount = autoExpandedCount;

  // Build PDN on top of macro + route entities
  onProgress?.({ stage: 'pdn', message: 'Connecting Power Delivery Network (PDN)...' });
  const prePdnEntities = collectLayoutEntities(
    floorplan,
    route,
    { entities: [], addedPoles: 0, totalPoles: 0, componentsBefore: 0, componentsAfter: 0 },
    { ...spec, pdk: { ...spec.pdk, portMarkers: 'none' } },
  );
  const pdn = buildPowerGrid(
    prePdnEntities,
    floorplan.width,
    floorplan.height,
    spec.pdk,
  );

  const allEntities = collectLayoutEntities(floorplan, route, pdn, spec);

  onProgress?.({ stage: 'signoff', message: 'Running DRC & STA signoff verification...' });
  const drc: DrcReport = runDrc(
    allEntities,
    floorplan.width,
    floorplan.height,
    route,
    true,
  );
  const sta: StaReport = runSta(synthesis, allEntities, spec.pdk);
  const bom = computeActualBom(allEntities, synthesis.bom);

  const blueprintString = entitiesToBlueprintString(allEntities, {
    label: spec.name,
    description: `Generated by Factorio EDA (${floorplan.width}x${floorplan.height}, ${bom.totalMachines} machines)`,
    icons: spec.targets.map((t) => t.item),
    portMarkers: spec.pdk.portMarkers,
  });

  const elapsedMs = Date.now() - start;
  onProgress?.({
    stage: 'done',
    message: `Done in ${elapsedMs}ms — DRC: ${drc.passed ? 'PASS' : 'FAIL'}, STA: ${sta.passed ? 'PASS' : 'FAIL'}`,
    elapsedMs,
  });

  return {
    spec,
    synthesis,
    floorplan,
    route,
    pdn,
    allEntities,
    drc,
    sta,
    bom,
    blueprintString,
    elapsedMs,
  };
}

export function runFromFloorplan(
  spec: DesignSpec,
  synthesis: SynthesisResult,
  floorplan: FloorplanResult,
  options: PipelineOptions = {},
): PipelineResult {
  const start = Date.now();
  const { onProgress, shouldCancel } = options;

  const optimizeRoutes = spec.optimization?.optimizeRoutes ?? true;
  const route = runRouteStage(synthesis, floorplan, onProgress, shouldCancel, optimizeRoutes);
  onProgress?.({ stage: 'pdn', message: 'Connecting Power Delivery Network (PDN)...' });
  const prePdnEntities = collectLayoutEntities(
    floorplan,
    route,
    { entities: [], addedPoles: 0, totalPoles: 0, componentsBefore: 0, componentsAfter: 0 },
    { ...spec, pdk: { ...spec.pdk, portMarkers: 'none' } },
  );
  const pdn = buildPowerGrid(
    prePdnEntities,
    floorplan.width,
    floorplan.height,
    spec.pdk,
  );
  const allEntities = collectLayoutEntities(floorplan, route, pdn, spec);
  onProgress?.({ stage: 'signoff', message: 'Running DRC & STA signoff verification...' });
  const drc = runDrc(allEntities, floorplan.width, floorplan.height, route, true);
  const sta = runSta(synthesis, allEntities, spec.pdk);
  const bom = computeActualBom(allEntities, synthesis.bom);

  const blueprintString = entitiesToBlueprintString(allEntities, {
    label: spec.name,
    description: `Generated by Factorio EDA (${floorplan.width}x${floorplan.height}, ${bom.totalMachines} machines)`,
    icons: spec.targets.map((t) => t.item),
    portMarkers: spec.pdk.portMarkers,
  });

  const elapsedMs = Date.now() - start;
  onProgress?.({ stage: 'done', message: `Re-routed in ${elapsedMs}ms`, elapsedMs });

  return {
    spec,
    synthesis,
    floorplan,
    route,
    pdn,
    allEntities,
    drc,
    sta,
    bom,
    blueprintString,
    elapsedMs,
  };
}
