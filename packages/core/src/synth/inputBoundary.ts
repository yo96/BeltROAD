import { DesignSpec, RecipeDef } from '../types.js';
import {
  getDefaultRecipeForItem,
  getItemMeta,
  isFluidItem,
  isPresetInputItem,
} from '../data/catalog.js';
import { decideItemMode } from './synthesize.js';

export type InputBoundaryReason =
  | 'no-recipe'
  | 'fluid-disabled'
  | 'preset'
  | 'override'
  | 'synthesized'
  | 'target';

export interface InputBoundaryItem {
  item: string;
  name: string;
  category: string;
  isFluid: boolean;
  hasRecipe: boolean;
  hasFluidRecipe: boolean;
  canSynthesize: boolean;
  mode: 'target' | 'input' | 'synthesize' | 'behind-input';
  presetDefault: 'input' | 'synthesize';
  isOverridden: boolean;
  reason: InputBoundaryReason;
  minDepth: number;
}

export interface InputBoundaryTreeNode {
  pathKey: string;
  item: string;
  name: string;
  depth: number;
  isFluid: boolean;
  hasRecipe: boolean;
  hasFluidRecipe: boolean;
  status: 'target' | 'input' | 'synthesize' | 'behind-input';
  presetDefault: 'input' | 'synthesize';
  isOverridden: boolean;
  reason: InputBoundaryReason;
  /** Non-target ancestor items from shallowest (depth 1) down to this node's immediate parent */
  ancestorChain: string[];
  children: InputBoundaryTreeNode[];
}

export interface InputBoundaryInspection {
  activeInputs: InputBoundaryItem[];
  activeSynthesized: InputBoundaryItem[];
  allItems: InputBoundaryItem[];
  roots: InputBoundaryTreeNode[];
  overrideCount: number;
}

function resolveFluidsEnabledForSpec(spec: DesignSpec): boolean {
  if (spec.pdk.enableFluids) return true;
  if (
    spec.targets.some(
      (t) => isFluidItem(t.item) || Boolean(getDefaultRecipeForItem(t.item)?.hasFluid),
    )
  ) {
    return true;
  }
  return Object.entries(spec.inputOverrides).some(
    ([item, mode]) =>
      mode === 'synthesize' &&
      (isFluidItem(item) || Boolean(getDefaultRecipeForItem(item)?.hasFluid)),
  );
}

function presetDefaultMode(item: string, spec: DesignSpec): 'input' | 'synthesize' {
  const recipe = getDefaultRecipeForItem(item);
  if (!recipe) return 'input';
  return isPresetInputItem(item, spec.inputPreset) ? 'input' : 'synthesize';
}

function classifyReason(
  status: 'target' | 'input' | 'synthesize' | 'behind-input',
  item: string,
  spec: DesignSpec,
  forcedReason?: 'no-recipe' | 'fluid-v1' | 'preset',
): InputBoundaryReason {
  if (status === 'target') return 'target';
  const override = spec.inputOverrides[item];
  if (override === 'input' || override === 'synthesize') return 'override';
  if (forcedReason === 'no-recipe') return 'no-recipe';
  if (forcedReason === 'fluid-v1') return 'fluid-disabled';
  if (status === 'input') return 'preset';
  return 'synthesized';
}

/**
 * Inspects a DesignSpec's full multi-level supply chain from targets down to raw materials,
 * distinguishing active external input pins, actively synthesized stages, and deeper levels
 * currently pruned behind an input pin.
 */
export function inspectInputBoundary(spec: DesignSpec): InputBoundaryInspection {
  const targetSet = new Set<string>();
  const uniqueTargets: string[] = [];
  for (const t of spec.targets) {
    if (!t.item || targetSet.has(t.item)) continue;
    targetSet.add(t.item);
    uniqueTargets.push(t.item);
  }

  const fluidsEnabled = resolveFluidsEnabledForSpec(spec);
  const allItemsMap = new Map<string, InputBoundaryItem>();

  const statusPriority = (mode: InputBoundaryItem['mode']): number => {
    if (mode === 'target') return 4;
    if (mode === 'synthesize') return 3;
    if (mode === 'input') return 2;
    return 1; // 'behind-input'
  };

  const recordItem = (
    item: string,
    depth: number,
    status: InputBoundaryTreeNode['status'],
    recipe: RecipeDef | undefined,
    presetDef: 'input' | 'synthesize',
    isOverridden: boolean,
    reason: InputBoundaryReason,
  ) => {
    const meta = getItemMeta(item);
    const hasRecipe = Boolean(recipe);
    const existing = allItemsMap.get(item);
    if (!existing) {
      allItemsMap.set(item, {
        item,
        name: meta.name,
        category: meta.category,
        isFluid: meta.category === 'fluid',
        hasRecipe,
        hasFluidRecipe: Boolean(recipe?.hasFluid),
        canSynthesize: hasRecipe,
        mode: status,
        presetDefault: presetDef,
        isOverridden,
        reason,
        minDepth: depth,
      });
      return;
    }
    if (depth < existing.minDepth) {
      existing.minDepth = depth;
    }
    if (statusPriority(status) > statusPriority(existing.mode)) {
      existing.mode = status;
      existing.reason = reason;
      existing.isOverridden = isOverridden;
    }
  };

  const buildNode = (
    item: string,
    depth: number,
    pathPrefix: string,
    parentStatus: InputBoundaryTreeNode['status'] | null,
    ancestorChain: string[],
    pathStack: Set<string>,
  ): InputBoundaryTreeNode => {
    const isTarget = depth === 0 && targetSet.has(item);
    const dec = decideItemMode(item, spec, fluidsEnabled, isTarget);
    const recipe = dec.recipe ?? getDefaultRecipeForItem(item);
    const meta = getItemMeta(item);
    const presetDef = presetDefaultMode(item, spec);
    const isOverridden = !isTarget && spec.inputOverrides[item] !== undefined;

    let status: InputBoundaryTreeNode['status'];
    if (isTarget) {
      status = 'target';
    } else if (parentStatus === 'input' || parentStatus === 'behind-input') {
      status = 'behind-input';
    } else {
      status = dec.mode === 'input-pin' ? 'input' : 'synthesize';
    }

    const reason = classifyReason(status, item, spec, dec.forcedInputReason);
    recordItem(item, depth, status, recipe, presetDef, isOverridden, reason);

    const pathKey = pathPrefix ? `${pathPrefix}>${item}` : item;
    const children: InputBoundaryTreeNode[] = [];
    if (recipe && !pathStack.has(item)) {
      const nextStack = new Set(pathStack);
      nextStack.add(item);
      const childAncestors = isTarget ? ancestorChain : [...ancestorChain, item];
      for (const ing of recipe.ingredients) {
        children.push(
          buildNode(
            ing.item,
            depth + 1,
            pathKey,
            status,
            childAncestors,
            nextStack,
          ),
        );
      }
    }

    return {
      pathKey,
      item,
      name: meta.name,
      depth,
      isFluid: meta.category === 'fluid',
      hasRecipe: Boolean(recipe),
      hasFluidRecipe: Boolean(recipe?.hasFluid),
      status,
      presetDefault: presetDef,
      isOverridden,
      reason,
      ancestorChain: [...ancestorChain],
      children,
    };
  };

  const roots = uniqueTargets.map((item) =>
    buildNode(item, 0, '', null, [], new Set<string>()),
  );

  const allItems = Array.from(allItemsMap.values()).sort(
    (a, b) => a.minDepth - b.minDepth || a.name.localeCompare(b.name),
  );
  const activeInputs = allItems.filter((it) => it.mode === 'input');
  const activeSynthesized = allItems.filter(
    (it) => it.mode === 'synthesize' || it.mode === 'target',
  );
  const overrideCount = allItems.filter(
    (it) => it.mode !== 'target' && it.isOverridden,
  ).length;

  return {
    activeInputs,
    activeSynthesized,
    allItems,
    roots,
    overrideCount,
  };
}

function findShortestNonTargetChain(
  roots: InputBoundaryTreeNode[],
  targetItem: string,
): string[] | undefined {
  const queue: InputBoundaryTreeNode[] = [...roots];
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (node.item === targetItem && node.depth > 0) {
      return node.ancestorChain;
    }
    for (const child of node.children) {
      queue.push(child);
    }
  }
  return undefined;
}

/**
 * Immutably updates `spec.inputOverrides` for any-level item (`input`, `synthesize`, or `auto`),
 * automatically promoting collapsed ancestors to `'synthesize'` when a deep item is configured
 * and enabling `pdk.enableFluids` / `pdk.spaceAgeBuildings` when needed.
 */
export function applyInputOverride(
  spec: DesignSpec,
  item: string,
  nextMode: 'input' | 'synthesize' | 'auto',
  ancestorChain?: string[],
): DesignSpec {
  const targetSet = new Set(spec.targets.map((t) => t.item));
  const nextOverrides: Record<string, 'input' | 'synthesize'> = {
    ...spec.inputOverrides,
  };

  const setItemOverride = (it: string, mode: 'input' | 'synthesize' | 'auto') => {
    if (targetSet.has(it)) {
      delete nextOverrides[it];
      return;
    }
    const presetDef = presetDefaultMode(it, spec);
    if (mode === 'auto' || mode === presetDef) {
      delete nextOverrides[it];
    } else {
      nextOverrides[it] = mode;
    }
  };

  const inspection = inspectInputBoundary(spec);
  const itemInfo = inspection.allItems.find((i) => i.item === item);
  const resolvedChain =
    ancestorChain ??
    (nextMode !== 'auto' && itemInfo?.mode === 'behind-input'
      ? findShortestNonTargetChain(inspection.roots, item)
      : undefined);

  const newlySynthesized: string[] = [];

  if (nextMode !== 'auto' && resolvedChain && resolvedChain.length > 0) {
    for (const anc of resolvedChain) {
      if (targetSet.has(anc)) continue;
      const ancInfo = inspection.allItems.find((i) => i.item === anc);
      if (!ancInfo || ancInfo.mode === 'input' || ancInfo.mode === 'behind-input') {
        setItemOverride(anc, 'synthesize');
        newlySynthesized.push(anc);
      }
    }
  }

  setItemOverride(item, nextMode);
  if (nextMode === 'synthesize') {
    newlySynthesized.push(item);
  }

  let enableFluids = spec.pdk.enableFluids;
  let spaceAgeBuildings = spec.pdk.spaceAgeBuildings;
  for (const synItem of newlySynthesized) {
    const rec = getDefaultRecipeForItem(synItem);
    if (isFluidItem(synItem) || rec?.hasFluid) {
      enableFluids = true;
    }
    if (rec?.group === 'space-age') {
      spaceAgeBuildings = true;
    }
  }

  const pdkChanged =
    enableFluids !== spec.pdk.enableFluids ||
    spaceAgeBuildings !== spec.pdk.spaceAgeBuildings;

  return {
    ...spec,
    ...(pdkChanged
      ? {
          pdk: {
            ...spec.pdk,
            enableFluids,
            spaceAgeBuildings,
          },
        }
      : {}),
    inputOverrides: nextOverrides,
  };
}
