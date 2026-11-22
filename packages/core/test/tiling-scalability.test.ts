import { describe, expect, it } from 'vitest';
import {
  BUILTIN_PRESETS,
  DesignSpec,
  decodeBlueprintWrapper,
  defaultOptimizationConfig,
  defaultPdkConfig,
  runFullPipeline,
} from '../src/index.js';

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
    expect(res.elapsedMs).toBeLessThan(2500);
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
    expect(res.elapsedMs).toBeLessThan(3500);
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
    expect(res.elapsedMs).toBeLessThan(2500);
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
});
