import { describe, expect, it } from 'vitest';
import {
  BUILTIN_PRESETS,
  Dir,
  decodeBlueprintWrapper,
  defaultOptimizationConfig,
  defaultPdkConfig,
  runDrc,
  runFullPipeline,
} from '../src/index.js';
import type { DesignSpec, EntityInstance, PoleTier, RecipeMacroSpec } from '../src/index.js';

describe('v2.5 Fluids, Chemical Plants & Dedicated Pipe Routing', () => {
  it('compiles Blue Science preset with Chemical Plants, Water/PetGas pipes, and 2.0 fluid blueprint icons', () => {
    const entry = BUILTIN_PRESETS.find((p) => p.id === 'blue-science')!;
    expect(entry).toBeDefined();
    expect(entry.spec.pdk.enableFluids).toBe(true);

    const out = runFullPipeline(structuredClone(entry.spec));
    expect(out.drc.errorCount, `Blue Science DRC: ${JSON.stringify(out.drc.violations)}`).toBe(0);
    expect(out.sta.passed, `Blue Science STA: ${out.sta.bottlenecks.join('; ')}`).toBe(true);

    const recipeMacros = out.synthesis.nodes.filter(
      (n): n is RecipeMacroSpec => n.kind === 'recipe-macro',
    );
    const plasticMacro = recipeMacros.find((m) => m.recipeId === 'plastic-bar');
    const sulfurMacro = recipeMacros.find((m) => m.recipeId === 'sulfur');
    expect(plasticMacro?.machineName).toBe('chemical-plant');
    expect(sulfurMacro?.machineName).toBe('chemical-plant');

    expect(out.allEntities.some((e) => e.name === 'pipe' && e.item === 'water')).toBe(true);
    expect(out.allEntities.some((e) => e.name === 'pipe' && e.item === 'petroleum-gas')).toBe(true);

    const decoded = decodeBlueprintWrapper(out.blueprintString);
    const bpEnts = decoded.blueprint?.entities ?? [];
    expect(bpEnts.some((e) => e.name === 'chemical-plant')).toBe(true);
    expect(bpEnts.some((e) => e.name === 'pipe')).toBe(true);

    const bpPipeUgs = bpEnts.filter((e) => e.name === 'pipe-to-ground');
    expect(bpPipeUgs.length).toBeGreaterThan(0);
    for (const pu of bpPipeUgs) {
      expect(pu.type).toBeUndefined();
    }

    const fluidMarker = bpEnts.find(
      (e) =>
        (e.name === 'display-panel' || e.name === 'constant-combinator') &&
        (e.icon?.type === 'fluid' ||
          JSON.stringify(e.control_behavior ?? {}).includes('"fluid"')),
    );
    expect(fluidMarker).toBeDefined();
  });

  it('compiles Yellow Science preset with Sulfuric Acid manifold (battery + processing-unit) and 3 fluids cleanly', () => {
    const entry = BUILTIN_PRESETS.find((p) => p.id === 'yellow-science')!;
    expect(entry).toBeDefined();

    const out = runFullPipeline(structuredClone(entry.spec));
    expect(out.drc.errorCount, `Yellow Science DRC: ${JSON.stringify(out.drc.violations)}`).toBe(0);
    expect(out.sta.passed, `Yellow Science STA: ${out.sta.bottlenecks.join('; ')}`).toBe(true);
    expect(out.drc.violations.some((v) => v.code === 'NO_FLUID_MIXING')).toBe(false);

    const fluidItems = new Set(
      out.synthesis.nets.filter((n) => n.isFluid).map((n) => n.item),
    );
    expect(fluidItems.has('sulfuric-acid')).toBe(true);
    expect(fluidItems.has('lubricant')).toBe(true);
    expect(fluidItems.has('petroleum-gas')).toBe(true);

    expect(
      out.synthesis.nodes.some(
        (n) =>
          n.kind === 'balancer-macro' &&
          n.isFluid === true &&
          n.item === 'sulfuric-acid' &&
          n.outputs >= 2,
      ),
    ).toBe(true);
  });

  it('detects NO_FLUID_MIXING and PIPE_UG_PAIR in DRC while allowing non-facing parallel underground pipes', () => {
    const mixingEnts: EntityInstance[] = [
      { id: 'p1', name: 'pipe', tx: 2, ty: 2, w: 1, h: 1, direction: Dir.NORTH, item: 'water', role: 'pipe-route' },
      { id: 'p2', name: 'pipe', tx: 3, ty: 2, w: 1, h: 1, direction: Dir.NORTH, item: 'petroleum-gas', role: 'pipe-route' },
    ];
    const mixReport = runDrc(mixingEnts, 10, 10);
    expect(mixReport.violations.some((v) => v.code === 'NO_FLUID_MIXING')).toBe(true);

    // Parallel non-facing pipe-to-ground pairs (open ports face away NORTH vs SOUTH)
    const parallelClean: EntityInstance[] = [
      { id: 'u1a', name: 'pipe-to-ground', tx: 2, ty: 1, w: 1, h: 1, direction: Dir.NORTH, item: 'water', role: 'pipe-ug-route' },
      { id: 'u1b', name: 'pipe-to-ground', tx: 2, ty: 5, w: 1, h: 1, direction: Dir.SOUTH, item: 'water', role: 'pipe-ug-route' },
      { id: 'u2a', name: 'pipe-to-ground', tx: 3, ty: 1, w: 1, h: 1, direction: Dir.NORTH, item: 'petroleum-gas', role: 'pipe-ug-route' },
      { id: 'u2b', name: 'pipe-to-ground', tx: 3, ty: 5, w: 1, h: 1, direction: Dir.SOUTH, item: 'petroleum-gas', role: 'pipe-ug-route' },
    ];
    const okReport = runDrc(parallelClean, 10, 10);
    expect(okReport.errorCount, JSON.stringify(okReport.violations)).toBe(0);

    // Unpaired pipe-to-ground triggers PIPE_UG_PAIR
    const unpairedReport = runDrc([parallelClean[0]], 10, 10);
    expect(unpairedReport.violations.some((v) => v.code === 'PIPE_UG_PAIR')).toBe(true);
  });

  it('passes DRC=0 & STA across small, medium, and substation poles on 2-fluid Sulfur & 1-fluid Processing Units', () => {
    for (const poleTier of ['small', 'medium', 'substation'] as PoleTier[]) {
      const sulfurSpec: DesignSpec = {
        version: 1,
        name: `Sulfur (${poleTier})`,
        pdk: {
          ...defaultPdkConfig(),
          enableFluids: true,
          defaultPoleTier: poleTier,
          defaultBeltTier: 'red',
        },
        targets: [{ item: 'sulfur', ratePerMin: 240 }],
        inputPreset: 'plates',
        inputOverrides: {},
        floorplan: { mode: 'auto', aspectRatio: 1.35, margin: 3, halo: 2 },
        pins: [],
        macroOverrides: {},
        optimization: defaultOptimizationConfig('compact'),
      };
      const outS = runFullPipeline(sulfurSpec);
      expect(outS.drc.errorCount, `Sulfur ${poleTier} DRC: ${JSON.stringify(outS.drc.violations)}`).toBe(0);
      expect(outS.sta.passed, `Sulfur ${poleTier} STA: ${outS.sta.bottlenecks.join('; ')}`).toBe(true);

      const puSpec: DesignSpec = {
        ...sulfurSpec,
        name: `Processing Unit (${poleTier})`,
        inputPreset: 'bus',
        targets: [{ item: 'processing-unit', ratePerMin: 60 }],
      };
      const outP = runFullPipeline(puSpec);
      expect(outP.drc.errorCount, `PU ${poleTier} DRC: ${JSON.stringify(outP.drc.violations)}`).toBe(0);
      expect(outP.sta.passed, `PU ${poleTier} STA: ${outP.sta.bottlenecks.join('; ')}`).toBe(true);
    }
  });

  it('supports Space Age Cryogenic Plant & Electromagnetic Plant with enableFluids=true across pole tiers', () => {
    for (const poleTier of ['small', 'medium', 'substation'] as PoleTier[]) {
      const spec: DesignSpec = {
        version: 1,
        name: `Space Age Fluids (${poleTier})`,
        pdk: {
          ...defaultPdkConfig(),
          enableFluids: true,
          spaceAgeBuildings: true,
          defaultPoleTier: poleTier,
          defaultBeltTier: 'blue',
          allowedBeltTiers: ['yellow', 'red', 'blue', 'turbo'],
          defaultInserterTier: 'bulk',
          allowedInserterTiers: ['yellow', 'long', 'fast', 'bulk', 'stack'],
        },
        targets: [
          { item: 'sulfur', ratePerMin: 240 },
          { item: 'processing-unit', ratePerMin: 60 },
        ],
        inputPreset: 'plates',
        inputOverrides: {},
        floorplan: { mode: 'auto', aspectRatio: 1.4, margin: 4, halo: 2 },
        pins: [],
        macroOverrides: {},
        optimization: defaultOptimizationConfig('compact'),
      };
      const out = runFullPipeline(spec);
      expect(out.drc.errorCount, `SpaceAge Fluid ${poleTier} DRC: ${JSON.stringify(out.drc.violations)}`).toBe(0);
      expect(out.sta.passed, `SpaceAge Fluid ${poleTier} STA: ${out.sta.bottlenecks.join('; ')}`).toBe(true);
      expect(out.allEntities.some((e) => e.name === 'cryogenic-plant')).toBe(true);
      expect(out.allEntities.some((e) => e.name === 'electromagnetic-plant')).toBe(true);
    }
  });
});
