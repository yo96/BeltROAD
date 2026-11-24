import { afterEach, describe, expect, it } from 'vitest';
import {
  BUILTIN_PRESETS,
  DesignSpec,
  decodeBlueprintWrapper,
  defaultOptimizationConfig,
  defaultPdkConfig,
  getDefaultCatalogRaw,
  loadCustomCatalog,
  resetDefaultCatalog,
  runFullPipeline,
} from '../src/index.js';

describe('v2.2 Space Age Tech Tiers, Belt Stacking, Quality & 4x4/5x5 Buildings', () => {
  afterEach(() => {
    resetDefaultCatalog();
  });

  it('compiles 7200/min (120/s) Electronic Circuits onto a single 4x stacked Turbo belt (240/s)', () => {
    const spec: DesignSpec = {
      version: 1,
      name: 'Stacked Turbo Green Circuits',
      pdk: {
        ...defaultPdkConfig(),
        defaultBeltTier: 'turbo',
        allowedBeltTiers: ['yellow', 'red', 'blue', 'turbo'],
        beltStackSize: 4,
        defaultAssemblerTier: 3,
        defaultInserterTier: 'stack',
        allowedInserterTiers: ['yellow', 'long', 'fast', 'bulk', 'stack'],
        machineQuality: 'rare',
        modules: {
          global: ['speed-module-2', 'speed-module-2', 'speed-module-2', 'speed-module-2'],
          byRecipe: {},
        },
      },
      targets: [{ item: 'electronic-circuit', ratePerMin: 7200 }],
      inputPreset: 'plates',
      inputOverrides: {},
      floorplan: { mode: 'auto', aspectRatio: 1.35, margin: 3, halo: 2 },
      pins: [],
      macroOverrides: {},
      optimization: defaultOptimizationConfig('compact'),
    };

    const res = runFullPipeline(spec);
    expect(res.drc.passed).toBe(true);
    expect(res.drc.errorCount).toBe(0);
    expect(res.sta.passed).toBe(true);

    // 120 items/s fits cleanly on 1 output pin of 4x stacked turbo belt (240/s)
    const outPins = res.floorplan.pins.filter(
      (p) => p.kind === 'output' && p.item === 'electronic-circuit',
    );
    expect(outPins).toHaveLength(1);
    expect(outPins[0].beltTier).toBe('turbo');

    expect(res.allEntities.some((e) => e.name === 'turbo-transport-belt')).toBe(true);
    expect(res.allEntities.some((e) => e.name === 'stack-inserter')).toBe(true);
  });

  it('applies machine quality speed multipliers and encodes quality in Factorio 2.0 blueprints', () => {
    const baseSpec: DesignSpec = {
      version: 1,
      name: 'Quality Comparison',
      pdk: {
        ...defaultPdkConfig(),
        defaultBeltTier: 'turbo',
        allowedBeltTiers: ['yellow', 'red', 'blue', 'turbo'],
        defaultAssemblerTier: 3,
        defaultInserterTier: 'stack',
        allowedInserterTiers: ['yellow', 'long', 'fast', 'bulk', 'stack'],
      },
      targets: [{ item: 'advanced-circuit', ratePerMin: 300 }],
      inputPreset: 'plates',
      inputOverrides: {},
      floorplan: { mode: 'auto', aspectRatio: 1.35, margin: 3, halo: 2 },
      pins: [],
      macroOverrides: {},
      optimization: defaultOptimizationConfig('compact'),
    };

    const normalRes = runFullPipeline(baseSpec);
    expect(normalRes.drc.passed).toBe(true);
    expect(normalRes.sta.passed).toBe(true);

    const legSpec: DesignSpec = {
      ...structuredClone(baseSpec),
      pdk: {
        ...baseSpec.pdk,
        machineQuality: 'legendary',
      },
    };
    const legRes = runFullPipeline(legSpec);
    expect(legRes.drc.passed).toBe(true);
    expect(legRes.sta.passed).toBe(true);

    // Legendary machines (2.5x speed) cut machine count dramatically (< 55% of Normal)
    expect(legRes.bom.totalMachines).toBeLessThan(normalRes.bom.totalMachines * 0.55);

    const decNormal = decodeBlueprintWrapper(normalRes.blueprintString);
    const normMachines = (decNormal.blueprint?.entities ?? []).filter(
      (e) => e.name === 'assembling-machine-3',
    );
    expect(normMachines.length).toBeGreaterThan(0);
    expect(normMachines.every((m) => m.quality === undefined)).toBe(true);

    const decLeg = decodeBlueprintWrapper(legRes.blueprintString);
    const legMachines = (decLeg.blueprint?.entities ?? []).filter(
      (e) => e.name === 'assembling-machine-3',
    );
    expect(legMachines.length).toBeGreaterThan(0);
    expect(legMachines.every((m) => m.quality === 'legendary')).toBe(true);
  });

  it('compiles 4x4 Electromagnetic Plants and 5x5 Foundries cleanly under both medium and small poles', () => {
    const gcSpec = structuredClone(BUILTIN_PRESETS[0].spec);
    gcSpec.pdk.spaceAgeBuildings = true;
    gcSpec.pdk.defaultBeltTier = 'blue';
    gcSpec.pdk.defaultInserterTier = 'bulk';

    for (const poleTier of ['medium', 'small'] as const) {
      const s = structuredClone(gcSpec);
      s.pdk.defaultPoleTier = poleTier;
      const res = runFullPipeline(s);
      expect(res.drc.passed).toBe(true);
      expect(res.drc.errorCount).toBe(0);
      expect(res.sta.passed).toBe(true);
      const emPlants = res.allEntities.filter((e) => e.name === 'electromagnetic-plant');
      expect(emPlants.length).toBeGreaterThan(0);
      expect(emPlants.every((e) => e.w === 4 && e.h === 4)).toBe(true);
    }

    // Green Science (transport-belt uses Foundry, electronic-circuit uses EM Plant)
    const sciSpec: DesignSpec = {
      version: 1,
      name: 'Space Age Logistic Science',
      pdk: {
        ...defaultPdkConfig(),
        spaceAgeBuildings: true,
        defaultBeltTier: 'red',
        defaultInserterTier: 'bulk',
        defaultPoleTier: 'medium',
      },
      targets: [{ item: 'logistic-science-pack', ratePerMin: 120 }],
      inputPreset: 'plates',
      inputOverrides: {},
      floorplan: { mode: 'auto', aspectRatio: 1.35, margin: 3, halo: 2 },
      pins: [],
      macroOverrides: {},
      optimization: defaultOptimizationConfig('compact'),
    };
    const sciRes = runFullPipeline(sciSpec);
    expect(sciRes.drc.passed).toBe(true);
    expect(sciRes.drc.errorCount).toBe(0);
    expect(sciRes.sta.passed).toBe(true);
    expect(sciRes.allEntities.some((e) => e.name === 'foundry' && e.w === 5 && e.h === 5)).toBe(true);
    expect(
      sciRes.allEntities.some((e) => e.name === 'electromagnetic-plant' && e.w === 4 && e.h === 4),
    ).toBe(true);
  });

  it('compiles 5x5 Cryogenic Plants cleanly under medium and small poles', () => {
    const raw = getDefaultCatalogRaw();
    raw.items['fluoroketone-crystal'] = {
      id: 'fluoroketone-crystal',
      name: 'Fluoroketone Crystal',
      color: '#22d3ee',
      category: 'chemical',
      stackSize: 50,
    };
    raw.recipes.push({
      id: 'fluoroketone-crystal',
      name: 'Fluoroketone Crystal',
      category: 'chemistry',
      energyRequired: 2.0,
      ingredients: [
        { item: 'coal', amount: 2 },
        { item: 'iron-plate', amount: 1 },
      ],
      outputItem: 'fluoroketone-crystal',
      outputCount: 1,
      allowProductivity: true,
      hasFluid: false,
    });
    loadCustomCatalog(raw);

    for (const poleTier of ['medium', 'small'] as const) {
      const cryoSpec: DesignSpec = {
        version: 1,
        name: `Cryo ${poleTier}`,
        pdk: {
          ...defaultPdkConfig(),
          spaceAgeBuildings: true,
          defaultBeltTier: 'blue',
          defaultInserterTier: 'bulk',
          defaultPoleTier: poleTier,
        },
        targets: [{ item: 'fluoroketone-crystal', ratePerMin: 360 }],
        inputPreset: 'plates',
        inputOverrides: {},
        floorplan: { mode: 'auto', aspectRatio: 1.35, margin: 3, halo: 2 },
        pins: [],
        macroOverrides: {},
        optimization: defaultOptimizationConfig('compact'),
      };

      const res = runFullPipeline(cryoSpec);
      expect(res.drc.passed).toBe(true);
      expect(res.drc.errorCount).toBe(0);
      expect(res.sta.passed).toBe(true);
      const cryos = res.allEntities.filter((e) => e.name === 'cryogenic-plant');
      expect(cryos.length).toBeGreaterThanOrEqual(4);
      expect(cryos.every((e) => e.w === 5 && e.h === 5)).toBe(true);
    }
  });
});
