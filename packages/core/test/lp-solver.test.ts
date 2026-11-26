import { describe, expect, it } from 'vitest';
import {
  LpRecipe,
  computeNormalizedByproductCosts,
  effectiveOutputAmount,
  solveStoichiometricLp,
} from '../src/index.js';

function makeOilRecipes(prodMult = 1.0): LpRecipe[] {
  return [
    {
      id: 'advanced-oil-processing',
      cost: 5,
      inputs: [
        { item: 'crude-oil', amount: 100 },
        { item: 'water', amount: 50 },
      ],
      outputs: [
        { item: 'heavy-oil', amount: 25 * prodMult },
        { item: 'light-oil', amount: 45 * prodMult },
        { item: 'petroleum-gas', amount: 55 * prodMult },
      ],
    },
    {
      id: 'basic-oil-processing',
      cost: 5,
      inputs: [{ item: 'crude-oil', amount: 100 }],
      outputs: [{ item: 'petroleum-gas', amount: 45 * prodMult }],
    },
    {
      id: 'heavy-oil-cracking',
      cost: 2,
      inputs: [
        { item: 'water', amount: 30 },
        { item: 'heavy-oil', amount: 40 },
      ],
      outputs: [{ item: 'light-oil', amount: 30 * prodMult }],
    },
    {
      id: 'light-oil-cracking',
      cost: 2,
      inputs: [
        { item: 'water', amount: 30 },
        { item: 'light-oil', amount: 30 },
      ],
      outputs: [{ item: 'petroleum-gas', amount: 20 * prodMult }],
    },
  ];
}

describe('Stoichiometric Simplex LP Solver', () => {
  it('solves heavy-oil-only demand without wasted cracking at both 1.0x and 3.0x productivity', () => {
    const items = ['heavy-oil', 'light-oil', 'petroleum-gas'];
    for (const prod of [1.0, 3.0]) {
      const recipes = makeOilRecipes(prod);
      const costs = computeNormalizedByproductCosts(items, recipes);
      const sol = solveStoichiometricLp({
        items,
        recipes,
        targets: { 'heavy-oil': 25 * prod },
        externalInputs: [],
        allowedByproducts: items.map((it) => ({ item: it, exportCost: costs[it] })),
      });
      expect(sol.feasible).toBe(true);
      expect(sol.recipeRates['advanced-oil-processing']).toBeCloseTo(1.0, 6);
      expect(sol.recipeRates['heavy-oil-cracking'] ?? 0).toBe(0);
      expect(sol.recipeRates['light-oil-cracking'] ?? 0).toBe(0);
      expect(sol.byproductExports['light-oil']).toBeCloseTo(45 * prod, 5);
      expect(sol.byproductExports['petroleum-gas']).toBeCloseTo(55 * prod, 5);
    }
  });

  it('auto-cracks heavy oil for light-oil-only demand and exports only petroleum gas', () => {
    const items = ['heavy-oil', 'light-oil', 'petroleum-gas'];
    const recipes = makeOilRecipes(1.0);
    const costs = computeNormalizedByproductCosts(items, recipes);
    const sol = solveStoichiometricLp({
      items,
      recipes,
      targets: { 'light-oil': 63.75 },
      externalInputs: [],
      allowedByproducts: items.map((it) => ({ item: it, exportCost: costs[it] })),
    });
    expect(sol.feasible).toBe(true);
    // 1.0/s advanced-oil -> 25 heavy + 45 light + 55 petgas; cracking 25 heavy -> 18.75 light => 63.75 light
    expect(sol.recipeRates['advanced-oil-processing']).toBeCloseTo(1.0, 5);
    expect(sol.recipeRates['heavy-oil-cracking']).toBeCloseTo(25 / 40, 5);
    expect(sol.byproductExports['heavy-oil'] ?? 0).toBe(0);
    expect(sol.byproductExports['petroleum-gas']).toBeCloseTo(55, 5);
  });

  it('achieves zero wasted byproducts when heavy-oil and petroleum-gas are balanced via cracking', () => {
    const items = ['heavy-oil', 'light-oil', 'petroleum-gas'];
    const recipes = makeOilRecipes(1.0);
    const costs = computeNormalizedByproductCosts(items, recipes);
    // 1.0/s advanced-oil yields 25 heavy, 45 light, 55 petgas; cracking 45 light adds 30 petgas => 85 petgas
    const sol = solveStoichiometricLp({
      items,
      recipes,
      targets: { 'heavy-oil': 25, 'petroleum-gas': 85 },
      externalInputs: [],
      allowedByproducts: items.map((it) => ({ item: it, exportCost: costs[it] })),
    });
    expect(sol.feasible).toBe(true);
    expect(sol.recipeRates['advanced-oil-processing']).toBeCloseTo(1.0, 5);
    expect(sol.recipeRates['light-oil-cracking']).toBeCloseTo(1.5, 5);
    expect(sol.byproductExports['heavy-oil'] ?? 0).toBe(0);
    expect(sol.byproductExports['light-oil'] ?? 0).toBe(0);
    expect(sol.byproductExports['petroleum-gas'] ?? 0).toBe(0);
  });

  it('computes catalyst-aware effective output and detects infeasible problems', () => {
    expect(
      effectiveOutputAmount({ item: 'uranium-235', amount: 41, catalystAmount: 40 }, 1.2),
    ).toBeCloseTo(41.2, 6);

    const infeasible = solveStoichiometricLp({
      items: ['a'],
      recipes: [{ id: 'r1', cost: 1, inputs: [{ item: 'a', amount: 2 }], outputs: [] }],
      targets: { a: 5 },
      externalInputs: [],
      allowedByproducts: [],
    });
    expect(infeasible.feasible).toBe(false);
  });
});
