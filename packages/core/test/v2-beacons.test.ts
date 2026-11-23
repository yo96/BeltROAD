import { describe, expect, it } from 'vitest';
import {
  BUILTIN_PRESETS,
  DesignSpec,
  beaconTransmissionMultiplier,
  countBeaconsAffectingMachine,
  decodeBlueprintWrapper,
  defaultOptimizationConfig,
  defaultPdkConfig,
  runFullPipeline,
} from '../src/index.js';

describe('v2.3 Beaconed Macro Rows & Factorio 2.0 sqrt(N) Physics', () => {
  it('computes exact Factorio 2.0 diminishing-returns beacon transmission scaling', () => {
    expect(beaconTransmissionMultiplier(0, 'normal')).toBe(0);
    expect(beaconTransmissionMultiplier(1, 'normal')).toBeCloseTo(1.5, 6);
    expect(beaconTransmissionMultiplier(4, 'normal')).toBeCloseTo(3.0, 6);
    expect(beaconTransmissionMultiplier(8, 'normal')).toBeCloseTo(1.5 * Math.sqrt(8), 6);
    expect(beaconTransmissionMultiplier(4, 'legendary')).toBeCloseTo(5.0, 6);
  });

  it('compiles 8-beacon sandwich rows with >=8 physical beacons/machine and inventory-1 module encoding', () => {
    const baseSpec: DesignSpec = {
      version: 1,
      name: 'Unbeaconed Gears',
      pdk: {
        ...defaultPdkConfig(),
        defaultBeltTier: 'blue',
        allowedBeltTiers: ['yellow', 'red', 'blue', 'turbo'],
        defaultAssemblerTier: 3,
        defaultInserterTier: 'bulk',
        beaconMode: 'none',
      },
      targets: [{ item: 'iron-gear-wheel', ratePerMin: 1800 }],
      inputPreset: 'plates',
      inputOverrides: {},
      floorplan: { mode: 'auto', aspectRatio: 1.35, margin: 3, halo: 2 },
      pins: [],
      macroOverrides: {},
      optimization: defaultOptimizationConfig('compact'),
    };
    const unbeaconed = runFullPipeline(baseSpec);
    expect(unbeaconed.drc.passed).toBe(true);
    expect(unbeaconed.sta.passed).toBe(true);

    // 8-beacon 1-ingredient sandwich
    const beacon8Gears: DesignSpec = {
      ...structuredClone(baseSpec),
      name: '8B Gears',
      pdk: {
        ...baseSpec.pdk,
        beaconMode: 'row-8',
        beaconModules: ['speed-module-3', 'speed-module-3'],
        modules: {
          global: ['productivity-module-3', 'productivity-module-3', 'productivity-module-3', 'productivity-module-3'],
          byRecipe: {},
        },
      },
    };
    const b8Gears = runFullPipeline(beacon8Gears);
    expect(b8Gears.drc.passed).toBe(true);
    expect(b8Gears.drc.errorCount).toBe(0);
    expect(b8Gears.sta.passed).toBe(true);
    expect(b8Gears.bom.totalMachines).toBeLessThan(unbeaconed.bom.totalMachines * 0.45);

    const beacons = b8Gears.allEntities.filter((e) => e.name === 'beacon');
    const machines = b8Gears.allEntities.filter((e) => e.role === 'machine');
    expect(beacons.length).toBeGreaterThan(0);
    for (const m of machines) {
      expect(countBeaconsAffectingMachine(m, beacons)).toBeGreaterThanOrEqual(8);
    }

    // Factorio 2.0 blueprint encoding: beacons use inventory=1, assemblers use inventory=4
    const decoded = decodeBlueprintWrapper(b8Gears.blueprintString);
    const bpEnts = decoded.blueprint?.entities ?? [];
    const bpBeacons = bpEnts.filter((e) => e.name === 'beacon');
    const bpAssemblers = bpEnts.filter((e) => e.name === 'assembling-machine-3');
    expect(bpBeacons.length).toBe(beacons.length);
    expect(bpBeacons[0].items?.[0]?.items.in_inventory[0]?.inventory).toBe(1);
    expect(bpAssemblers[0].items?.[0]?.items.in_inventory[0]?.inventory).toBe(4);

    // 8-beacon 2-ingredient compact dual-lane sandwich (Electronic Circuits at 360/min)
    const gcSpec: DesignSpec = {
      ...structuredClone(beacon8Gears),
      name: '8B Circuits',
      targets: [{ item: 'electronic-circuit', ratePerMin: 360 }],
    };
    const b8Gc = runFullPipeline(gcSpec);
    expect(b8Gc.drc.passed).toBe(true);
    expect(b8Gc.drc.errorCount).toBe(0);
    expect(b8Gc.sta.passed).toBe(true);
    const gcBeacons = b8Gc.allEntities.filter((e) => e.name === 'beacon');
    const gcMachines = b8Gc.allEntities.filter((e) => e.role === 'machine');
    for (const m of gcMachines) {
      expect(countBeaconsAffectingMachine(m, gcBeacons)).toBeGreaterThanOrEqual(8);
    }
  });

  it('compiles 4-beacon rows cleanly across small/medium/substation poles and 4x4 Space Age EM Plants', () => {
    for (const poleTier of ['medium', 'small', 'substation'] as const) {
      const advSpec: DesignSpec = {
        version: 1,
        name: `4B Red Circuits (${poleTier})`,
        pdk: {
          ...defaultPdkConfig(),
          defaultBeltTier: 'blue',
          defaultAssemblerTier: 3,
          defaultInserterTier: 'bulk',
          defaultPoleTier: poleTier,
          beaconMode: 'row-4',
          beaconModules: ['speed-module-3', 'speed-module-3'],
        },
        targets: [{ item: 'advanced-circuit', ratePerMin: 300 }],
        inputPreset: 'plates',
        inputOverrides: {},
        floorplan: { mode: 'auto', aspectRatio: 1.35, margin: 3, halo: 2 },
        pins: [],
        macroOverrides: {},
        optimization: defaultOptimizationConfig('compact'),
      };
      const res = runFullPipeline(advSpec);
      expect(res.drc.passed).toBe(true);
      expect(res.drc.errorCount).toBe(0);
      expect(res.sta.passed).toBe(true);
    }

    // Space Age 4x4 Electromagnetic Plants + 4-beacon rows
    const emSpec = structuredClone(BUILTIN_PRESETS[0].spec);
    emSpec.pdk.spaceAgeBuildings = true;
    emSpec.pdk.defaultBeltTier = 'blue';
    emSpec.pdk.defaultInserterTier = 'stack';
    emSpec.pdk.allowedInserterTiers = ['yellow', 'long', 'fast', 'bulk', 'stack'];
    emSpec.pdk.beaconMode = 'row-4';
    emSpec.pdk.beaconModules = ['speed-module-3', 'speed-module-3'];

    const emRes = runFullPipeline(emSpec);
    expect(emRes.drc.passed).toBe(true);
    expect(emRes.drc.errorCount).toBe(0);
    expect(emRes.sta.passed).toBe(true);
    expect(emRes.allEntities.some((e) => e.name === 'electromagnetic-plant')).toBe(true);
    expect(emRes.allEntities.some((e) => e.name === 'beacon')).toBe(true);
  });
});
