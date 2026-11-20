import recipesJson from './recipes.json' with { type: 'json' };
import { InputPreset, ItemMeta, RecipeDef } from '../types.js';

export interface RecipeCatalog {
  version: string;
  items: Record<string, ItemMeta>;
  recipesById: Record<string, RecipeDef>;
  recipesByOutput: Record<string, RecipeDef[]>;
  solidTargets: RecipeDef[];
}

export interface RawCatalogJson {
  version: string;
  items: Record<string, ItemMeta>;
  recipes: RecipeDef[];
}

export function buildCatalog(raw: RawCatalogJson): RecipeCatalog {
  const recipesById: Record<string, RecipeDef> = {};
  const recipesByOutput: Record<string, RecipeDef[]> = {};

  for (const r of raw.recipes) {
    recipesById[r.id] = r;
    if (!recipesByOutput[r.outputItem]) {
      recipesByOutput[r.outputItem] = [];
    }
    recipesByOutput[r.outputItem].push(r);
  }

  const solidTargets = raw.recipes.filter((r) => !r.hasFluid);

  return {
    version: raw.version,
    items: raw.items,
    recipesById,
    recipesByOutput,
    solidTargets,
  };
}

let activeCatalog: RecipeCatalog = buildCatalog(recipesJson as RawCatalogJson);

export function getCatalog(): RecipeCatalog {
  return activeCatalog;
}

export function loadCustomCatalog(raw: RawCatalogJson): RecipeCatalog {
  activeCatalog = buildCatalog(raw);
  return activeCatalog;
}

export function resetDefaultCatalog(): RecipeCatalog {
  activeCatalog = buildCatalog(recipesJson as RawCatalogJson);
  return activeCatalog;
}

export function getItemMeta(itemId: string): ItemMeta {
  const found = activeCatalog.items[itemId];
  if (found) return found;
  return {
    id: itemId,
    name: itemId
      .split('-')
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
      .join(' '),
    color: '#94a3b8',
    category: 'other',
    stackSize: 50,
  };
}

export function getDefaultRecipeForItem(itemId: string): RecipeDef | undefined {
  const list = activeCatalog.recipesByOutput[itemId];
  if (!list || list.length === 0) return undefined;
  return list[0];
}

const RAW_PRESET_ITEMS = new Set([
  'iron-ore',
  'copper-ore',
  'stone',
  'coal',
  'wood',
  'uranium-ore',
  'solid-fuel',
]);

const PLATES_PRESET_ITEMS = new Set([
  ...RAW_PRESET_ITEMS,
  'iron-plate',
  'copper-plate',
  'steel-plate',
  'stone-brick',
]);

const BUS_PRESET_ITEMS = new Set([
  ...PLATES_PRESET_ITEMS,
  'electronic-circuit',
  'advanced-circuit',
  'plastic-bar',
  'sulfur',
  'battery',
  'processing-unit',
  'electric-engine-unit',
  'low-density-structure',
]);

export function isPresetInputItem(itemId: string, preset: InputPreset): boolean {
  if (preset === 'raw') return RAW_PRESET_ITEMS.has(itemId);
  if (preset === 'plates') return PLATES_PRESET_ITEMS.has(itemId);
  return BUS_PRESET_ITEMS.has(itemId);
}
