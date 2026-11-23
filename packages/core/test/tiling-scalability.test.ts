import { describe, expect, it } from 'vitest';
import {
  BUILTIN_PRESETS,
  DesignSpec,
  decodeBlueprintWrapper,
  defaultOptimizationConfig,
  defaultPdkConfig,
  runFullPipeline,
} from '../src/index.js';

const CI_TIME_MULT = process.env.CI ? 4 : 1;

function makeSpec(
  name: string,
  targets: DesignSpec['targets'],
  opts?: {
    belt?: 'yellow' | 'red' | 'blue';
    asm?: 1 | 2 | 3;
    ins?: 'yellow' | 'fast' | 'bulk';
    tiling?: 'auto' | 'off' | number;
    tileLayout?: 'auto' | 'stack' | 'twin';
  },
): DesignSpec {
  const baseOpt = defaultOptimizationConfig('compact');
  return {
    version: 1,
    name,
    pdk: {
      ...defaultPdkConfig(),
      defaultBeltTier: opts?.belt ?? 'blue',
      defaultAssemblerTier: opts?.asm ?? 3,
      defaultInserterTier: opts?.ins ?? 'bulk',
    },
    targets,
    inputPreset: 'plates',
    inputOverrides: {},
    floorplan: { mode: 'auto', aspectRatio: 1.35, margin: 3, halo: 2 },
    pins: [],
    macroOverrides: {},
    optimization: {
      ...baseOpt,
      tiling: opts?.tiling ?? 'auto',
      tileLayout: opts?.tileLayout ?? 'auto',
    },
  };
}

describe('Hierarchical Tiling & Scalability Benchmarks', () => {
  it('tiles 60/min speed-module-3 (blue/Asm3/bulk) with 0 DRC errors, STA pass, and sub-2.5s runtime', () => {
    const spec = makeSpec(
      'Speed Module 3 (60/min blue)',
      [{ item: 'speed-module-3', ratePerMin: 60 }],
      { belt: 'blue', asm: 3, ins: 'bulk' },
    );
    const res = runFullPipeline(spec);
    console.log(
      `[Scale SM3 60/m Blue] ${res.tiling?.tileCount}x (${res.tiling?.layout} ${res.tiling?.cols}x${res.tiling?.rows}), ${res.floorplan.width}x${res.floorplan.height}, ${res.bom.totalMachines} machines, ${res.elapsedMs}ms, DRC=${res.drc.errorCount}, STA=${res.sta.passed}`,
    );

    expect(res.tiling).toBeDefined();
    expect(res.tiling!.tileCount).toBeGreaterThanOrEqual(4);
    expect(res.drc.errorCount).toBe(0);
    expect(res.drc.passed).toBe(true);
    expect(res.sta.passed).toBe(true);
    expect(res.elapsedMs).toBeLessThan(2500 * CI_TIME_MULT);
    expect(res.bom.totalMachines).toBeGreaterThanOrEqual(1000);
    expect(res.blueprintString.startsWith('0eN')).toBe(true);
    expect(res.tiling!.unitBlueprintString.startsWith('0eN')).toBe(true);

    const decoded = decodeBlueprintWrapper(res.blueprintString);
    const decodedMachines = decoded.blueprint.entities.filter((e) =>
      e.name.startsWith('assembling-machine'),
    ).length;
    expect(decodedMachines).toBeGreaterThanOrEqual(1000);
    expect(decodedMachines).toBe(res.bom.totalMachines);
  });

  it('tiles 60/min speed-module-3 (red/Asm2/fast) cleanly under 3.5s', () => {
    const spec = makeSpec(
      'Speed Module 3 (60/min red)',
      [{ item: 'speed-module-3', ratePerMin: 60 }],
      { belt: 'red', asm: 2, ins: 'fast' },
    );
    const res = runFullPipeline(spec);
    console.log(
      `[Scale SM3 60/m Red] ${res.tiling?.tileCount}x (${res.tiling?.layout} ${res.tiling?.cols}x${res.tiling?.rows}), ${res.floorplan.width}x${res.floorplan.height}, ${res.bom.totalMachines} machines, ${res.elapsedMs}ms, DRC=${res.drc.errorCount}, STA=${res.sta.passed}`,
    );

    expect(res.tiling).toBeDefined();
    expect(res.drc.errorCount).toBe(0);
    expect(res.drc.passed).toBe(true);
    expect(res.sta.passed).toBe(true);
    expect(res.elapsedMs).toBeLessThan(3500 * CI_TIME_MULT);
  });

  it('tiles 600/min red+green science (blue/Asm3/bulk) in twin-wing layout under 2.5s', () => {
    const spec = makeSpec(
      'Red + Green Science (600/min)',
      [
        { item: 'automation-science-pack', ratePerMin: 600 },
        { item: 'logistic-science-pack', ratePerMin: 600 },
      ],
      { belt: 'blue', asm: 3, ins: 'bulk' },
    );
    const res = runFullPipeline(spec);
    console.log(
      `[Scale Science 600/m] ${res.tiling?.tileCount}x (${res.tiling?.layout} ${res.tiling?.cols}x${res.tiling?.rows}), ${res.floorplan.width}x${res.floorplan.height}, ${res.bom.totalMachines} machines, ${res.elapsedMs}ms, DRC=${res.drc.errorCount}, STA=${res.sta.passed}`,
    );

    expect(res.tiling).toBeDefined();
    expect(res.tiling!.layout).toBe('twin');
    expect(res.drc.errorCount).toBe(0);
    expect(res.drc.passed).toBe(true);
    expect(res.sta.passed).toBe(true);
    expect(res.elapsedMs).toBeLessThan(2500 * CI_TIME_MULT);
  });

  it('respects explicit tileLayout: stack mode on 60/min speed-module-3', () => {
    const spec = makeSpec(
      'Speed Module 3 (60/min stack)',
      [{ item: 'speed-module-3', ratePerMin: 60 }],
      { belt: 'blue', asm: 3, ins: 'bulk', tileLayout: 'stack' },
    );
    const res = runFullPipeline(spec);

    expect(res.tiling).toBeDefined();
    expect(res.tiling!.layout).toBe('stack');
    expect(res.drc.errorCount).toBe(0);
    expect(res.drc.passed).toBe(true);
    expect(res.sta.passed).toBe(true);
  });

  it('keeps tiling disabled when tiling is off or on small flat designs', () => {
    const smallFlat = makeSpec(
      'Red + Green Science (90/min off)',
      [
        { item: 'automation-science-pack', ratePerMin: 90 },
        { item: 'logistic-science-pack', ratePerMin: 90 },
      ],
      { belt: 'red', asm: 2, ins: 'fast', tiling: 'off' },
    );
    const smallRes = runFullPipeline(smallFlat);
    expect(smallRes.tiling).toBeUndefined();
    expect(smallRes.drc.passed).toBe(true);

    const preset = structuredClone(BUILTIN_PRESETS[1].spec);
    const presetRes = runFullPipeline(preset);
    expect(presetRes.tiling).toBeUndefined();
  });

  it('compiles 20/min productivity-module-3 quickly even when starting from a preset with N/S pins', () => {
    const redPreset = BUILTIN_PRESETS.find((p) => p.id === 'red-circuits')!;
    const spec = structuredClone(redPreset.spec);
    spec.targets = [{ item: 'productivity-module-3', ratePerMin: 20 }];

    const res = runFullPipeline(spec);
    expect(res.tiling).toBeDefined();
    expect(res.elapsedMs).toBeLessThan(2500 * CI_TIME_MULT);
    expect(res.drc.errorCount).toBe(0);
    expect(res.drc.passed).toBe(true);
    expect(res.sta.passed).toBe(true);
  });

  it('compiles 20/min productivity-module-3 quickly in Fixed W x H die mode', () => {
    const fitting = makeSpec(
      'Prod Module 3 (20/min fixed 320x260)',
      [{ item: 'productivity-module-3', ratePerMin: 20 }],
      { belt: 'red', asm: 2, ins: 'fast' },
    );
    fitting.floorplan = { mode: 'fixed', width: 320, height: 260, aspectRatio: 1.23, margin: 3, halo: 2 };
    const fitRes = runFullPipeline(fitting);
    expect(fitRes.tiling).toBeDefined();
    expect(fitRes.elapsedMs).toBeLessThan(2500 * CI_TIME_MULT);
    expect(fitRes.floorplan.width).toBe(320);
    expect(fitRes.floorplan.height).toBe(260);
    expect(fitRes.drc.errorCount).toBe(0);
    expect(fitRes.sta.passed).toBe(true);

    const tight = makeSpec(
      'Prod Module 3 (20/min fixed 200x200)',
      [{ item: 'productivity-module-3', ratePerMin: 20 }],
      { belt: 'red', asm: 2, ins: 'fast' },
    );
    tight.floorplan = { mode: 'fixed', width: 200, height: 200, aspectRatio: 1.0, margin: 3, halo: 2 };
    const tightRes = runFullPipeline(tight);
    expect(tightRes.tiling).toBeDefined();
    expect(tightRes.elapsedMs).toBeLessThan(2500 * CI_TIME_MULT);
    expect(tightRes.drc.errorCount).toBe(0);
    expect(tightRes.sta.passed).toBe(true);
    expect(tightRes.floorplan.warnings.length).toBeGreaterThan(0);
  });

  it('sizes inserter I/O for 20/min productivity-module-3 with speed-module-2/3 fills so tiling passes under 2.5s', () => {
    for (const mod of ['speed-module-2', 'speed-module-3'] as const) {
      for (const belt of ['yellow', 'blue'] as const) {
        const spec = makeSpec(
          `Prod Module 3 (20/min ${belt} ${mod})`,
          [{ item: 'productivity-module-3', ratePerMin: 20 }],
          { belt, asm: 3, ins: 'bulk' },
        );
        spec.pdk.modules.global = [mod, mod, mod, mod];
        const res = runFullPipeline(spec);
        expect(res.tiling, `${belt}/${mod}`).toBeDefined();
        expect(res.elapsedMs, `${belt}/${mod}`).toBeLessThan(2500 * CI_TIME_MULT);
        expect(res.drc.errorCount, `${belt}/${mod}`).toBe(0);
        expect(res.sta.passed, `${belt}/${mod}`).toBe(true);
      }
    }
  });

  it('bounds explicit flat mode (tiling: off) on 20/min productivity-module-3 without hanging', () => {
    const flatSpec = makeSpec(
      'Prod Module 3 (20/min flat bounded)',
      [{ item: 'productivity-module-3', ratePerMin: 20 }],
      { belt: 'red', asm: 2, ins: 'fast', tiling: 'off' },
    );
    const t0 = Date.now();
    const res = runFullPipeline(flatSpec);
    expect(res.tiling).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(7000 * CI_TIME_MULT);
  });

  it('routes multi-bay interior trunks to North outer edge when requireEdgePins is true (default), even with small poles & fixed die', () => {
    const assertAllPinsOnOuterEdge = (
      pins: ReturnType<typeof runFullPipeline>['floorplan']['pins'],
      W: number,
      H: number,
    ) => {
      for (const p of pins) {
        const onEdge =
          (p.edge === 'W' && p.x === 0) ||
          (p.edge === 'E' && p.x === W - 1) ||
          (p.edge === 'N' && p.y === 0) ||
          (p.edge === 'S' && p.y === H - 1);
        expect(onEdge, `pin ${p.id} (${p.edge} at ${p.x},${p.y}) vs ${W}x${H}`).toBe(true);
      }
    };

    const sm3Default = makeSpec(
      'SM3 60/min Edge Pins Default',
      [{ item: 'speed-module-3', ratePerMin: 60 }],
      { belt: 'blue', asm: 3, ins: 'bulk' },
    );
    sm3Default.pdk.defaultPoleTier = 'small';
    const resDef = runFullPipeline(sm3Default);
    expect(resDef.tiling).toBeDefined();
    expect(resDef.tiling!.cols).toBeGreaterThanOrEqual(4); // multi-bay (2+ twin bays)
    expect(resDef.drc.violations).toEqual([]);
    expect(resDef.drc.passed).toBe(true);
    expect(resDef.sta.passed).toBe(true);
    assertAllPinsOnOuterEdge(resDef.floorplan.pins, resDef.floorplan.width, resDef.floorplan.height);
    expect(resDef.floorplan.pins.some((p) => p.edge === 'N' && p.y === 0)).toBe(true);

    // Also verify Fixed W x H preserves N/W/E/S outer perimeter pins cleanly
    const sm3Fixed = structuredClone(sm3Default);
    sm3Fixed.floorplan = {
      mode: 'fixed',
      width: resDef.floorplan.width + 20,
      height: resDef.floorplan.height + 20,
      aspectRatio: 1.5,
      margin: 3,
      halo: 2,
      requireEdgePins: true,
    };
    const resFixed = runFullPipeline(sm3Fixed);
    expect(resFixed.drc.violations).toEqual([]);
    expect(resFixed.sta.passed).toBe(true);
    expect(resFixed.floorplan.width).toBe(resDef.floorplan.width + 20);
    expect(resFixed.floorplan.height).toBe(resDef.floorplan.height + 20);
    assertAllPinsOnOuterEdge(
      resFixed.floorplan.pins,
      resFixed.floorplan.width,
      resFixed.floorplan.height,
    );
  });

  it('allows compact interior multi-bay pins when requireEdgePins is false', () => {
    const specEdge = makeSpec(
      'SM3 60/min Edge Pins On',
      [{ item: 'speed-module-3', ratePerMin: 60 }],
      { belt: 'blue', asm: 3, ins: 'bulk', tiling: 14 },
    );
    const resEdge = runFullPipeline(specEdge);

    const specInterior = structuredClone(specEdge);
    specInterior.floorplan.requireEdgePins = false;
    const resInt = runFullPipeline(specInterior);

    expect(resInt.tiling).toBeDefined();
    expect(resInt.tiling!.cols).toBeGreaterThanOrEqual(4);
    expect(resInt.drc.violations).toEqual([]);
    expect(resInt.sta.passed).toBe(true);
    expect(resInt.floorplan.pins.some((p) => p.x > 0 && p.x < resInt.floorplan.width - 1 && (p.edge === 'W' || p.edge === 'E'))).toBe(true);
    expect(resInt.floorplan.width).toBeLessThan(resEdge.floorplan.width);
  });
});
