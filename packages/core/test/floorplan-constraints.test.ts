import { describe, expect, it } from 'vitest';
import { BUILTIN_PRESETS, runFullPipeline } from '../src/index.js';

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
});
