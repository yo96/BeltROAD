import {
  BalancerMacroSpec,
  BeltTier,
  BomSummary,
  DagSummaryNode,
  DesignSpec,
  InserterTier,
  MachineName,
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
  BEACON_SPEC,
  INSERTER_SPECS,
  MACHINE_SPECS,
  MODULE_SPECS,
  PIPE_SPEC,
  QUALITY_SPECS,
  beaconTransmissionMultiplier,
  effectiveBeltCapacity,
  selectMachineForRecipe,
} from '../data/entities.js';
import {
  getDefaultRecipeForItem,
  getItemMeta,
  isFluidItem,
  isPresetInputItem,
} from '../data/catalog.js';
import { selectBalancerTemplate } from '../data/balancers.js';

const MAX_MACHINES_PER_SLICE = 16;

const TIER_ORDER: BeltTier[] = ['yellow', 'red', 'blue', 'turbo'];

export function pickBeltTierForRate(ratePerSec: number, pdk: PdkConfig): BeltTier {
  const allowed = TIER_ORDER.filter((t) => pdk.allowedBeltTiers.includes(t));
  const pool = allowed.length > 0 ? allowed : [pdk.defaultBeltTier];

  if (pdk.downsizeLowRateBelts) {
    for (const t of pool) {
      if (effectiveBeltCapacity(t, pdk) + 1e-6 >= ratePerSec) {
        return t;
      }
    }
    return pool[pool.length - 1];
  }

  // Prefer default belt tier unless rate exceeds its capacity and a faster allowed tier exists
  const defTier = pool.includes(pdk.defaultBeltTier) ? pdk.defaultBeltTier : pool[0];
  if (effectiveBeltCapacity(defTier, pdk) + 1e-6 >= ratePerSec) {
    return defTier;
  }
  for (const t of pool) {
    if (effectiveBeltCapacity(t, pdk) + 1e-6 >= ratePerSec) {
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

function decideItemMode(item: string, spec: DesignSpec, fluidsEnabled: boolean): ItemDecision {
  const recipe = getDefaultRecipeForItem(item);
  if (!recipe) {
    return { mode: 'input-pin', forcedInputReason: 'no-recipe' };
  }
  if (recipe.hasFluid && !fluidsEnabled) {
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

export interface SynthesizeOptions {
  forceBalancedOutputs?: boolean;
}

export function synthesizeDesign(
  spec: DesignSpec,
  opts?: SynthesizeOptions,
): SynthesisResult {
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

  const fluidsEnabled =
    Boolean(spec.pdk.enableFluids) ||
    spec.targets.some((t) => getDefaultRecipeForItem(t.item)?.hasFluid);

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

    const dec = decideItemMode(item, spec, fluidsEnabled);
    decisions.set(item, dec);
    if (!inDegree.has(item)) inDegree.set(item, 0);

    if (dec.mode === 'synthesize' && dec.recipe) {
      const deps: string[] = [];
      for (const ing of dec.recipe.ingredients) {
        if (ing.type === 'fluid' && !fluidsEnabled) continue;
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
    machineName: MachineName;
    quality?: PdkConfig['machineQuality'];
    modules: ModuleName[];
    beaconsPerMachine: number;
    beaconModules: NonNullable<PdkConfig['beaconModules']>;
    effectiveSpeed: number;
    effectiveProd: number;
    exactMachines: number;
    machineCount: number;
    demandPerSec: number;
    ingredients: { item: string; ratePerSec: number }[];
    fluidInputs: { item: string; ratePerSec: number }[];
    powerKwPerMachine: number;
    directInsert?: {
      ratio: '3:2' | '1:2' | '1:1';
      producerRecipeId: string;
      producerMachineName: MachineName;
      producerModules: ModuleName[];
      producerMachinesPerUnit: number;
      consumerMachinesPerUnit: number;
      unitCount: number;
      intermediateItem: string;
      intermediateRatePerSec: number;
      producerInputs: { item: string; ratePerSec: number }[];
      consumerExtraInputs: { item: string; ratePerSec: number }[];
      producerPowerKwPerMachine: number;
    };
  }

  const directInsertEnabled =
    Boolean(spec.optimization?.directInsertion) && (spec.pdk.beaconMode ?? 'none') === 'none';

  const DIRECT_INSERT_PAIRS: Record<
    string,
    {
      consumerRecipeId: string;
      producerRecipeId: string;
      producerItem: string;
      ratio3x3?: { ratio: '3:2' | '1:2'; prodPerUnit: number; consPerUnit: number };
      ratioEm?: { ratio: '1:1'; prodPerUnit: number; consPerUnit: number };
    }
  > = {
    'electronic-circuit': {
      consumerRecipeId: 'electronic-circuit',
      producerRecipeId: 'copper-cable',
      producerItem: 'copper-cable',
      ratio3x3: { ratio: '3:2', prodPerUnit: 3, consPerUnit: 2 },
      ratioEm: { ratio: '1:1', prodPerUnit: 1, consPerUnit: 1 },
    },
    rail: {
      consumerRecipeId: 'rail',
      producerRecipeId: 'iron-stick',
      producerItem: 'iron-stick',
      ratio3x3: { ratio: '1:2', prodPerUnit: 1, consPerUnit: 2 },
    },
  };

  const computedRecipes = new Map<string, ComputedRecipe>();
  const dag: DagSummaryNode[] = [];
  const defaultCap = effectiveBeltCapacity(spec.pdk.defaultBeltTier, spec.pdk);
  const qualityTier = spec.pdk.machineQuality ?? 'normal';
  const qualityMult = QUALITY_SPECS[qualityTier].speedMultiplier;
  const beaconMode = spec.pdk.beaconMode ?? 'none';
  const activeBeaconModules = (
    spec.pdk.beaconModules ?? ['speed-module-3', 'speed-module-3']
  )
    .filter((m) => !m.startsWith('productivity-module'))
    .slice(0, BEACON_SPEC.moduleSlots);
  let beaconSpeedPerUnit = 0;
  let beaconConsPerUnit = 0;
  for (const bm of activeBeaconModules) {
    beaconSpeedPerUnit += MODULE_SPECS[bm].speed;
    beaconConsPerUnit += MODULE_SPECS[bm].consumption;
  }

  for (const item of topoOrder) {
    const demand = demandPerSec.get(item) ?? 0;
    const dec = decisions.get(item)!;
    const meta = getItemMeta(item);

    if (dec.mode === 'input-pin' || !dec.recipe) {
      const cap = isFluidItem(item) ? PIPE_SPEC.capacityPerSec : defaultCap;
      dag.push({
        item,
        name: meta.name,
        demandPerSec: demand,
        demandPerMin: demand * 60,
        mode: 'input-pin',
        forcedInputReason: dec.forcedInputReason,
        exactMachines: 0,
        machineCount: 0,
        beltCount: Math.max(1, Math.ceil(demand / cap)),
        ingredients: [],
      });
      continue;
    }

    const recipe = dec.recipe;
    if (demand <= 1e-9 && !targetRates.has(item)) {
      continue;
    }
    const machineName: MachineName = selectMachineForRecipe(recipe, spec.pdk);
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

    const baseProd = machineSpec.baseProductivity ?? 0;
    const effectiveProd =
      1 + baseProd + (recipe.allowProductivity ? prodBonus : 0);

    // Ingredient flow depends solely on demand & productivity, independent of machine speed
    const rawIngredients: { item: string; ratePerSec: number }[] = [];
    const fluidIngredients: { item: string; ratePerSec: number }[] = [];
    for (const ing of recipe.ingredients) {
      if (ing.type === 'fluid') {
        if (fluidsEnabled) {
          const flRate = demand * (ing.amount / (recipe.outputCount * effectiveProd));
          fluidIngredients.push({ item: ing.item, ratePerSec: flRate });
        }
        continue;
      }
      const ingRate = demand * (ing.amount / (recipe.outputCount * effectiveProd));
      rawIngredients.push({ item: ing.item, ratePerSec: ingRate });
    }

    // Attempt direct-insertion fusion with upstream producer when enabled
    let fusedDirectInsert: ComputedRecipe['directInsert'] | undefined;
    let fusedExactMachines: number | undefined;
    let fusedMachineCount: number | undefined;

    const diPair = directInsertEnabled ? DIRECT_INSERT_PAIRS[recipe.id] : undefined;
    const diProdDec = diPair ? decisions.get(diPair.producerItem) : undefined;
    if (
      diPair &&
      diProdDec?.mode === 'synthesize' &&
      diProdDec.recipe?.id === diPair.producerRecipeId
    ) {
      const prodRecipe = diProdDec.recipe;
      const prodMachineName = selectMachineForRecipe(prodRecipe, spec.pdk);
      const prodMachineSpec = MACHINE_SPECS[prodMachineName];
      const diRatioSpec =
        machineName === 'electromagnetic-plant' &&
        prodMachineName === 'electromagnetic-plant' &&
        diPair.ratioEm
          ? diPair.ratioEm
          : machineSpec.size === 3 && prodMachineSpec.size === 3 && diPair.ratio3x3
            ? diPair.ratio3x3
            : undefined;

      if (diRatioSpec) {
        const tmpWarnings: string[] = [];
        const prodModules = resolveMachineModules(
          prodRecipe,
          prodMachineSpec.moduleSlots,
          spec.pdk,
          tmpWarnings,
        );
        let pSpd = 0;
        let pProd = 0;
        let pCons = 0;
        for (const m of prodModules) {
          const mod = MODULE_SPECS[m];
          pSpd += mod.speed;
          pProd += mod.productivity;
          pCons += mod.consumption;
        }
        const prodEffProd =
          1 + (prodMachineSpec.baseProductivity ?? 0) + (prodRecipe.allowProductivity ? pProd : 0);
        const prodEffSpeed =
          prodMachineSpec.craftingSpeed * qualityMult * Math.max(0.2, 1 + pSpd);
        const prodPowerMult = Math.max(0.2, 1 + pCons);

        const interEntry = rawIngredients.find((i) => i.item === diPair.producerItem);
        const consExtraInputs = rawIngredients.filter((i) => i.item !== diPair.producerItem);
        const intermediateRate = interEntry?.ratePerSec ?? 0;
        const prodInputs = prodRecipe.ingredients
          .filter((ing) => ing.type !== 'fluid')
          .map((ing) => ({
            item: ing.item,
            ratePerSec:
              intermediateRate * (ing.amount / (prodRecipe.outputCount * prodEffProd)),
          }));

        const disjointOk = !prodInputs.some((pi) =>
          consExtraInputs.some((ci) => ci.item === pi.item),
        );

        const consEffSpeedTmp =
          machineSpec.craftingSpeed * qualityMult * Math.max(0.2, 1 + speedBonus);
        const outPerConsMach =
          (recipe.outputCount * effectiveProd * consEffSpeedTmp) / recipe.energyRequired;
        const outPerProdMach =
          (prodRecipe.outputCount * prodEffProd * prodEffSpeed) / prodRecipe.energyRequired;

        const reach1PoolDi = spec.pdk.allowedInserterTiers.filter(
          (t): t is InserterTier => t !== 'long',
        );
        const maxReach1Di = Math.max(
          INSERTER_SPECS[spec.pdk.defaultInserterTier].itemsPerSec,
          ...reach1PoolDi.map((t) => INSERTER_SPECS[t].itemsPerSec),
        );
        const maxLongDi = INSERTER_SPECS.long.itemsPerSec;

        const nominalExtraPerCons =
          consExtraInputs.reduce((a, b) => a + b.ratePerSec, 0) /
          Math.max(1e-9, (demand / outPerConsMach));
        const nominalFeasible32 =
          diRatioSpec.ratio !== '3:2' || nominalExtraPerCons <= 2 * maxLongDi + 1e-4;

        if (disjointOk && nominalFeasible32) {
          const exactConsMach = demand / outPerConsMach;
          const exactProdMach = intermediateRate / outPerProdMach;
          let units = Math.max(
            1,
            Math.ceil(exactConsMach / diRatioSpec.consPerUnit),
            Math.ceil(exactProdMach / diRatioSpec.prodPerUnit),
          );

          const consExtraTotal = consExtraInputs.reduce((a, b) => a + b.ratePerSec, 0);
          const prodInTotal = prodInputs.reduce((a, b) => a + b.ratePerSec, 0);
          let ioFeasible = false;
          for (let guard = 0; guard < 16; guard++) {
            const cCount = units * diRatioSpec.consPerUnit;
            const pCount = units * diRatioSpec.prodPerUnit;
            const outPerC = demand / cCount;
            const extraPerC = consExtraTotal / cCount;
            const prodInPerP = prodInTotal / pCount;

            if (diRatioSpec.ratio === '3:2') {
              const outSlots = Math.ceil(outPerC / maxReach1Di);
              const ironSlots = extraPerC > 0 ? Math.ceil(extraPerC / maxLongDi) : 0;
              const directPerSlot = intermediateRate / (units * 6);
              if (
                outSlots + ironSlots <= 3 &&
                ironSlots <= 2 &&
                directPerSlot <= maxReach1Di + 1e-4 &&
                prodInPerP <= 2 * maxReach1Di + 1e-4
              ) {
                ioFeasible = true;
                break;
              }
            } else if (diRatioSpec.ratio === '1:2') {
              const outSlots = Math.ceil(outPerC / maxReach1Di);
              const extraSlots = extraPerC > 0 ? Math.ceil(extraPerC / maxReach1Di) : 0;
              const directPerC = intermediateRate / cCount;
              if (
                outSlots <= 2 &&
                extraSlots <= 3 &&
                directPerC <= maxReach1Di + 1e-4 &&
                prodInPerP <= 2 * maxReach1Di + 1e-4
              ) {
                ioFeasible = true;
                break;
              }
            } else {
              // 1:1 EM Plant
              const outSlots = Math.ceil(outPerC / maxReach1Di);
              const extraSlots = extraPerC > 0 ? Math.ceil(extraPerC / maxReach1Di) : 0;
              const directSlots = Math.ceil((intermediateRate / cCount) / maxReach1Di);
              const prodInSlots = Math.ceil(prodInPerP / maxReach1Di);
              if (outSlots <= 3 && extraSlots <= 2 && directSlots <= 3 && prodInSlots <= 3) {
                ioFeasible = true;
                break;
              }
            }
            units++;
          }

          if (ioFeasible) {
            warnings.push(...tmpWarnings);
            fusedExactMachines = exactConsMach + exactProdMach;
            fusedMachineCount = units * (diRatioSpec.prodPerUnit + diRatioSpec.consPerUnit);
            fusedDirectInsert = {
              ratio: diRatioSpec.ratio,
              producerRecipeId: prodRecipe.id,
              producerMachineName: prodMachineName,
              producerModules: prodModules,
              producerMachinesPerUnit: diRatioSpec.prodPerUnit,
              consumerMachinesPerUnit: diRatioSpec.consPerUnit,
              unitCount: units,
              intermediateItem: diPair.producerItem,
              intermediateRatePerSec: intermediateRate,
              producerInputs: prodInputs,
              consumerExtraInputs: consExtraInputs,
              producerPowerKwPerMachine: prodMachineSpec.powerKw * prodPowerMult,
            };
          }
        }
      }
    }

    const ingredients = fusedDirectInsert
      ? [...fusedDirectInsert.producerInputs, ...fusedDirectInsert.consumerExtraInputs]
      : rawIngredients;

    for (const ing of ingredients) {
      demandPerSec.set(ing.item, (demandPerSec.get(ing.item) ?? 0) + ing.ratePerSec);
    }
    for (const fl of fluidIngredients) {
      demandPerSec.set(fl.item, (demandPerSec.get(fl.item) ?? 0) + fl.ratePerSec);
    }

    const fullTrackCount = ingredients.filter((i) => i.ratePerSec > 0.48 * defaultCap).length;
    const halfTrackCount = ingredients.length - fullTrackCount;
    const neededTracks = fullTrackCount + Math.ceil(halfTrackCount / 2);

    let beaconsPerMachine = 0;
    if (
      beaconMode !== 'none' &&
      activeBeaconModules.length > 0 &&
      neededTracks <= 2 &&
      fluidIngredients.length === 0
    ) {
      if (beaconMode === 'row-8') {
        const canSingleNorthTrack =
          ingredients.length <= 1 ||
          (ingredients.length === 2 && ingredients.every((r) => r.ratePerSec <= 0.48 * defaultCap));
        beaconsPerMachine = canSingleNorthTrack ? 8 : 4;
      } else {
        beaconsPerMachine = 4;
      }
    }

    const beaconMult = beaconTransmissionMultiplier(beaconsPerMachine, qualityTier);
    const effectiveSpeed =
      machineSpec.craftingSpeed *
      qualityMult *
      Math.max(0.2, 1 + speedBonus + beaconMult * beaconSpeedPerUnit);
    const effectivePowerMult = Math.max(
      0.2,
      1 + consBonus + beaconMult * beaconConsPerUnit,
    );

    const outPerMachinePerSec =
      (recipe.outputCount * effectiveProd * effectiveSpeed) / recipe.energyRequired;
    const exactMachines = demand / outPerMachinePerSec;

    const reach1Pool = spec.pdk.allowedInserterTiers.filter(
      (t): t is InserterTier => t !== 'long',
    );
    const maxReach1 = Math.max(
      INSERTER_SPECS[spec.pdk.defaultInserterTier].itemsPerSec,
      ...reach1Pool.map((t) => INSERTER_SPECS[t].itemsPerSec),
    );
    const maxReach2 = INSERTER_SPECS.long.itemsPerSec;
    const ms = machineSpec.size;
    const totalIngRate = ingredients.reduce((a, b) => a + b.ratePerSec, 0);
    const maxOutPerMach = (ingredients.length <= 2 ? ms : Math.max(2, ms - 1)) * maxReach1;
    const maxInPerMach =
      ingredients.length <= 1
        ? ms * maxReach1
        : ingredients.length === 2
          ? Math.min((ms - 1) * maxReach1 + maxReach2, (ms - 1.5) * maxReach1 + 1.5 * maxReach2)
          : (ms - 1) * maxReach1 + 2 * maxReach2;

    const minSliceMachinesForIo = (outRate: number, totalIng: number, ingList: typeof ingredients): number => {
      let mReq = Math.max(
        1,
        Math.ceil(outRate / Math.max(0.1, maxOutPerMach)),
        Math.ceil(totalIng / Math.max(0.1, maxInPerMach)),
      );
      // When using Space Age or beaconed high-rate builds, verify actual placed per-machine inserter count meets STA.
      const isV2HighIo =
        ms >= 4 || qualityTier !== 'normal' || maxReach1 > 10 || beaconsPerMachine > 0;
      if (isV2HighIo && ingList.length > 0 && ingList.length <= 2) {
        const sorted = [...ingList].sort((a, b) => b.ratePerSec - a.ratePerSec);
        while (mReq < 64) {
          const rNear = sorted[0].ratePerSec / mReq;
          const cNear = Math.min(ms, Math.max(1, Math.ceil(rNear / maxReach1)));
          let capPerMach = cNear * maxReach1;
          if (sorted.length === 2 && beaconsPerMachine < 8) {
            const cNearBounded = Math.min(Math.max(1, ms - 1), cNear);
            const cFar = Math.min(2, Math.max(1, ms - cNearBounded));
            capPerMach = cNearBounded * maxReach1 + cFar * maxReach2;
          }
          if (mReq * capPerMach + 1e-4 >= totalIng) break;
          mReq++;
        }
      }
      return mReq;
    };

    const minMachinesForIo = minSliceMachinesForIo(demand, totalIngRate, ingredients);
    const finalExactMachines = fusedExactMachines ?? exactMachines;
    const machineCount =
      fusedMachineCount ?? Math.max(1, Math.ceil(exactMachines), minMachinesForIo);

    computedRecipes.set(item, {
      item,
      recipe,
      machineName,
      quality: qualityTier !== 'normal' ? qualityTier : undefined,
      modules,
      beaconsPerMachine,
      beaconModules: activeBeaconModules,
      effectiveSpeed,
      effectiveProd,
      exactMachines: finalExactMachines,
      machineCount,
      demandPerSec: demand,
      ingredients,
      fluidInputs: fluidIngredients,
      powerKwPerMachine: machineSpec.powerKw * effectivePowerMult,
      directInsert: fusedDirectInsert,
    });

    dag.push({
      item,
      name: meta.name,
      demandPerSec: demand,
      demandPerMin: demand * 60,
      mode: 'synthesize',
      recipeId: recipe.id,
      machineName,
      exactMachines: finalExactMachines,
      machineCount,
      beltCount: Math.max(1, Math.ceil(demand / defaultCap)),
      ingredients: [...ingredients, ...fluidIngredients],
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
      if (ing.type === 'fluid' && !fluidsEnabled) continue;
      maxIngDepth = Math.max(maxIngDepth, itemDepth.get(ing.item) ?? 0);
    }
    itemDepth.set(item, maxIngDepth + 1);
  }
  const maxItemDepth = Math.max(1, ...itemDepth.values());

  // 4. Slice recipes into single-belt RecipeMacroSpecs and build Primary Input / Output nodes
  const nodes: SynthNode[] = [];
  const macroNodesById = new Map<string, RecipeMacroSpec>();
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
    const isFluid = isFluidItem(d.item);
    const maxCap = isFluid
      ? PIPE_SPEC.capacityPerSec
      : effectiveBeltCapacity(
          spec.pdk.allowedBeltTiers.includes(spec.pdk.defaultBeltTier)
            ? spec.pdk.defaultBeltTier
            : spec.pdk.allowedBeltTiers[0] ?? 'red',
          spec.pdk,
        );
    const beltCount = Math.max(1, Math.ceil(d.demandPerSec / maxCap));
    const perBeltRate = d.demandPerSec / beltCount;
    const tier = isFluid ? spec.pdk.defaultBeltTier : pickBeltTierForRate(perBeltRate, spec.pdk);
    for (let i = 0; i < beltCount; i++) {
      const nodeId = `in:${d.item}:${i}`;
      const node: SynthInputNode = {
        id: nodeId,
        kind: 'primary-input',
        item: d.item,
        busIndex: i,
        ratePerSec: perBeltRate,
        beltTier: tier,
        isFluid: isFluid || undefined,
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
    const maxCap = effectiveBeltCapacity(spec.pdk.defaultBeltTier, spec.pdk);
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
    const maxBeltCap = effectiveBeltCapacity(spec.pdk.defaultBeltTier, spec.pdk);
    if (comp.directInsert) {
      const di = comp.directInsert;
      const machPerUnit = di.producerMachinesPerUnit + di.consumerMachinesPerUnit;
      let sliceCount = Math.max(
        1,
        Math.ceil(comp.demandPerSec / maxBeltCap),
        Math.ceil(comp.machineCount / MAX_MACHINES_PER_SLICE),
      );
      for (const ing of comp.ingredients) {
        sliceCount = Math.max(sliceCount, Math.ceil(ing.ratePerSec / maxBeltCap));
      }
      sliceCount = Math.min(sliceCount, di.unitCount);

      const equalFrac = 1 / sliceCount;
      const baseUnits = Math.floor(di.unitCount / sliceCount);
      const remUnits = di.unitCount % sliceCount;
      const maxInputOrOut = Math.max(
        comp.demandPerSec,
        ...comp.ingredients.map((i) => i.ratePerSec),
      );
      const unbalancedMax =
        di.unitCount > 0 && remUnits > 0
          ? ((baseUnits + 1) / di.unitCount) * maxInputOrOut
          : 0;
      const useUniformCeil = sliceCount > 1 && unbalancedMax > maxBeltCap + 1e-4;

      for (let s = 0; s < sliceCount; s++) {
        let sliceUnits = useUniformCeil
          ? Math.max(1, Math.ceil(di.unitCount / sliceCount))
          : baseUnits + (s < remUnits ? 1 : 0);
        const frac = sliceCount > 1 ? equalFrac : sliceUnits / di.unitCount;
        const sliceOutRate = comp.demandPerSec * frac;
        const sliceExactMachines = comp.exactMachines * frac;
        const outTier = pickBeltTierForRate(sliceOutRate, spec.pdk);
        const sliceBeltCap = effectiveBeltCapacity(outTier, spec.pdk);
        if (sliceOutRate > sliceBeltCap * 0.5 + 1e-4 && sliceUnits % 2 === 1) {
          const heavyLaneRate = (Math.ceil(sliceUnits / 2) / sliceUnits) * sliceOutRate;
          if (heavyLaneRate > sliceBeltCap * 0.5 - 1e-4) {
            sliceUnits += 1;
          }
        }
        const forceBal = Boolean(opts?.forceBalancedOutputs) && targetRates.has(comp.item);
        const mCount = sliceUnits * machPerUnit;
        const macroId =
          sliceCount === 1 ? `macro:${comp.recipe.id}` : `macro:${comp.recipe.id}:${s}`;
        const override = spec.macroOverrides[macroId];

        const prodInputs = di.producerInputs.map((ing) => {
          const r = ing.ratePerSec * frac;
          return { item: ing.item, ratePerSec: r, beltTier: pickBeltTierForRate(r, spec.pdk) };
        });
        const consExtraInputs = di.consumerExtraInputs.map((ing) => {
          const r = ing.ratePerSec * frac;
          return { item: ing.item, ratePerSec: r, beltTier: pickBeltTierForRate(r, spec.pdk) };
        });
        const ingRates = [...prodInputs, ...consExtraInputs];

        const macroNode: RecipeMacroSpec = {
          id: macroId,
          kind: 'recipe-macro',
          recipeId: comp.recipe.id,
          outputItem: comp.item,
          machineName: comp.machineName,
          quality: comp.quality,
          machineCount: mCount,
          exactMachines: sliceExactMachines,
          modules: comp.modules,
          directInsert: {
            ratio: di.ratio,
            producerRecipeId: di.producerRecipeId,
            producerMachineName: di.producerMachineName,
            producerModules: di.producerModules,
            producerMachinesPerUnit: di.producerMachinesPerUnit,
            consumerMachinesPerUnit: di.consumerMachinesPerUnit,
            unitCount: sliceUnits,
            intermediateItem: di.intermediateItem,
            intermediateRatePerSec: di.intermediateRatePerSec * frac,
            producerInputs: prodInputs,
            consumerExtraInputs: consExtraInputs,
          },
          effectiveSpeed: comp.effectiveSpeed,
          effectiveProd: comp.effectiveProd,
          outputRatePerSec: sliceOutRate,
          beltTier: outTier,
          ingredientRates: ingRates,
          preferredRows: override?.rows,
          balanceOutputLanes: forceBal || sliceOutRate > sliceBeltCap * 0.49,
          sliceIndex: s,
          sliceCount,
        };
        nodes.push(macroNode);
        macroNodesById.set(macroId, macroNode);
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
      continue;
    }

    let sliceCount = Math.max(
      1,
      Math.ceil(comp.demandPerSec / maxBeltCap),
      Math.ceil(comp.machineCount / MAX_MACHINES_PER_SLICE),
    );
    for (const ing of comp.ingredients) {
      sliceCount = Math.max(sliceCount, Math.ceil(ing.ratePerSec / maxBeltCap));
    }
    for (const fl of comp.fluidInputs) {
      sliceCount = Math.max(sliceCount, Math.ceil(fl.ratePerSec / PIPE_SPEC.capacityPerSec));
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

    const reach1PoolSlice = spec.pdk.allowedInserterTiers.filter(
      (t): t is InserterTier => t !== 'long',
    );
    const maxReach1Slice = Math.max(
      INSERTER_SPECS[spec.pdk.defaultInserterTier].itemsPerSec,
      ...reach1PoolSlice.map((t) => INSERTER_SPECS[t].itemsPerSec),
    );
    const maxReach2Slice = INSERTER_SPECS.long.itemsPerSec;
    const msSlice = MACHINE_SPECS[comp.machineName].size;
    const isV2HighIoSlice =
      msSlice >= 4 ||
      (spec.pdk.machineQuality ?? 'normal') !== 'normal' ||
      maxReach1Slice > 10 ||
      comp.beaconsPerMachine > 0;

    for (let s = 0; s < sliceCount; s++) {
      let mCount = useUniformCeil
        ? Math.max(
            1,
            Math.ceil(comp.exactMachines / sliceCount),
            Math.ceil(comp.machineCount / sliceCount),
          )
        : baseMachines + (s < remMachines ? 1 : 0);
      const frac = sliceCount > 1 ? equalFrac : mCount / comp.machineCount;
      const sliceOutRate = comp.demandPerSec * frac;
      const sliceExactMachines = comp.exactMachines * frac;
      const sliceIngTotal = comp.ingredients.reduce((acc, ing) => acc + ing.ratePerSec * frac, 0);
      if (isV2HighIoSlice && comp.ingredients.length > 0 && comp.ingredients.length <= 2) {
        const sortedSlice = [...comp.ingredients]
          .map((ing) => ing.ratePerSec * frac)
          .sort((a, b) => b - a);
        while (mCount < 64) {
          const rNear = sortedSlice[0] / mCount;
          const cNear = Math.min(msSlice, Math.max(1, Math.ceil(rNear / maxReach1Slice)));
          let capPerMach = cNear * maxReach1Slice;
          if (sortedSlice.length === 2 && comp.beaconsPerMachine < 8) {
            const cNearBounded = Math.min(Math.max(1, msSlice - 1), cNear);
            const cFar = Math.min(2, Math.max(1, msSlice - cNearBounded));
            capPerMach = cNearBounded * maxReach1Slice + cFar * maxReach2Slice;
          }
          if (mCount * capPerMach + 1e-4 >= sliceIngTotal) break;
          mCount++;
        }
      }
      const outTier = pickBeltTierForRate(sliceOutRate, spec.pdk);
      const sliceBeltCap = effectiveBeltCapacity(outTier, spec.pdk);
      if (sliceOutRate > sliceBeltCap * 0.5 + 1e-4 && mCount % 2 === 1) {
        const heavyLaneRate = (Math.ceil(mCount / 2) / mCount) * sliceOutRate;
        if (heavyLaneRate > sliceBeltCap * 0.5 - 1e-4) {
          mCount += 1;
        }
      }
      const forceBal = Boolean(opts?.forceBalancedOutputs) && targetRates.has(comp.item);
      if (forceBal && mCount >= 3 && mCount % 2 === 1) {
        mCount += 1;
      }
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

      const fluidInputs =
        comp.fluidInputs.length > 0
          ? comp.fluidInputs.map((fl) => ({ item: fl.item, ratePerSec: fl.ratePerSec * frac }))
          : undefined;

      const macroNode: RecipeMacroSpec = {
        id: macroId,
        kind: 'recipe-macro',
        recipeId: comp.recipe.id,
        outputItem: comp.item,
        machineName: comp.machineName,
        quality: comp.quality,
        machineCount: mCount,
        exactMachines: sliceExactMachines,
        modules: comp.modules,
        beaconsPerMachine: comp.beaconsPerMachine > 0 ? comp.beaconsPerMachine : undefined,
        beaconModules: comp.beaconsPerMachine > 0 ? comp.beaconModules : undefined,
        effectiveSpeed: comp.effectiveSpeed,
        effectiveProd: comp.effectiveProd,
        outputRatePerSec: sliceOutRate,
        beltTier: outTier,
        ingredientRates: ingRates,
        fluidInputs,
        preferredRows:
          override?.rows ?? (comp.beaconsPerMachine >= 8 ? 1 : undefined),
        balanceOutputLanes: forceBal || sliceOutRate > sliceBeltCap * 0.49,
        sliceIndex: s,
        sliceCount,
      };
      nodes.push(macroNode);
      macroNodesById.set(macroId, macroNode);
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
      if (fluidInputs) {
        for (const fl of fluidInputs) {
          addSink(fl.item, {
            nodeId: macroId,
            pinId: `in:${fl.item}`,
            ratePerSec: fl.ratePerSec,
            beltTier: spec.pdk.defaultBeltTier,
          });
        }
      }
    }
  }

  // 5. Connect sources -> sinks per item, inserting N x M Balancers on fan-in / fan-out
  const nets: SynthNet[] = [];
  let netCounter = 0;

  for (const [item, sources] of itemSources.entries()) {
    const sinks = itemSinks.get(item) ?? [];
    if (sinks.length === 0) continue;

    const isFluid = isFluidItem(item);
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
          isFluid: isFluid || undefined,
          source: { nodeId: src.nodeId, pinId: src.pinId, kind: 'source', item },
          sink: { nodeId: dst.nodeId, pinId: dst.pinId, kind: 'sink', item },
        });
      }
      continue;
    }

    if (isFluid) {
      const manId = `pipe-man:${item}:${S}x${D}`;
      const totalRate = sinks.reduce((acc, s) => acc + s.ratePerSec, 0);
      const tier = spec.pdk.defaultBeltTier;
      const manNode: BalancerMacroSpec = {
        id: manId,
        kind: 'balancer-macro',
        item,
        inputs: S,
        outputs: D,
        beltTier: tier,
        totalRatePerSec: totalRate,
        templateId: `pipe-manifold:${S}x${D}`,
        isFluid: true,
      };
      nodes.push(manNode);

      for (let i = 0; i < S; i++) {
        const src = sources[i];
        nets.push({
          id: `net:${netCounter++}:${item}:in${i}`,
          busId: `${item}:in`,
          busIndex: i,
          item,
          ratePerSec: src.ratePerSec,
          beltTier: tier,
          isFluid: true,
          source: { nodeId: src.nodeId, pinId: src.pinId, kind: 'source', item },
          sink: { nodeId: manId, pinId: `in:${i}`, kind: 'sink', item },
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
          beltTier: tier,
          isFluid: true,
          source: { nodeId: manId, pinId: `out:${j}`, kind: 'source', item },
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
      totalRate <= effectiveBeltCapacity(balTier, spec.pdk) + 1e-6 &&
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

    if (S >= 2) {
      const maxSinkRate = Math.max(...sinks.map((s) => s.ratePerSec));
      const balHalfCap = effectiveBeltCapacity(template.beltTier, spec.pdk) * 0.5;
      if (
        totalRate > balHalfCap - 1e-4 ||
        maxSinkRate > balHalfCap - 1e-4
      ) {
        for (const src of sources) {
          const rm = macroNodesById.get(src.nodeId);
          if (rm) {
            rm.balanceOutputLanes = true;
            if (rm.directInsert) {
              const di = rm.directInsert;
              if (di.unitCount >= 3 && di.unitCount % 2 === 1) {
                di.unitCount += 1;
                rm.machineCount =
                  di.unitCount * (di.producerMachinesPerUnit + di.consumerMachinesPerUnit);
              }
            } else if (rm.machineCount >= 3 && rm.machineCount % 2 === 1) {
              rm.machineCount += 1;
            }
          }
        }
      }
    }

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
      directInsert?: { producerPowerKwPerMachine: number };
    }
  >,
): BomSummary {
  const entities: Record<string, number> = {};
  const modules: Record<string, number> = {};
  let totalMachines = 0;
  let estimatedPowerKw = 0;

  for (const n of nodes) {
    if (n.kind === 'recipe-macro') {
      if (n.directInsert) {
        const di = n.directInsert;
        const pCount = di.unitCount * di.producerMachinesPerUnit;
        const cCount = di.unitCount * di.consumerMachinesPerUnit;
        entities[di.producerMachineName] = (entities[di.producerMachineName] ?? 0) + pCount;
        entities[n.machineName] = (entities[n.machineName] ?? 0) + cCount;
        totalMachines += pCount + cCount;
        const cr = computedRecipes.get(n.outputItem);
        const cKw = cr?.powerKwPerMachine ?? 150;
        const pKw = cr?.directInsert?.producerPowerKwPerMachine ?? cKw;
        estimatedPowerKw += pCount * pKw + cCount * cKw;
        for (const m of di.producerModules) {
          modules[m] = (modules[m] ?? 0) + pCount;
        }
        for (const m of n.modules) {
          modules[m] = (modules[m] ?? 0) + cCount;
        }
      } else {
        entities[n.machineName] = (entities[n.machineName] ?? 0) + n.machineCount;
        totalMachines += n.machineCount;
        const pKw = computedRecipes.get(n.outputItem)?.powerKwPerMachine ?? 150;
        estimatedPowerKw += n.machineCount * pKw;
        for (const m of n.modules) {
          modules[m] = (modules[m] ?? 0) + n.machineCount;
        }
      }
    }
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
