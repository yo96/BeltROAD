import { describe, expect, it } from 'vitest';
import {
  BUILTIN_PRESETS,
  decodeBlueprintWrapper,
  defaultPdkConfig,
  runFullPipeline,
} from '../src/index.js';
import type { DesignSpec, PoleTier } from '../src/index.js';

describe('v2.6 Perimeter Bus Grouping & Train Station Headers', () => {
  it('defaults floorplan.headerMode to none so baseline specs contain no rail/chest headers', () => {
    const gc = BUILTIN_PRESETS.find((p) => p.id === 'green-circuits')!.spec;
    expect(gc.floorplan.headerMode ?? 'none').toBe('none');
    const out = runFullPipeline(structuredClone(gc));
    expect(out.drc.errorCount).toBe(0);
    expect(out.sta.passed).toBe(true);
    expect(out.allEntities.some((e) => e.name === 'straight-rail')).toBe(false);
    expect(out.allEntities.some((e) => e.name === 'train-stop')).toBe(false);
  });

  it('keeps multi-belt buses grouped contiguously in bus-header mode on Green Circuits and Blue Science', () => {
    const gcBase = BUILTIN_PRESETS.find((p) => p.id === 'green-circuits')!.spec;
    const gcBus: DesignSpec = {
      ...structuredClone(gcBase),
      name: 'Green Circuits Bus Header (3600/min)',
      targets: [{ item: 'electronic-circuit', ratePerMin: 3600 }],
      pins: [],
      floorplan: {
        ...gcBase.floorplan,
        headerMode: 'bus-header',
      },
    };
    const outGc = runFullPipeline(gcBus);
    expect(outGc.drc.errorCount, `GC bus DRC: ${JSON.stringify(outGc.drc.violations)}`).toBe(0);
    expect(outGc.sta.passed, `GC bus STA: ${outGc.sta.bottlenecks.join('; ')}`).toBe(true);

    // Multi-belt same-item West pins must be grouped contiguously with zero interleaving
    const westPins = outGc.floorplan.pins
      .filter((p) => p.edge === 'W')
      .sort((a, b) => a.offset - b.offset);
    expect(westPins.length).toBeGreaterThanOrEqual(4);
    const seenBus = new Set<string>();
    let prevBus = '';
    for (const p of westPins) {
      if (p.busId !== prevBus) {
        expect(seenBus.has(p.busId)).toBe(false);
        seenBus.add(p.busId);
        prevBus = p.busId;
      }
    }

    const blueBase = BUILTIN_PRESETS.find((p) => p.id === 'blue-science')!.spec;
    const blueBus: DesignSpec = {
      ...structuredClone(blueBase),
      floorplan: {
        ...blueBase.floorplan,
        headerMode: 'bus-header',
      },
    };
    const outBlue = runFullPipeline(blueBus);
    expect(outBlue.drc.errorCount, `Blue bus DRC: ${JSON.stringify(outBlue.drc.violations)}`).toBe(0);
    expect(outBlue.sta.passed, `Blue bus STA: ${outBlue.sta.bottlenecks.join('; ')}`).toBe(true);
  });

  it('compiles train-station bay headers across small/medium/substation poles on Green Circuits & Blue Science', () => {
    const gcBase = BUILTIN_PRESETS.find((p) => p.id === 'green-circuits')!.spec;
    const blueBase = BUILTIN_PRESETS.find((p) => p.id === 'blue-science')!.spec;

    for (const poleTier of ['small', 'medium', 'substation'] as PoleTier[]) {
      const gcTrain: DesignSpec = {
        ...structuredClone(gcBase),
        name: `GC Train (${poleTier})`,
        pdk: { ...defaultPdkConfig(), defaultPoleTier: poleTier },
        floorplan: { ...gcBase.floorplan, headerMode: 'train-station' },
      };
      const outGc = runFullPipeline(gcTrain);
      expect(outGc.drc.errorCount, `GC train ${poleTier}: ${JSON.stringify(outGc.drc.violations)}`).toBe(0);
      expect(outGc.sta.passed, `GC train ${poleTier} STA: ${outGc.sta.bottlenecks.join('; ')}`).toBe(true);

      const rails = outGc.allEntities.filter((e) => e.name === 'straight-rail');
      const stops = outGc.allEntities.filter((e) => e.name === 'train-stop');
      const chests = outGc.allEntities.filter((e) => e.name === 'steel-chest');
      expect(rails.length).toBeGreaterThan(0);
      expect(stops.length).toBe(2);
      expect(chests.length).toBeGreaterThanOrEqual(outGc.floorplan.pins.length);
      for (const r of rails) {
        expect(r.tx % 2).toBe(0);
        expect(r.ty % 2).toBe(0);
      }

      const decoded = decodeBlueprintWrapper(outGc.blueprintString);
      const bpStops = (decoded.blueprint?.entities ?? []).filter((e) => e.name === 'train-stop');
      expect(bpStops.length).toBe(2);
      expect(bpStops.some((s) => (s.station ?? '').includes('IN'))).toBe(true);
      expect(bpStops.some((s) => (s.station ?? '').includes('OUT'))).toBe(true);
    }

    const blueTrain: DesignSpec = {
      ...structuredClone(blueBase),
      name: 'Blue Science Train',
      floorplan: { ...blueBase.floorplan, headerMode: 'train-station' },
    };
    const outBlue = runFullPipeline(blueTrain);
    expect(outBlue.drc.errorCount, `Blue train DRC: ${JSON.stringify(outBlue.drc.violations)}`).toBe(0);
    expect(outBlue.sta.passed, `Blue train STA: ${outBlue.sta.bottlenecks.join('; ')}`).toBe(true);
    expect(outBlue.drc.violations.some((v) => v.code === 'NO_FLUID_MIXING')).toBe(false);
    expect(outBlue.allEntities.some((e) => e.name === 'straight-rail')).toBe(true);
  });
});
