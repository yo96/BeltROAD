export interface LpRecipe {
  id: string;
  cost: number;
  inputs: Array<{ item: string; amount: number }>;
  outputs: Array<{ item: string; amount: number }>;
}

export interface LpProblem {
  items: string[];
  recipes: LpRecipe[];
  targets: Record<string, number>;
  externalInputs: Array<{ item: string; cost: number }>;
  allowedByproducts: Array<{ item: string; exportCost: number }>;
}

export interface LpSolution {
  feasible: boolean;
  recipeRates: Record<string, number>;
  externalInputs: Record<string, number>;
  byproductExports: Record<string, number>;
  objective: number;
}

const EPS = 1e-9;
const MAX_SIMPLEX_ITERS = 2000;

/**
 * Pure TypeScript Two-Phase Revised/Tableau Simplex LP solver with Bland's anti-cycling rule.
 * Solves equality mass-balance constraints A*x = b with all decision variables x >= 0.
 */
export function solveStoichiometricLp(problem: LpProblem): LpSolution {
  const { items, recipes, targets, externalInputs, allowedByproducts } = problem;
  const m = items.length;
  const emptyResult = (feasible: boolean): LpSolution => ({
    feasible,
    recipeRates: {},
    externalInputs: {},
    byproductExports: {},
    objective: feasible ? 0 : Infinity,
  });

  if (m === 0) {
    return emptyResult(true);
  }

  const itemRow = new Map<string, number>();
  for (let i = 0; i < m; i++) {
    itemRow.set(items[i], i);
  }

  // Deduplicate external inputs & byproducts per item (take minimum cost if repeated)
  const extCostMap = new Map<string, number>();
  for (const ext of externalInputs) {
    if (!itemRow.has(ext.item)) continue;
    const prev = extCostMap.get(ext.item);
    if (prev === undefined || ext.cost < prev) extCostMap.set(ext.item, ext.cost);
  }
  const bypCostMap = new Map<string, number>();
  for (const byp of allowedByproducts) {
    if (!itemRow.has(byp.item)) continue;
    const prev = bypCostMap.get(byp.item);
    if (prev === undefined || byp.exportCost < prev) bypCostMap.set(byp.item, byp.exportCost);
  }

  const extList = Array.from(extCostMap.entries()).map(([item, cost]) => ({ item, cost }));
  const bypList = Array.from(bypCostMap.entries()).map(([item, exportCost]) => ({
    item,
    exportCost,
  }));

  const nOrig = recipes.length + extList.length + bypList.length;
  const totalCols = nOrig + m; // +m artificial variables at [nOrig .. nOrig+m-1]
  const rhsCol = totalCols;
  const width = totalCols + 1;

  // Build m constraints + 1 objective row (row m)
  const T: Float64Array[] = Array.from({ length: m + 1 }, () => new Float64Array(width));
  const c = new Float64Array(totalCols);

  // Recipe columns [0 .. recipes.length - 1]
  for (let k = 0; k < recipes.length; k++) {
    const r = recipes[k];
    c[k] = r.cost;
    for (const out of r.outputs) {
      const row = itemRow.get(out.item);
      if (row !== undefined) T[row][k] += out.amount;
    }
    for (const ing of r.inputs) {
      const row = itemRow.get(ing.item);
      if (row !== undefined) T[row][k] -= ing.amount;
    }
  }

  // External input columns: +1 in item row
  for (let p = 0; p < extList.length; p++) {
    const col = recipes.length + p;
    const row = itemRow.get(extList[p].item)!;
    T[row][col] = 1;
    c[col] = extList[p].cost;
  }

  // Allowed byproduct export columns: -1 in item row
  for (let q = 0; q < bypList.length; q++) {
    const col = recipes.length + extList.length + q;
    const row = itemRow.get(bypList[q].item)!;
    T[row][col] = -1;
    c[col] = bypList[q].exportCost;
  }

  // Artificial columns + RHS
  const basis = new Int32Array(m);
  for (let i = 0; i < m; i++) {
    const artCol = nOrig + i;
    T[i][artCol] = 1;
    T[i][rhsCol] = Math.max(0, targets[items[i]] ?? 0);
    basis[i] = artCol;
  }

  const pivot = (pRow: number, pCol: number) => {
    const pivVal = T[pRow][pCol];
    const rowP = T[pRow];
    for (let j = 0; j < width; j++) {
      rowP[j] /= pivVal;
    }
    rowP[pCol] = 1;
    for (let r = 0; r <= m; r++) {
      if (r === pRow) continue;
      const rowR = T[r];
      const factor = rowR[pCol];
      if (Math.abs(factor) <= EPS) continue;
      for (let j = 0; j < width; j++) {
        rowR[j] -= factor * rowP[j];
      }
      rowR[pCol] = 0;
    }
    basis[pRow] = pCol;
  };

  // Run simplex minimizing objective row T[m] (where T[m][j] stores reduced cost c_j - z_j, and T[m][rhsCol] = -Z)
  const runSimplex = (maxColExclusive: number): boolean => {
    for (let iter = 0; iter < MAX_SIMPLEX_ITERS; iter++) {
      // Bland's rule: pick first column with reduced cost < -EPS
      let enter = -1;
      for (let j = 0; j < maxColExclusive; j++) {
        if (T[m][j] < -EPS) {
          enter = j;
          break;
        }
      }
      if (enter === -1) return true; // Optimal

      // Minimum ratio test with Bland tie-breaking on smallest basis variable index
      let leave = -1;
      let minRatio = Infinity;
      for (let i = 0; i < m; i++) {
        const aij = T[i][enter];
        if (aij > 1e-10) {
          const ratio = Math.max(0, T[i][rhsCol]) / aij;
          if (
            ratio < minRatio - EPS ||
            (Math.abs(ratio - minRatio) <= EPS && (leave === -1 || basis[i] < basis[leave]))
          ) {
            minRatio = ratio;
            leave = i;
          }
        }
      }
      if (leave === -1) {
        return false; // Unbounded
      }
      pivot(leave, enter);
    }
    return false;
  };

  // Phase I: minimize sum(artificial) -> c_j = 0 for orig, 1 for art.
  // Reduced cost row starts as sum of rows whose basic var is artificial, negated so T[m][j] = c_j - z_j:
  T[m].fill(0);
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < nOrig; j++) {
      T[m][j] -= T[i][j];
    }
    T[m][rhsCol] -= T[i][rhsCol];
  }

  const p1Ok = runSimplex(totalCols);
  const phase1Obj = -T[m][rhsCol];
  if (!p1Ok || phase1Obj > 1e-6) {
    return emptyResult(false);
  }

  // Pivot out any zero-valued artificial variable remaining in basis if possible
  for (let i = 0; i < m; i++) {
    if (basis[i] >= nOrig) {
      let enterCol = -1;
      for (let j = 0; j < nOrig; j++) {
        if (Math.abs(T[i][j]) > 1e-8) {
          enterCol = j;
          break;
        }
      }
      if (enterCol !== -1) {
        pivot(i, enterCol);
      }
    }
  }

  // Phase II: set up true objective row c reduced by current basis
  T[m].fill(0);
  for (let j = 0; j < nOrig; j++) {
    T[m][j] = c[j];
  }
  for (let i = 0; i < m; i++) {
    const bCol = basis[i];
    const cb = bCol < nOrig ? c[bCol] : 0;
    if (Math.abs(cb) <= EPS) continue;
    for (let j = 0; j < nOrig; j++) {
      T[m][j] -= cb * T[i][j];
    }
    T[m][rhsCol] -= cb * T[i][rhsCol];
  }

  const p2Ok = runSimplex(nOrig);
  if (!p2Ok) {
    return emptyResult(false);
  }

  // Extract primal variable values
  const x = new Float64Array(nOrig);
  for (let i = 0; i < m; i++) {
    const bCol = basis[i];
    if (bCol < nOrig) {
      const val = T[i][rhsCol];
      x[bCol] = val > 1e-8 ? val : 0;
    }
  }

  const recipeRates: Record<string, number> = {};
  for (let k = 0; k < recipes.length; k++) {
    if (x[k] > 1e-8) recipeRates[recipes[k].id] = x[k];
  }

  const extOut: Record<string, number> = {};
  for (let p = 0; p < extList.length; p++) {
    const v = x[recipes.length + p];
    if (v > 1e-8) extOut[extList[p].item] = v;
  }

  const bypOut: Record<string, number> = {};
  for (let q = 0; q < bypList.length; q++) {
    const v = x[recipes.length + extList.length + q];
    if (v > 1e-8) bypOut[bypList[q].item] = v;
  }

  return {
    feasible: true,
    recipeRates,
    externalInputs: extOut,
    byproductExports: bypOut,
    objective: -T[m][rhsCol],
  };
}

/**
 * Computes strictly monotonic byproduct export penalties along conversion/cracking chains
 * (e.g. heavy-oil -> light-oil -> petroleum-gas) so converting surplus into another unused
 * surplus never lowers export objective cost across any productivity multiplier >= 1.0.
 */
export function computeNormalizedByproductCosts(
  items: string[],
  candidateRecipes: LpRecipe[],
): Record<string, number> {
  const itemSet = new Set(items);
  const costs: Record<string, number> = {};
  for (const it of items) {
    costs[it] = 10;
  }

  const passes = items.length + 2;
  for (let pass = 0; pass < passes; pass++) {
    for (const r of candidateRecipes) {
      for (const ing of r.inputs) {
        if (!itemSet.has(ing.item)) continue;
        for (const out of r.outputs) {
          if (!itemSet.has(out.item) || out.item === ing.item) continue;
          // Only lift downstream target when recipe does not produce multiple items or is a direct conversion step
          if (r.outputs.length === 1) {
            const needed = costs[ing.item] * (ing.amount / Math.max(1e-6, out.amount)) + 1.0;
            if (needed > costs[out.item]) {
              costs[out.item] = needed;
            }
          }
        }
      }
    }
  }

  return costs;
}
