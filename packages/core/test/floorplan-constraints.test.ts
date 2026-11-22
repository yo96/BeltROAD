import { describe, expect, it } from 'vitest';
import {
  BUILTIN_PRESETS,
  DesignSpec,
  defaultOptimizationConfig,
  defaultPdkConfig,
  runFullPipeline,
} from '../src/index.js';

describe('Die Size & Aspect Ratio Constraints', () => {
  it('adapts layout dimensions cleanly between tall (0.6) and wide (2.5) aspectRatio targets', () => {
    const presetIndices = [0, 1, 4]; // green-circuits, red-green-science, purple-science
    for (const idx of presetIndices) {
      const base = BUILTIN_PRESETS[idx];
      const tallSpec = structuredClone(base.spec);
      tallSpec.floorplan.mode = 'auto';
      tallSpec.floorplan.aspectRatio = 0.6;
      const tallRes = runFullPipeline(tallSpec);

      const wideSpec = structuredClone(base.spec);
      wideSpec.floorplan.mode = 'auto';
      wideSpec.floorplan.aspectRatio = 2.5;
      const wideRes = runFullPipeline(wideSpec);

      const tallAr = tallRes.floorplan.width / tallRes.floorplan.height;
      const wideAr = wideRes.floorplan.width / wideRes.floorplan.height;

      expect(tallRes.drc.passed).toBe(true);
      expect(tallRes.sta.passed).toBe(true);
      expect(wideRes.drc.passed).toBe(true);
      expect(wideRes.sta.passed).toBe(true);
      expect(tallAr).toBeLessThan(wideAr * 0.7);
    }
  });

  it('strictly enforces Fixed W x H die dimensions with 0 DRC errors and STA pass', () => {
    const cases: Array<{ presetIdx: number; dims: Array<[number, number]> }> = [
      { presetIdx: 0, dims: [[65, 65], [50, 75], [120, 45]] },
      { presetIdx: 1, dims: [[65, 65], [50, 75], [120, 45]] },
      { presetIdx: 4, dims: [[65, 65], [50, 75]] },
    ];

    for (const c of cases) {
      const base = BUILTIN_PRESETS[c.presetIdx];
      for (const [w, h] of c.dims) {
        const spec = structuredClone(base.spec);
        spec.floorplan.mode = 'fixed';
        spec.floorplan.width = w;
        spec.floorplan.height = h;
        const res = runFullPipeline(spec);

        expect(res.floorplan.width).toBe(w);
        expect(res.floorplan.height).toBe(h);
        expect(res.drc.errorCount).toBe(0);
        expect(res.drc.passed).toBe(true);
        expect(res.sta.passed).toBe(true);
      }
    }
  });

  it('preserves exact fixed dimensions and warns clearly when a fixed die is too tight', () => {
    const spec = structuredClone(BUILTIN_PRESETS[0].spec);
    spec.floorplan.mode = 'fixed';
    spec.floorplan.width = 35;
    spec.floorplan.height = 35;
    const res = runFullPipeline(spec);

    expect(res.floorplan.width).toBe(35);
    expect(res.floorplan.height).toBe(35);
    expect(res.floorplan.warnings.length).toBeGreaterThan(0);
  });

  it('tracks aspectRatio monotonically across 0.5, 1.0, and 2.5 on flat designs', () => {
    for (const idx of [0, 4]) {
      const base = BUILTIN_PRESETS[idx];
      const realized: number[] = [];
      for (const ar of [0.5, 1.0, 2.5]) {
        const s = structuredClone(base.spec);
        s.floorplan.mode = 'auto';
        s.floorplan.aspectRatio = ar;
        const r = runFullPipeline(s);
        expect(r.drc.errorCount).toBe(0);
        expect(r.sta.passed).toBe(true);
        realized.push(r.floorplan.width / r.floorplan.height);
      }
      expect(realized[0]).toBeLessThanOrEqual(realized[1]);
      expect(realized[1]).toBeLessThanOrEqual(realized[2]);
      expect(realized[0]).toBeLessThan(realized[2] * 0.7);
    }
  });

  it('adapts tiled megafactory grids cleanly across 0.5 portrait, 1.35 balanced, and 2.5 wide aspectRatio', () => {
    const makeSm3 = (ar: number): DesignSpec => ({
      version: 1,
      name: `SM3 60/min AR=${ar}`,
      pdk: {
        ...defaultPdkConfig(),
        defaultBeltTier: 'blue',
        defaultAssemblerTier: 3,
        defaultInserterTier: 'bulk',
      },
      targets: [{ item: 'speed-module-3', ratePerMin: 60 }],
      inputPreset: 'plates',
      inputOverrides: {},
      floorplan: { mode: 'auto', aspectRatio: ar, margin: 3, halo: 2 },
      pins: [],
      macroOverrides: {},
      optimization: defaultOptimizationConfig('compact'),
    });

    const portrait = runFullPipeline(makeSm3(0.5));
    const balanced = runFullPipeline(makeSm3(1.35));
    const wide = runFullPipeline(makeSm3(2.5));

    const arP = portrait.floorplan.width / portrait.floorplan.height;
    const arB = balanced.floorplan.width / balanced.floorplan.height;
    const arW = wide.floorplan.width / wide.floorplan.height;

    expect(portrait.tiling).toBeDefined();
    expect(balanced.tiling).toBeDefined();
    expect(wide.tiling).toBeDefined();
    expect(portrait.drc.errorCount).toBe(0);
    expect(portrait.sta.passed).toBe(true);
    expect(balanced.drc.errorCount).toBe(0);
    expect(balanced.sta.passed).toBe(true);
    expect(wide.drc.errorCount).toBe(0);
    expect(wide.sta.passed).toBe(true);

    expect(arP).toBeLessThan(0.75);
    expect(arB).toBeGreaterThanOrEqual(1.0);
    expect(arB).toBeLessThanOrEqual(1.9);
    expect(arW).toBeGreaterThanOrEqual(1.9);
  });
});
