import { describe, expect, it } from 'vitest';
import {
  BUILTIN_PRESETS,
  decodeBlueprintWrapper,
  defaultOptimizationConfig,
  defaultPdkConfig,
  runFullPipeline,
  synthesizeDesign,
} from '../src/index.js';
import type { DesignSpec, PoleTier, RecipeMacroSpec } from '../src/index.js';

function makeDirectSpec(overrides: Partial<DesignSpec>): DesignSpec {
  const base = BUILTIN_PRESETS[0].spec;
  return {
    ...structuredClone(base),
    ...overrides,
    pdk: {
      ...defaultPdkConfig(),
      ...(overrides.pdk ?? {}),
    },
    optimization: {
      ...defaultOptimizationConfig('compact'),
      directInsertion: true,
      ...(overrides.optimization ?? {}),
    },
  };
}

describe('v2.4 direct-insertion compound macros', () => {
  it('defaults directInsertion to false so baseline synthesis keeps separate copper-cable macro', () => {
    const entry = BUILTIN_PRESETS.find((p) => p.id === 'green-circuits')!;
    const spec = entry.spec;
    expect(spec.optimization?.directInsertion ?? false).toBe(false);
    const synth = synthesizeDesign(spec);
    const recipeIds = synth.nodes
      .filter((n): n is RecipeMacroSpec => n.kind === 'recipe-macro')
      .map((n) => n.recipeId);
    expect(recipeIds).toContain('copper-cable');
    expect(recipeIds).toContain('electronic-circuit');
    expect(
      synth.nodes.some((n) => n.kind === 'recipe-macro' && Boolean(n.directInsert)),
    ).toBe(false);
  });

  it('fuses 3:2 copper-cable -> electronic-circuit across small, medium, and substation poles with DRC=0 & STA PASS', () => {
    const poleTiers: PoleTier[] = ['small', 'medium', 'substation'];
    for (const poleTier of poleTiers) {
      const spec = makeDirectSpec({
        name: `Green Circuits 3:2 (${poleTier})`,
        inputPreset: 'plates',
        targets: [{ item: 'electronic-circuit', ratePerMin: 900 }],
        pdk: {
          ...defaultPdkConfig(),
          defaultAssemblerTier: 2,
          defaultPoleTier: poleTier,
          defaultBeltTier: 'red',
        },
      });

      const out = runFullPipeline(spec);
      expect(out.drc.errorCount, `${poleTier} DRC: ${JSON.stringify(out.drc.violations)}`).toBe(0);
      expect(out.sta.passed, `${poleTier} STA: ${out.sta.bottlenecks.join('; ')}`).toBe(true);

      const recipeMacros = out.synthesis.nodes.filter(
        (n): n is RecipeMacroSpec => n.kind === 'recipe-macro',
      );
      expect(recipeMacros.some((m) => m.recipeId === 'copper-cable')).toBe(false);

      const ecMacro = recipeMacros.find((m) => m.recipeId === 'electronic-circuit');
      expect(ecMacro?.directInsert?.ratio).toBe('3:2');
      expect(ecMacro?.directInsert?.producerRecipeId).toBe('copper-cable');
      expect(
        out.allEntities.some((e) => e.role === 'inserter-direct' && e.macroId === ecMacro!.id),
      ).toBe(true);

      const decoded = decodeBlueprintWrapper(out.blueprintString);
      expect((decoded.blueprint?.entities ?? []).length).toBeGreaterThan(0);
    }
  });

  it('compiles full 1-red-belt Green Circuits (1800/min) with 3:2 direct insertion and balanced output lanes', () => {
    const base = BUILTIN_PRESETS.find((p) => p.id === 'green-circuits')!.spec;
    const spec: DesignSpec = {
      ...structuredClone(base),
      optimization: {
        ...defaultOptimizationConfig('compact'),
        directInsertion: true,
      },
    };
    const out = runFullPipeline(spec);
    expect(out.drc.errorCount, `1800/min DRC: ${JSON.stringify(out.drc.violations)}`).toBe(0);
    expect(out.sta.passed, `1800/min STA: ${out.sta.bottlenecks.join('; ')}`).toBe(true);
    const ecMacros = out.synthesis.nodes.filter(
      (n): n is RecipeMacroSpec =>
        n.kind === 'recipe-macro' && n.recipeId === 'electronic-circuit',
    );
    expect(ecMacros.length).toBeGreaterThan(0);
    expect(ecMacros.every((m) => m.directInsert?.ratio === '3:2')).toBe(true);
    expect(
      out.synthesis.nodes.some(
        (n) => n.kind === 'recipe-macro' && n.recipeId === 'copper-cable',
      ),
    ).toBe(false);
  });

  it('fuses 1:2 iron-stick -> rail (single unit and multi-unit + Production Science) cleanly', () => {
    const purple = BUILTIN_PRESETS.find(
      (p) => p.id === 'purple-science' || p.spec.name.includes('Production Science'),
    )!.spec;
    for (const [name, targets] of [
      ['Rail 1 unit', [{ item: 'rail', ratePerMin: 240 }]],
      ['Rail multi-unit', [{ item: 'rail', ratePerMin: 900 }]],
      ['Production Science + Rail', purple.targets],
    ] as const) {
      const spec = makeDirectSpec({
        name,
        inputPreset: 'plates',
        targets: [...targets],
        pdk: {
          ...defaultPdkConfig(),
          defaultAssemblerTier: 2,
          defaultBeltTier: 'red',
        },
      });

      const out = runFullPipeline(spec);
      expect(out.drc.errorCount, `${name} DRC: ${JSON.stringify(out.drc.violations)}`).toBe(0);
      expect(out.sta.passed, `${name} STA: ${out.sta.bottlenecks.join('; ')}`).toBe(true);

      const recipeMacros = out.synthesis.nodes.filter(
        (n): n is RecipeMacroSpec => n.kind === 'recipe-macro',
      );
      expect(recipeMacros.some((m) => m.recipeId === 'iron-stick')).toBe(false);
      const railMacro = recipeMacros.find((m) => m.recipeId === 'rail');
      expect(railMacro?.directInsert?.ratio).toBe('1:2');
      expect(railMacro?.directInsert?.producerRecipeId).toBe('iron-stick');
    }
  });

  it('handles multi-consumer DAGs (Red Circuits needing both electronic-circuit and standalone copper-cable)', () => {
    const spec = makeDirectSpec({
      name: 'Red Circuits Multi-Consumer',
      inputPreset: 'plates',
      targets: [{ item: 'advanced-circuit', ratePerMin: 120 }],
      pdk: {
        ...defaultPdkConfig(),
        defaultAssemblerTier: 2,
        defaultBeltTier: 'red',
      },
    });

    const out = runFullPipeline(spec);
    expect(out.drc.errorCount, JSON.stringify(out.drc.violations)).toBe(0);
    expect(out.sta.passed, out.sta.bottlenecks.join('; ')).toBe(true);

    const recipeMacros = out.synthesis.nodes.filter(
      (n): n is RecipeMacroSpec => n.kind === 'recipe-macro',
    );
    const ecMacro = recipeMacros.find((m) => m.recipeId === 'electronic-circuit');
    expect(ecMacro?.directInsert?.ratio).toBe('3:2');
    const ccMacro = recipeMacros.find((m) => m.recipeId === 'copper-cable');
    expect(ccMacro).toBeDefined();
    expect(ccMacro!.directInsert).toBeUndefined();
    expect(ccMacro!.outputRatePerSec).toBeCloseTo(8, 3);
  });

  it('uses 1:1 Electromagnetic Plant compound macro when spaceAgeBuildings=true (all 3 pole tiers)', () => {
    for (const poleTier of ['small', 'medium', 'substation'] as PoleTier[]) {
      const spec = makeDirectSpec({
        name: `Space Age EM 1:1 (${poleTier})`,
        inputPreset: 'plates',
        targets: [{ item: 'electronic-circuit', ratePerMin: 1800 }],
        pdk: {
          ...defaultPdkConfig(),
          spaceAgeBuildings: true,
          defaultBeltTier: 'turbo',
          allowedBeltTiers: ['yellow', 'red', 'blue', 'turbo'],
          defaultInserterTier: 'bulk',
          allowedInserterTiers: ['yellow', 'long', 'fast', 'bulk', 'stack'],
          defaultPoleTier: poleTier,
        },
      });

      const out = runFullPipeline(spec);
      expect(out.drc.errorCount, `${poleTier} DRC: ${JSON.stringify(out.drc.violations)}`).toBe(0);
      expect(out.sta.passed, `${poleTier} STA: ${out.sta.bottlenecks.join('; ')}`).toBe(true);

      const recipeMacros = out.synthesis.nodes.filter(
        (n): n is RecipeMacroSpec => n.kind === 'recipe-macro',
      );
      expect(recipeMacros.some((m) => m.recipeId === 'copper-cable')).toBe(false);
      const ecMacro = recipeMacros.find((m) => m.recipeId === 'electronic-circuit');
      expect(ecMacro?.machineName).toBe('electromagnetic-plant');
      expect(ecMacro?.directInsert?.ratio).toBe('1:1');
      expect(ecMacro?.directInsert?.producerMachineName).toBe('electromagnetic-plant');
    }
  });
});
