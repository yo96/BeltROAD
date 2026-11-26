import { describe, expect, it } from 'vitest';
import {
  BUILTIN_BALANCERS,
  BUILTIN_PRESETS,
  compileBalancerMacro,
  generateProceduralBalancer,
  remapBalancerTier,
  runDrc,
  runFullPipeline,
} from '../src/index.js';

describe('Balancer Hard-IP Library', () => {
  it('passes DRC on all built-in curated balancers', () => {
    for (const tpl of BUILTIN_BALANCERS) {
      const macro = compileBalancerMacro({
        id: `test-${tpl.id}`,
        kind: 'balancer-macro',
        item: 'iron-plate',
        inputs: tpl.inputs,
        outputs: tpl.outputs,
        beltTier: 'yellow',
        totalRatePerSec: 15,
        templateId: tpl.id,
      });

      expect(macro.pins.filter((p) => p.kind === 'input')).toHaveLength(tpl.inputs);
      expect(macro.pins.filter((p) => p.kind === 'output')).toHaveLength(tpl.outputs);

      const drc = runDrc(macro.entities, macro.width, macro.height);
      expect(drc.violations, `Balancer ${tpl.id} DRC errors`).toEqual([]);
      expect(drc.passed).toBe(true);
    }
  });

  it('passes DRC on procedural N x M balancers and tier remapping', () => {
    const exoticSizes = [
      [1, 5],
      [5, 1],
      [5, 3],
      [3, 5],
      [6, 4],
    ] as const;

    for (const [inp, out] of exoticSizes) {
      const tpl = generateProceduralBalancer(inp, out, 'red');
      expect(tpl.inputPorts).toHaveLength(inp);
      expect(tpl.outputPorts).toHaveLength(out);

      const macro = compileBalancerMacro(
        {
          id: `proc-${inp}x${out}`,
          kind: 'balancer-macro',
          item: 'copper-plate',
          inputs: inp,
          outputs: out,
          beltTier: 'red',
          totalRatePerSec: 60,
          templateId: tpl.id,
        },
        [tpl],
      );

      const drc = runDrc(macro.entities, macro.width, macro.height);
      expect(drc.violations, `Procedural ${inp}x${out}`).toEqual([]);
    }

    // Verify blue->yellow tier remapping falls back cleanly if underground span > 5
    const longUgTemplate = {
      ...BUILTIN_BALANCERS[0],
      id: 'long-ug-test',
      beltTier: 'blue' as const,
      maxUgDistance: 9,
      entities: [
        { tx: 0, ty: 0, w: 1, h: 1, kind: 'underground' as const, direction: 4, ugType: 'input' as const },
        { tx: 8, ty: 0, w: 1, h: 1, kind: 'underground' as const, direction: 4, ugType: 'output' as const },
      ],
    };
    const remapped = remapBalancerTier(longUgTemplate, 'yellow');
    expect(remapped.beltTier).toBe('yellow');
    expect(remapped.source).toBe('procedural');
  });

  it('compiles 1x2, 2x1, 2x2 splitters as 1x2 single entities without stub belts and routes direct turns', () => {
    for (const id of ['builtin-1x2', 'builtin-2x1', 'builtin-2x2'] as const) {
      const tpl = BUILTIN_BALANCERS.find((b) => b.id === id)!;
      const macro = compileBalancerMacro({
        id: `compact-${id}`,
        kind: 'balancer-macro',
        item: 'iron-plate',
        inputs: tpl.inputs,
        outputs: tpl.outputs,
        beltTier: 'red',
        totalRatePerSec: 15,
        templateId: id,
      });
      expect(macro.width).toBe(1);
      expect(macro.height).toBe(2);
      expect(macro.entities).toHaveLength(1);
      expect(macro.entities[0].name).toBe('fast-splitter');
    }

    const b1x4 = BUILTIN_BALANCERS.find((b) => b.id === 'builtin-1x4')!;
    expect(b1x4.width).toBe(3);
    const b4x1 = BUILTIN_BALANCERS.find((b) => b.id === 'builtin-4x1')!;
    expect(b4x1.width).toBe(2);
    const b4x4 = BUILTIN_BALANCERS.find((b) => b.id === 'builtin-4x4')!;
    expect(b4x4.width).toBe(8);
    expect(generateProceduralBalancer(1, 5, 'red').width).toBe(4);
    expect(generateProceduralBalancer(5, 1, 'red').width).toBe(4);
    expect(generateProceduralBalancer(5, 3, 'red').width).toBe(6);

    // End-to-end check on Red + Green Science (uses splitters) -> DRC=0, STA=PASS, no 1x2/2x1 balancer stub belts
    const rgPreset = BUILTIN_PRESETS.find((p) => p.id === 'red-green-science')!;
    const out = runFullPipeline(structuredClone(rgPreset.spec));
    expect(out.drc.errorCount, JSON.stringify(out.drc.violations)).toBe(0);
    expect(out.sta.passed, out.sta.bottlenecks.join('; ')).toBe(true);
    const compactBals = out.floorplan.macros.filter(
      (pm) => pm.macro.kind === 'balancer-macro' && (pm.macro.label === '1×2 Bal' || pm.macro.label === '2×1 Bal'),
    );
    expect(compactBals.length).toBeGreaterThan(0);
    for (const pm of compactBals) {
      expect(pm.macro.entities).toHaveLength(1);
    }
  });
});
