import { describe, expect, it } from 'vitest';
import {
  PoleTier,
  RecipeMacroSpec,
  Rot90,
  compileRecipeMacroVariants,
  defaultPdkConfig,
  mirrorMacroY,
  rotateMacro,
  runDrc,
} from '../src/index.js';

function makeMacroSpec(
  recipeId: string,
  outputItem: string,
  machineCount: number,
  ingredients: { item: string; ratePerSec: number }[],
): RecipeMacroSpec {
  return {
    id: `m:${recipeId}`,
    kind: 'recipe-macro',
    recipeId,
    outputItem,
    machineName: 'assembling-machine-2',
    machineCount,
    exactMachines: machineCount,
    modules: [],
    effectiveSpeed: 0.75,
    effectiveProd: 1,
    outputRatePerSec: 2,
    beltTier: 'red',
    ingredientRates: ingredients.map((ing) => ({ ...ing, beltTier: 'red' })),
    sliceIndex: 0,
    sliceCount: 1,
  };
}

describe('Soft-Macro Compiler & Rotations', () => {
  const cases: Array<{ name: string; spec: RecipeMacroSpec }> = [
    {
      name: '1-ingredient (iron-gear-wheel, 8 machines)',
      spec: makeMacroSpec('iron-gear-wheel', 'iron-gear-wheel', 8, [
        { item: 'iron-plate', ratePerSec: 4 },
      ]),
    },
    {
      name: '2-ingredient (electronic-circuit, 10 machines)',
      spec: makeMacroSpec('electronic-circuit', 'electronic-circuit', 10, [
        { item: 'iron-plate', ratePerSec: 3 },
        { item: 'copper-cable', ratePerSec: 9 },
      ]),
    },
    {
      name: '3-ingredient dual-lane (inserter, 4 machines)',
      spec: makeMacroSpec('inserter', 'inserter', 4, [
        { item: 'electronic-circuit', ratePerSec: 1 },
        { item: 'iron-gear-wheel', ratePerSec: 1 },
        { item: 'iron-plate', ratePerSec: 1 },
      ]),
    },
    {
      name: '4-ingredient dual-lane (flying-robot-frame, 4 machines)',
      spec: makeMacroSpec('flying-robot-frame', 'flying-robot-frame', 4, [
        { item: 'electric-engine-unit', ratePerSec: 0.5 },
        { item: 'battery', ratePerSec: 1 },
        { item: 'steel-plate', ratePerSec: 0.5 },
        { item: 'electronic-circuit', ratePerSec: 1.5 },
      ]),
    },
    {
      name: '5-ingredient dual-lane + south far (oil-refinery, 3 machines)',
      spec: makeMacroSpec('oil-refinery', 'oil-refinery', 3, [
        { item: 'steel-plate', ratePerSec: 0.5 },
        { item: 'iron-gear-wheel', ratePerSec: 0.3 },
        { item: 'stone-brick', ratePerSec: 0.3 },
        { item: 'electronic-circuit', ratePerSec: 0.3 },
        { item: 'pipe', ratePerSec: 0.3 },
      ]),
    },
  ];

  for (const tc of cases) {
    it(`passes DRC across variants, pole tiers, flipY, and all 4 rotations for ${tc.name}`, () => {
      for (const poleTier of ['small', 'medium', 'substation'] as PoleTier[]) {
        const pdk = { ...defaultPdkConfig(), defaultPoleTier: poleTier };
        const variants = compileRecipeMacroVariants(tc.spec, pdk);
        expect(variants.length).toBeGreaterThanOrEqual(1);

        if (tc.spec.machineCount >= 4 && tc.spec.ingredientRates.length <= 4) {
          expect(variants.some((v) => v.rows === 2)).toBe(true);
        }

        for (const variant of variants) {
          for (const base of [variant, mirrorMacroY(variant)]) {
            for (const rot of [0, 1, 2, 3] as Rot90[]) {
              const rotated = rotateMacro(base, rot);
              const drc = runDrc(rotated.entities, rotated.width, rotated.height);
              expect(
                drc.violations,
                `${tc.name} rows=${variant.rows} pole=${poleTier} flip=${Boolean(base.flippedY)} rot=${rot}`,
              ).toEqual([]);
              expect(drc.passed).toBe(true);
            }
          }
        }
      }
    });
  }
});
