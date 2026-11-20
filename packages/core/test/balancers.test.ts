import { describe, expect, it } from 'vitest';
import {
  BUILTIN_BALANCERS,
  compileBalancerMacro,
  generateProceduralBalancer,
  remapBalancerTier,
  runDrc,
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
});
