import {
  BalancerMacroSpec,
  BeltTier,
  BomSummary,
  DagSummaryNode,
  DesignSpec,
  ModuleName,
  PdkConfig,
  RecipeDef,
  RecipeMacroSpec,
  SynthInputNode,
  SynthNet,
  SynthNode,
  SynthOutputNode,
  SynthesisResult,
} from '../types.js';
import {
  BELT_SPECS,
  MACHINE_SPECS,
  MODULE_SPECS,
  assemblerNameForTier,
} from '../data/entities.js';
import {
  getDefaultRecipeForItem,
  getItemMeta,
  isPresetInputItem,
} from '../data/catalog.js';
import { selectBalancerTemplate } from '../data/balancers.js';

const MAX_MACHINES_PER_SLICE = 16;

const TIER_ORDER: BeltTier[] = ['yellow', 'red', 'blue'];

export function pickBeltTierForRate(ratePerSec: number, pdk: PdkConfig): BeltTier {
  const allowed = TIER_ORDER.filter((t) => pdk.allowedBeltTiers.includes(t));
  const pool = allowed.length > 0 ? allowed : [pdk.defaultBeltTier];

  if (pdk.downsizeLowRateBelts) {
    for (const t of pool) {
      if (BELT_SPECS[t].itemsPerSec + 1e-6 >= ratePerSec) {
        return t;
      }
    }
    return pool[pool.length - 1];
  }

  // Prefer default belt tier unless rate exceeds its capacity and a faster allowed tier exists
  const defTier = pool.includes(pdk.defaultBeltTier) ? pdk.defaultBeltTier : pool[0];
  if (BELT_SPECS[defTier].itemsPerSec + 1e-6 >= ratePerSec) {
    return defTier;
  }
  for (const t of pool) {
    if (BELT_SPECS[t].itemsPerSec + 1e-6 >= ratePerSec) {
      return t;
    }
  }
  return pool[pool.length - 1];
}

export function maxBeltTier(a: BeltTier, b: BeltTier): BeltTier {
  return TIER_ORDER.indexOf(a) >= TIER_ORDER.indexOf(b) ? a : b;
}

interface ItemDecision {
  mode: 'input-pin' | 'synthesize';
  forcedInputReason?: 'no-recipe' | 'fluid-v1' | 'preset';
  recipe?: RecipeDef;
}

function decideItemMode(item: string, spec: DesignSpec): ItemDecision {
  const recipe = getDefaultRecipeForItem(item);
  if (!recipe) {
    return { mode: 'input-pin', forcedInputReason: 'no-recipe' };
  }
  if (recipe.hasFluid) {
    return { mode: 'input-pin', forcedInputReason: 'fluid-v1', recipe };
  }
  const override = spec.inputOverrides[item];
  if (override === 'input') {
    return { mode: 'input-pin', recipe };
  }
  if (override === 'synthesize') {
    return { mode: 'synthesize', recipe };
  }
  if (isPresetInputItem(item, spec.inputPreset)) {
    return { mode: 'input-pin', forcedInputReason: 'preset', recipe };
  }
  return { mode: 'synthesize', recipe };
}

function resolveMachineModules(
  recipe: RecipeDef,
  machineSlots: number,
  pdk: PdkConfig,
  warnings: string[],
): ModuleName[] {
  if (machineSlots <= 0) return [];
  const raw = pdk.modules.byRecipe[recipe.id] ?? pdk.modules.global ?? [];
  const clipped = raw.slice(0, machineSlots);
  if (recipe.allowProductivity) return clipped;

  const filtered = clipped.filter((m) => !m.startsWith('productivity-module'));
  if (filtered.length < clipped.length) {
    warnings.push(
      `Productivity modules removed from "${recipe.id}" (Factorio 2.0 disallows productivity on this recipe).`,
    );
  }
  return filtered;
}

export function synthesizeDesign(spec: DesignSpec): SynthesisResult {
  const warnings: string[] = [];
  if (spec.targets.length === 0) {
    throw new Error('At least one target item is required for synthesis.');
  }

  // Merge duplicate targets for the same item
  const targetRates = new Map<string, number>();
  for (const t of spec.targets) {
    if (t.ratePerMin <= 0) continue;
    targetRates.set(t.item, (targetRates.get(t.item) ?? 0) + t.ratePerMin / 60);
  }
  if (targetRates.size === 0) {
    throw new Error('All target production rates must be > 0.');
  }

  // 1. Discover reachable graph and decide input-pin vs synthesize
  const decisions = new Map<string, ItemDecision>();
  const adj = new Map<string, string[]>(); // item -> ingredient items
  const inDegree = new Map<string, number>();

  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(item: string): void {
    if (visited.has(item)) return;
    if (visiting.has(item)) {
      throw new Error(`Circular recipe dependency detected involving "${item}".`);
    }
    visiting.add(item);

    const dec = decideItemMode(item, spec);
    decisions.set(item, dec);
    if (!inDegree.has(item)) inDegree.set(item, 0);

    if (dec.mode === 'synthesize' && dec.recipe) {
      const deps: string[] = [];
      for (const ing of dec.recipe.ingredients) {
        if (ing.type === 'fluid') continue;
        deps.push(ing.item);
        inDegree.set(ing.item, (inDegree.get(ing.item) ?? 0) + 1);
        visit(ing.item);
      }
      adj.set(item, deps);
    } else {
      adj.set(item, []);
    }

    visiting.delete(item);
    visited.add(item);
  }

  for (const item of targetRates.keys()) {
    visit(item);
  }

  // 2. Topological order from consumers (targets) upstream to inputs
  const topoOrder: string[] = [];
  const queue: string[] = [];
  for (const [item, deg] of inDegree.entries()) {
    if (deg === 0) queue.push(item);
  }
  while (queue.length > 0) {
    const cur = queue.shift()!;
    topoOrder.push(cur);
    for (const dep of adj.get(cur) ?? []) {
      const nextDeg = (inDegree.get(dep) ?? 1) - 1;
      inDegree.set(dep, nextDeg);
      if (nextDeg === 0) queue.push(dep);
    }
  }

  // 3. Accumulate demands and compute machine & ingredient math
  const demandPerSec = new Map<string, number>();
  for (const [item, rps] of targetRates.entries()) {
    demandPerSec.set(item, rps);
  }

  interface ComputedRecipe {
    item: string;
    recipe: RecipeDef;
    machineName: RecipeMacroSpec['machineName'];
    modules: ModuleName[];
    effectiveSpeed: number;
    effectiveProd: number;
    exactMachines: number;
    machineCount: number;
    demandPerSec: number;
    ingredients: { item: string; ratePerSec: number }[];
    powerKwPerMachine: number;
  }

  const computedRecipes = new Map<string, ComputedRecipe>();
  const dag: DagSummaryNode[] = [];
  const defaultCap = BELT_SPECS[spec.pdk.defaultBeltTier].itemsPerSec;

  for (const item of topoOrder) {
    const demand = demandPerSec.get(item) ?? 0;
    const dec = decisions.get(item)!;
    const meta = getItemMeta(item);

    if (dec.mode === 'input-pin' || !dec.recipe) {
      dag.push({
        item,
        name: meta.name,
        demandPerSec: demand,
        demandPerMin: demand * 60,
        mode: 'input-pin',
        forcedInputReason: dec.forcedInputReason,
        exactMachines: 0,
        machineCount: 0,
        beltCount: Math.max(1, Math.ceil(demand / defaultCap)),
        ingredients: [],
      });
      continue;
    }

    const recipe = dec.recipe;
    const machineName: RecipeMacroSpec['machineName'] =
      recipe.category === 'smelting'
        ? 'electric-furnace'
        : assemblerNameForTier(spec.pdk.defaultAssemblerTier);
    const machineSpec = MACHINE_SPECS[machineName];
    const modules = resolveMachineModules(
      recipe,
      machineSpec.moduleSlots,
      spec.pdk,
      warnings,
    );

    let speedBonus = 0;
    let prodBonus = 0;
    let consBonus = 0;
    for (const m of modules) {
      const mod = MODULE_SPECS[m];
      speedBonus += mod.speed;
      prodBonus += mod.productivity;
      consBonus += mod.consumption;
    }

    const effectiveSpeed = machineSpec.craftingSpeed * Math.max(0.2, 1 + speedBonus);
    const effectiveProd = recipe.allowProductivity ? Math.max(1, 1 + prodBonus) : 1;
    const effectivePowerMult = Math.max(0.2, 1 + consBonus);

    const outPerMachinePerSec =
      (recipe.outputCount * effectiveProd * effectiveSpeed) / recipe.energyRequired;
    const exactMachines = demand / outPerMachinePerSec;
    const machineCount = Math.max(1, Math.ceil(exactMachines));

    const ingredients: { item: string; ratePerSec: number }[] = [];
    for (const ing of recipe.ingredients) {
      if (ing.type === 'fluid') continue;
      // Productivity adds bonus output without consuming extra ingredients
      const ingRate =
        exactMachines * ((ing.amount * effectiveSpeed) / recipe.energyRequired);
      ingredients.push({ item: ing.item, ratePerSec: ingRate });
      demandPerSec.set(ing.item, (demandPerSec.get(ing.item) ?? 0) + ingRate);
    }

    computedRecipes.set(item, {
      item,
      recipe,
      machineName,
      modules,
      effectiveSpeed,
      effectiveProd,
      exactMachines,
      machineCount,
      demandPerSec: demand,
      ingredients,
      powerKwPerMachine: machineSpec.powerKw * effectivePowerMult,
    });

    dag.push({
      item,
      name: meta.name,
      demandPerSec: demand,
      demandPerMin: demand * 60,
      mode: 'synthesize',
      recipeId: recipe.id,
      machineName,
      exactMachines,
      machineCount,
      beltCount: Math.max(1, Math.ceil(demand / defaultCap)),
      ingredients,
    });
  }

  // 3b. Compute forward recipe depths (0 = primary input, 1+ = downstream crafting depth)
  const itemDepth = new Map<string, number>();
  for (const item of [...topoOrder].reverse()) {
    const dec = decisions.get(item);
    if (!dec || dec.mode === 'input-pin' || !dec.recipe) {
      itemDepth.set(item, 0);
      continue;
    }
    let maxIngDepth = 0;
    for (const ing of dec.recipe.ingredients) {
      if (ing.type === 'fluid') continue;
      maxIngDepth = Math.max(maxIngDepth, itemDepth.get(ing.item) ?? 0);
    }
    itemDepth.set(item, maxIngDepth + 1);
  }
  const maxItemDepth = Math.max(1, ...itemDepth.values());

  // 4. Slice recipes into single-belt RecipeMacroSpecs and build Primary Input / Output nodes
  const nodes: SynthNode[] = [];
  const macroOutputDepthById = new Map<string, number>();
  const itemSources = new Map<
    string,
    Array<{ nodeId: string; pinId: string; ratePerSec: number; beltTier: BeltTier }>
  >();
  const itemSinks = new Map<
    string,
    Array<{ nodeId: string; pinId: string; ratePerSec: number; beltTier: BeltTier }>
  >();

  const addSource = (
    item: string,
    entry: { nodeId: string; pinId: string; ratePerSec: number; beltTier: BeltTier },
  ) => {
    let arr = itemSources.get(item);
    if (!arr) {
      arr = [];
      itemSources.set(item, arr);
    }
    arr.push(entry);
  };

  const addSink = (
    item: string,
    entry: { nodeId: string; pinId: string; ratePerSec: number; beltTier: BeltTier },
  ) => {
    let arr = itemSinks.get(item);
    if (!arr) {
      arr = [];
      itemSinks.set(item, arr);
    }
    arr.push(entry);
  };

  // Primary Inputs
  for (const d of dag) {
    if (d.mode !== 'input-pin' || d.demandPerSec <= 0) continue;
    const maxCap = BELT_SPECS[
      spec.pdk.allowedBeltTiers.includes(spec.pdk.defaultBeltTier)
        ? spec.pdk.defaultBeltTier
        : spec.pdk.allowedBeltTiers[0] ?? 'red'
    ].itemsPerSec;
    const beltCount = Math.max(1, Math.ceil(d.demandPerSec / maxCap));
    const perBeltRate = d.demandPerSec / beltCount;
    const tier = pickBeltTierForRate(perBeltRate, spec.pdk);
    for (let i = 0; i < beltCount; i++) {
      const nodeId = `in:${d.item}:${i}`;
      const node: SynthInputNode = {
        id: nodeId,
        kind: 'primary-input',
        item: d.item,
        busIndex: i,
        ratePerSec: perBeltRate,
        beltTier: tier,
        pinId: nodeId,
      };
      nodes.push(node);
      addSource(d.item, {
        nodeId,
        pinId: nodeId,
        ratePerSec: perBeltRate,
        beltTier: tier,
      });
    }
  }

  // Primary Outputs
  for (const [item, rps] of targetRates.entries()) {
    const maxCap = BELT_SPECS[spec.pdk.defaultBeltTier].itemsPerSec;
    const beltCount = Math.max(1, Math.ceil(rps / maxCap));
    const perBeltRate = rps / beltCount;
    const tier = pickBeltTierForRate(perBeltRate, spec.pdk);
    for (let i = 0; i < beltCount; i++) {
      const nodeId = `out:${item}:${i}`;
      const node: SynthOutputNode = {
        id: nodeId,
        kind: 'primary-output',
        item,
        busIndex: i,
        ratePerSec: perBeltRate,
        beltTier: tier,
        pinId: nodeId,
      };
      nodes.push(node);
      addSink(item, {
        nodeId,
        pinId: nodeId,
        ratePerSec: perBeltRate,
        beltTier: tier,
      });
    }
  }

  // Recipe Macros (sliced so every output & input pin stays <= 1 belt)
  for (const comp of computedRecipes.values()) {
    const maxBeltCap = BELT_SPECS[spec.pdk.defaultBeltTier].itemsPerSec;
    let sliceCount = Math.max(
      1,
      Math.ceil(comp.demandPerSec / maxBeltCap),
      Math.ceil(comp.machineCount / MAX_MACHINES_PER_SLICE),
    );
    for (const ing of comp.ingredients) {
      sliceCount = Math.max(sliceCount, Math.ceil(ing.ratePerSec / maxBeltCap));
    }
    // Never create more slices than integer machines
    sliceCount = Math.min(sliceCount, comp.machineCount);

    const equalFrac = 1 / sliceCount;
    const baseMachines = Math.floor(comp.machineCount / sliceCount);
    const remMachines = comp.machineCount % sliceCount;
    const maxInputOrOut = Math.max(
      comp.demandPerSec,
      ...comp.ingredients.map((i) => i.ratePerSec),
    );
    const unbalancedMax =
      comp.machineCount > 0 && remMachines > 0
        ? ((baseMachines + 1) / comp.machineCount) * maxInputOrOut
        : 0;
    const useUniformCeil = sliceCount > 1 && unbalancedMax > maxBeltCap + 1e-4;

    for (let s = 0; s < sliceCount; s++) {
      const mCount = useUniformCeil
        ? Math.max(1, Math.ceil(comp.exactMachines / sliceCount))
        : baseMachines + (s < remMachines ? 1 : 0);
      const frac = sliceCount > 1 ? equalFrac : mCount / comp.machineCount;
      const sliceOutRate = comp.demandPerSec * frac;
      const sliceExactMachines = comp.exactMachines * frac;
      const outTier = pickBeltTierForRate(sliceOutRate, spec.pdk);
      const macroId =
        sliceCount === 1 ? `macro:${comp.recipe.id}` : `macro:${comp.recipe.id}:${s}`;
      const override = spec.macroOverrides[macroId];

      const ingRates = comp.ingredients.map((ing) => {
        const r = ing.ratePerSec * frac;
        return {
          item: ing.item,
          ratePerSec: r,
          beltTier: pickBeltTierForRate(r, spec.pdk),
        };
      });

      const macroNode: RecipeMacroSpec = {
        id: macroId,
        kind: 'recipe-macro',
        recipeId: comp.recipe.id,
        outputItem: comp.item,
        machineName: comp.machineName,
        machineCount: mCount,
        exactMachines: sliceExactMachines,
        modules: comp.modules,
        effectiveSpeed: comp.effectiveSpeed,
        effectiveProd: comp.effectiveProd,
        outputRatePerSec: sliceOutRate,
        beltTier: outTier,
        ingredientRates: ingRates,
        preferredRows: override?.rows,
        sliceIndex: s,
        sliceCount,
      };
      nodes.push(macroNode);
      macroOutputDepthById.set(macroId, itemDepth.get(comp.item) ?? 1);

      addSource(comp.item, {
        nodeId: macroId,
        pinId: `out:${comp.item}`,
        ratePerSec: sliceOutRate,
        beltTier: outTier,
      });

      for (const ing of ingRates) {
        addSink(ing.item, {
          nodeId: macroId,
          pinId: `in:${ing.item}`,
          ratePerSec: ing.ratePerSec,
          beltTier: ing.beltTier,
        });
      }
    }
  }

  // 5. Connect sources -> sinks per item, inserting N x M Balancers on fan-in / fan-out
  const nets: SynthNet[] = [];
  let netCounter = 0;

  for (const [item, sources] of itemSources.entries()) {
    const sinks = itemSinks.get(item) ?? [];
    if (sinks.length === 0) continue;

    const S = sources.length;
    const D = sinks.length;

    const isDirectParallel =
      S === D &&
      (S === 1 ||
        sources.every((src, idx) => Math.abs(src.ratePerSec - sinks[idx].ratePerSec) < 1e-3));

    if (isDirectParallel) {
      for (let i = 0; i < S; i++) {
        const src = sources[i];
        const dst = sinks[i];
        const tier = maxBeltTier(src.beltTier, dst.beltTier);
        nets.push({
          id: `net:${netCounter++}:${item}`,
          busId: item,
          busIndex: i,
          item,
          ratePerSec: dst.ratePerSec,
          beltTier: tier,
          source: { nodeId: src.nodeId, pinId: src.pinId, kind: 'source', item },
          sink: { nodeId: dst.nodeId, pinId: dst.pinId, kind: 'sink', item },
        });
      }
      continue;
    }

    // Insert S x D balancer hard-IP
    let balTier: BeltTier = spec.pdk.downsizeLowRateBelts ? 'yellow' : spec.pdk.defaultBeltTier;
    if (spec.pdk.downsizeLowRateBelts) {
      balTier = sources.reduce((acc, s) => maxBeltTier(acc, s.beltTier), 'yellow' as BeltTier);
      balTier = sinks.reduce((acc, d) => maxBeltTier(acc, d.beltTier), balTier);
    }

    const template = selectBalancerTemplate(S, D, balTier, spec.customBalancers ?? []);
    const totalRate = sinks.reduce((acc, s) => acc + s.ratePerSec, 0);
    const hasCustomExact = (spec.customBalancers ?? []).some(
      (b) => b.inputs === S && b.outputs === D,
    );
    const sinkDepth = (nodeId: string): number =>
      nodeId.startsWith('out:')
        ? maxItemDepth + 1
        : (macroOutputDepthById.get(nodeId) ?? 1);
    const distinctDepths = new Set(sinks.map((s) => sinkDepth(s.nodeId)));

    // Decompose multi-stage single-belt 1->N fan-out into chained compact 1x2 inline taps
    if (
      S === 1 &&
      D >= 3 &&
      spec.optimization?.busTaps !== false &&
      totalRate <= BELT_SPECS[balTier].itemsPerSec + 1e-6 &&
      !hasCustomExact &&
      distinctDepths.size >= 2
    ) {
      const sortedSinks = [...sinks].sort(
        (a, b) => sinkDepth(a.nodeId) - sinkDepth(b.nodeId) || b.ratePerSec - a.ratePerSec,
      );
      const tapTpl = selectBalancerTemplate(1, 2, balTier, spec.customBalancers ?? []);
      const numTaps = D - 1;
      const tapIds: string[] = [];

      for (let k = 0; k < numTaps; k++) {
        const tapId = `tap:${item}:${k}`;
        tapIds.push(tapId);
        const remRate = sortedSinks
          .slice(k)
          .reduce((acc, s) => acc + s.ratePerSec, 0);
        const tapNode: BalancerMacroSpec = {
          id: tapId,
          kind: 'balancer-macro',
          item,
          inputs: 1,
          outputs: 2,
          beltTier: tapTpl.beltTier,
          totalRatePerSec: remRate,
          templateId: tapTpl.id,
        };
        nodes.push(tapNode);
      }

      const src = sources[0];
      nets.push({
        id: `net:${netCounter++}:${item}:tapin`,
        busId: `${item}:tap`,
        busIndex: 0,
        item,
        ratePerSec: totalRate,
        beltTier: maxBeltTier(src.beltTier, tapTpl.beltTier),
        source: { nodeId: src.nodeId, pinId: src.pinId, kind: 'source', item },
        sink: { nodeId: tapIds[0], pinId: 'in:0', kind: 'sink', item },
      });

      for (let k = 0; k < numTaps; k++) {
        const dst = sortedSinks[k];
        nets.push({
          id: `net:${netCounter++}:${item}:tapout${k}`,
          busId: `${item}:out`,
          busIndex: k,
          item,
          ratePerSec: dst.ratePerSec,
          beltTier: maxBeltTier(dst.beltTier, tapTpl.beltTier),
          source: { nodeId: tapIds[k], pinId: 'out:0', kind: 'source', item },
          sink: { nodeId: dst.nodeId, pinId: dst.pinId, kind: 'sink', item },
        });

        if (k < numTaps - 1) {
          const trunkRate = sortedSinks
            .slice(k + 1)
            .reduce((acc, s) => acc + s.ratePerSec, 0);
          nets.push({
            id: `net:${netCounter++}:${item}:trunk${k}`,
            busId: `${item}:tap`,
            busIndex: k + 1,
            item,
            ratePerSec: trunkRate,
            beltTier: maxBeltTier(src.beltTier, tapTpl.beltTier),
            source: { nodeId: tapIds[k], pinId: 'out:1', kind: 'source', item },
            sink: { nodeId: tapIds[k + 1], pinId: 'in:0', kind: 'sink', item },
          });
        } else {
          const lastDst = sortedSinks[D - 1];
          nets.push({
            id: `net:${netCounter++}:${item}:tapout${D - 1}`,
            busId: `${item}:out`,
            busIndex: D - 1,
            item,
            ratePerSec: lastDst.ratePerSec,
            beltTier: maxBeltTier(lastDst.beltTier, tapTpl.beltTier),
            source: { nodeId: tapIds[k], pinId: 'out:1', kind: 'source', item },
            sink: { nodeId: lastDst.nodeId, pinId: lastDst.pinId, kind: 'sink', item },
          });
        }
      }
      continue;
    }

    const balId = `bal:${item}:${S}x${D}`;

    const balNode: BalancerMacroSpec = {
      id: balId,
      kind: 'balancer-macro',
      item,
      inputs: S,
      outputs: D,
      beltTier: template.beltTier,
      totalRatePerSec: totalRate,
      templateId: template.id,
    };
    nodes.push(balNode);

    for (let i = 0; i < S; i++) {
      const src = sources[i];
      nets.push({
        id: `net:${netCounter++}:${item}:in${i}`,
        busId: `${item}:in`,
        busIndex: i,
        item,
        ratePerSec: src.ratePerSec,
        beltTier: maxBeltTier(src.beltTier, template.beltTier),
        source: { nodeId: src.nodeId, pinId: src.pinId, kind: 'source', item },
        sink: { nodeId: balId, pinId: `in:${i}`, kind: 'sink', item },
      });
    }

    for (let j = 0; j < D; j++) {
      const dst = sinks[j];
      nets.push({
        id: `net:${netCounter++}:${item}:out${j}`,
        busId: `${item}:out`,
        busIndex: j,
        item,
        ratePerSec: dst.ratePerSec,
        beltTier: maxBeltTier(dst.beltTier, template.beltTier),
        source: { nodeId: balId, pinId: `out:${j}`, kind: 'source', item },
        sink: { nodeId: dst.nodeId, pinId: dst.pinId, kind: 'sink', item },
      });
    }
  }

  // 6. Compute synthesis BOM estimate
  const bom = computeSynthBom(nodes, computedRecipes);

  return {
    spec,
    nodes,
    nets,
    dag,
    bom,
    warnings,
  };
}

function computeSynthBom(
  nodes: SynthNode[],
  computedRecipes: Map<
    string,
    {
      machineCount: number;
      powerKwPerMachine: number;
    }
  >,
): BomSummary {
  const entities: Record<string, number> = {};
  const modules: Record<string, number> = {};
  let totalMachines = 0;
  let estimatedPowerKw = 0;

  for (const n of nodes) {
    if (n.kind === 'recipe-macro') {
      entities[n.machineName] = (entities[n.machineName] ?? 0) + n.machineCount;
      totalMachines += n.machineCount;
      for (const m of n.modules) {
        modules[m] = (modules[m] ?? 0) + n.machineCount;
      }
    }
  }

  for (const c of computedRecipes.values()) {
    estimatedPowerKw += c.machineCount * c.powerKwPerMachine;
  }
  // Rough allowance for inserters
  estimatedPowerKw += totalMachines * 30;

  return {
    entities,
    modules,
    estimatedPowerKw: Math.round(estimatedPowerKw),
    totalMachines,
  };
}
