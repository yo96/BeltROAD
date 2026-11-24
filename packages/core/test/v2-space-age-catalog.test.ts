import { describe, expect, it } from 'vitest';
import {
  BUILTIN_PRESETS,
  DesignSpec,
  decodeBlueprintWrapper,
  defaultOptimizationConfig,
  defaultPdkConfig,
  getCatalog,
  runFullPipeline,
} from '../src/index.js';

describe('Chemical & Space Age Recipe Catalog Support', () => {
  it('exposes chemical and Space Age recipes in allTargets with expected categories', () => {
    const catalog = getCatalog();
    expect(catalog.version).toBe('2.0-space-age');
    const byOut = new Set(catalog.allTargets.map((r) => r.outputItem));
    for (const item of [
      'plastic-bar',
      'sulfur',
      'battery',
      'explosives',
      'solid-fuel',
      'processing-unit',
      'express-transport-belt',
      'express-splitter',
      'quality-module-3',
      'tungsten-carbide',
      'tungsten-plate',
      'metallurgic-science-pack',
      'holmium-plate',
      'superconductor',
      'supercapacitor',
      'electromagnetic-science-pack',
      'carbon-fiber',
      'stack-inserter',
      'agricultural-science-pack',
      'lithium-plate',
      'cryogenic-science-pack',
      'foundry',
      'electromagnetic-plant',
      'cryogenic-plant',
    ]) {
      expect(byOut.has(item), `missing target ${item}`).toBe(true);
    }
  });

  it('compiles all chemical and fluid-dependent base-game targets directly', () => {
    const cases: Array<{
      item: string;
      ratePerMin: number;
      expectMachine?: string;
    }> = [
      { item: 'plastic-bar', ratePerMin: 120, expectMachine: 'chemical-plant' },
      { item: 'sulfur', ratePerMin: 60, expectMachine: 'chemical-plant' },
      { item: 'battery', ratePerMin: 60, expectMachine: 'chemical-plant' },
      { item: 'solid-fuel', ratePerMin: 60, expectMachine: 'chemical-plant' },
      { item: 'explosives', ratePerMin: 60, expectMachine: 'chemical-plant' },
      { item: 'processing-unit', ratePerMin: 30 },
      { item: 'express-transport-belt', ratePerMin: 60 },
      { item: 'express-splitter', ratePerMin: 30 },
    ];

    for (const c of cases) {
      const spec: DesignSpec = {
        version: 1,
        name: `Chem ${c.item}`,
        pdk: {
          ...defaultPdkConfig(),
          enableFluids: true,
          defaultBeltTier: 'blue',
          defaultAssemblerTier: 3,
          defaultInserterTier: 'bulk',
        },
        targets: [{ item: c.item, ratePerMin: c.ratePerMin }],
        inputPreset: 'plates',
        inputOverrides: {},
        floorplan: { mode: 'auto', aspectRatio: 1.4, margin: 4, halo: 2 },
        pins: [],
        macroOverrides: {},
        optimization: defaultOptimizationConfig('compact'),
      };

      const res = runFullPipeline(spec);
      expect(res.drc.passed, `${c.item} DRC`).toBe(true);
      expect(res.drc.errorCount, `${c.item} DRC count`).toBe(0);
      expect(res.sta.passed, `${c.item} STA`).toBe(true);
      expect(res.bom.totalMachines, `${c.item} machines`).toBeGreaterThan(0);
      if (c.expectMachine) {
        expect(res.allEntities.some((e) => e.name === c.expectMachine)).toBe(true);
      }
    }
  });

  it('compiles Space Age presets (Metallurgic Science & EM Science + Quality) cleanly', () => {
    const vulcanus = BUILTIN_PRESETS.find((p) => p.id === 'vulcanus-metallurgic');
    expect(vulcanus).toBeDefined();
    const vRes = runFullPipeline(structuredClone(vulcanus!.spec));
    expect(vRes.drc.passed).toBe(true);
    expect(vRes.drc.errorCount).toBe(0);
    expect(vRes.sta.passed).toBe(true);
    expect(
      vRes.allEntities.some((e) => e.name === 'foundry' && e.w === 5 && e.h === 5),
    ).toBe(true);
    expect(vRes.allEntities.some((e) => e.name === 'turbo-transport-belt')).toBe(true);
    expect(vRes.allEntities.some((e) => e.name === 'pipe')).toBe(true);
    expect(decodeBlueprintWrapper(vRes.blueprintString).blueprint?.entities.length).toBeGreaterThan(
      20,
    );

    const fulgora = BUILTIN_PRESETS.find((p) => p.id === 'fulgora-electromagnetic');
    expect(fulgora).toBeDefined();
    const fRes = runFullPipeline(structuredClone(fulgora!.spec));
    expect(fRes.drc.passed).toBe(true);
    expect(fRes.drc.errorCount).toBe(0);
    expect(fRes.sta.passed).toBe(true);
    expect(
      fRes.allEntities.some(
        (e) =>
          e.name === 'electromagnetic-plant' &&
          e.w === 4 &&
          e.h === 4 &&
          e.quality === 'rare',
      ),
    ).toBe(true);
    expect(fRes.allEntities.some((e) => e.name === 'pipe')).toBe(true);
    expect(fRes.allEntities.some((e) => e.name === 'turbo-transport-belt')).toBe(true);
  });

  it('compiles multi-solid fluid Space Age targets and Quality Module 3 across pole tiers', () => {
    const scenarios: Array<{
      item: string;
      ratePerMin: number;
      inputPreset: 'plates' | 'bus';
      poleTier: 'small' | 'medium';
      expectMachine: string;
    }> = [
      {
        item: 'superconductor',
        ratePerMin: 60,
        inputPreset: 'bus',
        poleTier: 'medium',
        expectMachine: 'electromagnetic-plant',
      },
      {
        item: 'supercapacitor',
        ratePerMin: 60,
        inputPreset: 'bus',
        poleTier: 'medium',
        expectMachine: 'electromagnetic-plant',
      },
      {
        item: 'supercapacitor',
        ratePerMin: 60,
        inputPreset: 'bus',
        poleTier: 'small',
        expectMachine: 'electromagnetic-plant',
      },
      {
        item: 'foundry',
        ratePerMin: 30,
        inputPreset: 'bus',
        poleTier: 'medium',
        expectMachine: 'foundry',
      },
      {
        item: 'cryogenic-science-pack',
        ratePerMin: 60,
        inputPreset: 'plates',
        poleTier: 'medium',
        expectMachine: 'cryogenic-plant',
      },
      {
        item: 'cryogenic-science-pack',
        ratePerMin: 60,
        inputPreset: 'plates',
        poleTier: 'small',
        expectMachine: 'cryogenic-plant',
      },
      {
        item: 'turbo-transport-belt',
        ratePerMin: 60,
        inputPreset: 'bus',
        poleTier: 'medium',
        expectMachine: 'foundry',
      },
      {
        item: 'quality-module-3',
        ratePerMin: 10,
        inputPreset: 'bus',
        poleTier: 'medium',
        expectMachine: 'electromagnetic-plant',
      },
    ];

    for (const s of scenarios) {
      const spec: DesignSpec = {
        version: 1,
        name: `SA ${s.item} (${s.poleTier})`,
        pdk: {
          ...defaultPdkConfig(),
          enableFluids: true,
          spaceAgeBuildings: true,
          defaultBeltTier: 'turbo',
          allowedBeltTiers: ['yellow', 'red', 'blue', 'turbo'],
          defaultAssemblerTier: 3,
          defaultInserterTier: 'stack',
          allowedInserterTiers: ['yellow', 'long', 'fast', 'bulk', 'stack'],
          defaultPoleTier: s.poleTier,
        },
        targets: [{ item: s.item, ratePerMin: s.ratePerMin }],
        inputPreset: s.inputPreset,
        inputOverrides: {},
        floorplan: { mode: 'auto', aspectRatio: 1.45, margin: 4, halo: 2 },
        pins: [],
        macroOverrides: {},
        optimization: defaultOptimizationConfig('compact'),
      };

      const res = runFullPipeline(spec);
      expect(res.drc.passed, `${s.item} (${s.poleTier}) DRC`).toBe(true);
      expect(res.drc.errorCount, `${s.item} (${s.poleTier}) DRC count`).toBe(0);
      expect(res.sta.passed, `${s.item} (${s.poleTier}) STA`).toBe(true);
      expect(res.allEntities.some((e) => e.name === s.expectMachine)).toBe(true);
    }
  });
});
