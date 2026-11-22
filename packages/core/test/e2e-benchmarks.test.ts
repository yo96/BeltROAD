import { describe, expect, it } from 'vitest';
import {
  BUILTIN_PRESETS,
  PipelineResult,
  PlacedMacro,
  SynthesisResult,
  compileBalancerMacro,
  decodeBlueprintWrapper,
  optimizePortAssignments,
  runFullPipeline,
} from '../src/index.js';

const CI_TIME_MULT = process.env.CI ? 4 : 1;

function logBenchmark(tag: string, res: PipelineResult) {
  const area = res.floorplan.width * res.floorplan.height;
  const entityTiles = res.allEntities.reduce(
    (sum, e) => sum + (e.role === 'port-marker' ? 0 : e.w * e.h),
    0,
  );
  const density = ((entityTiles / area) * 100).toFixed(1);
  const ugs = res.route.routedNets.reduce((sum, r) => sum + r.undergroundCount, 0);
  let bends = 0;
  for (const r of res.route.routedNets) {
    for (let i = 1; i < r.tiles.length; i++) {
      if (r.tiles[i].dir !== r.tiles[i - 1].dir) bends++;
    }
  }
  console.log(
    `[Benchmark ${tag}] ${res.floorplan.width}x${res.floorplan.height} (${area} tiles, ${density}% density), ${res.bom.totalMachines} machines, ${res.route.entities.length} route belts (${ugs} UGs, ${bends} bends), ${res.route.iterations} iters, ${res.elapsedMs}ms`,
  );
  return { area, density: Number(density), ugs, bends };
}

describe('End-to-End P&R Benchmarks', () => {
  it('completes Green Circuits (1800/min, 1 red belt) with 0 DRC errors, STA pass, and tight compaction', () => {
    const spec = structuredClone(BUILTIN_PRESETS[0].spec);
    const res = runFullPipeline(spec);
    const m = logBenchmark('green-circuits', res);

    expect(res.drc.violations).toEqual([]);
    expect(res.drc.passed).toBe(true);
    expect(res.sta.passed).toBe(true);
    expect(m.area).toBeLessThan(3500);
    expect(res.elapsedMs).toBeLessThan(1500 * CI_TIME_MULT);
    expect(res.blueprintString.startsWith('0eN')).toBe(true);
    const decoded = decodeBlueprintWrapper(res.blueprintString);
    expect(decoded.blueprint?.entities.length).toBeGreaterThan(20);
  });

  it('completes Red + Green Science (60/min each) with 0 DRC errors, STA pass, and tight compaction', () => {
    const spec = structuredClone(BUILTIN_PRESETS[1].spec);
    const res = runFullPipeline(spec);
    const m = logBenchmark('red-green-science', res);

    expect(res.drc.violations).toEqual([]);
    expect(res.drc.passed).toBe(true);
    expect(res.sta.passed).toBe(true);
    expect(m.area).toBeLessThan(2200);
    expect(res.elapsedMs).toBeLessThan(1000 * CI_TIME_MULT);
    expect(res.blueprintString.startsWith('0eN')).toBe(true);
  });

  it('completes Red Circuits (60/min) respecting explicit edge + offset pin constraints', () => {
    const spec = structuredClone(BUILTIN_PRESETS[2].spec);
    spec.pins = [
      { id: 'in:iron-plate:0', edge: 'W', offset: 10, locked: true },
      { id: 'in:copper-plate:0', edge: 'W', offset: 14, locked: true },
      { id: 'in:plastic-bar:0', edge: 'N', offset: 12, locked: true },
      { id: 'out:advanced-circuit:0', edge: 'E', offset: 12, locked: true },
    ];

    const res = runFullPipeline(spec);
    logBenchmark('red-circuits', res);

    expect(res.drc.violations).toEqual([]);
    expect(res.drc.passed).toBe(true);
    expect(res.sta.passed).toBe(true);
    expect(res.elapsedMs).toBeLessThan(1000 * CI_TIME_MULT);

    const plasticPin = res.floorplan.pins.find((p) => p.id === 'in:plastic-bar:0')!;
    expect(plasticPin.edge).toBe('N');
    expect(plasticPin.offset).toBe(12);
    expect(plasticPin.y).toBe(0);

    const outPin = res.floorplan.pins.find((p) => p.id === 'out:advanced-circuit:0')!;
    expect(outPin.edge).toBe('E');
    expect(outPin.offset).toBe(12);
  });

  it('completes Military Science (60/min) with a locked macro position & rotation override', () => {
    const spec = structuredClone(BUILTIN_PRESETS[3].spec);
    spec.macroOverrides = {
      'macro:military-science-pack': {
        x: 24,
        y: 12,
        rotation: 0,
        locked: true,
      },
    };

    const res = runFullPipeline(spec);
    logBenchmark('military-science', res);

    expect(res.drc.violations).toEqual([]);
    expect(res.drc.passed).toBe(true);
    expect(res.sta.passed).toBe(true);
    expect(res.elapsedMs).toBeLessThan(1000 * CI_TIME_MULT);

    const lockedMacro = res.floorplan.macros.find(
      (m) => m.id === 'macro:military-science-pack',
    )!;
    expect(lockedMacro.x).toBe(24);
    expect(lockedMacro.y).toBe(12);
    expect(lockedMacro.locked).toBe(true);
  });

  it('completes Production Science (30/min) with 0 DRC errors, STA pass, and tight compaction', () => {
    const spec = structuredClone(BUILTIN_PRESETS[4].spec);
    const res = runFullPipeline(spec);
    const m = logBenchmark('purple-science', res);

    expect(res.drc.violations).toEqual([]);
    expect(res.drc.passed).toBe(true);
    expect(res.sta.passed).toBe(true);
    expect(m.area).toBeLessThan(3200);
    expect(res.elapsedMs).toBeLessThan(1500 * CI_TIME_MULT);
    expect(res.blueprintString.startsWith('0eN')).toBe(true);
  });

  it('uncrosses inverted balancer ports cleanly via optimizePortAssignments', () => {
    const bal = compileBalancerMacro({
      id: 'bal:test:1x2',
      kind: 'balancer-macro',
      item: 'iron-plate',
      inputs: 1,
      outputs: 2,
      beltTier: 'yellow',
      totalRatePerSec: 10,
      templateId: 'builtin-1x2',
    });
    const pm: PlacedMacro = {
      id: 'bal:test:1x2',
      macro: bal,
      x: 5,
      y: 10,
      locked: false,
      variants: [bal],
    };
    const pins = [
      {
        id: 'out:a:0',
        busId: 'out:a',
        busIndex: 0,
        kind: 'output' as const,
        item: 'iron-plate',
        ratePerSec: 5,
        beltTier: 'yellow' as const,
        edge: 'E' as const,
        offset: 5,
        x: 20,
        y: 5,
        dir: 4,
        order: 0,
        locked: false,
      },
      {
        id: 'out:b:0',
        busId: 'out:b',
        busIndex: 0,
        kind: 'output' as const,
        item: 'iron-plate',
        ratePerSec: 5,
        beltTier: 'yellow' as const,
        edge: 'E' as const,
        offset: 18,
        x: 20,
        y: 18,
        dir: 4,
        order: 1,
        locked: false,
      },
    ];
    // Intentionally criss-crossed: out:1 (bottom) -> top pin, out:0 (top) -> bottom pin
    const synth = {
      nets: [
        {
          id: 'n0',
          busId: 'iron-plate',
          busIndex: 0,
          item: 'iron-plate',
          ratePerSec: 5,
          beltTier: 'yellow' as const,
          source: { nodeId: 'bal:test:1x2', pinId: 'out:1', kind: 'source' as const, item: 'iron-plate' },
          sink: { nodeId: 'out:a:0', pinId: 'out:a:0', kind: 'sink' as const, item: 'iron-plate' },
        },
        {
          id: 'n1',
          busId: 'iron-plate',
          busIndex: 1,
          item: 'iron-plate',
          ratePerSec: 5,
          beltTier: 'yellow' as const,
          source: { nodeId: 'bal:test:1x2', pinId: 'out:0', kind: 'source' as const, item: 'iron-plate' },
          sink: { nodeId: 'out:b:0', pinId: 'out:b:0', kind: 'sink' as const, item: 'iron-plate' },
        },
      ],
    } as unknown as SynthesisResult;

    optimizePortAssignments(synth, [pm], pins);
    expect(synth.nets[0].source.pinId).toBe('out:0');
    expect(synth.nets[1].source.pinId).toBe('out:1');
  });
});
