import recipesJson from './recipes.json' with { type: 'json' };
import { InputPreset, ItemMeta, RecipeDef } from '../types.js';

export interface RecipeCatalog {
  version: string;
  items: Record<string, ItemMeta>;
  recipesById: Record<string, RecipeDef>;
  recipesByOutput: Record<string, RecipeDef[]>;
  solidTargets: RecipeDef[];
  allTargets: RecipeDef[];
}

export interface RawCatalogJson {
  version: string;
  items: Record<string, ItemMeta>;
  recipes: RecipeDef[];
}

export type RawCatalog = RawCatalogJson;

function normalizeAndValidateCatalog(raw: unknown): RawCatalogJson {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Custom recipe catalog must be a JSON object.');
  }
  const obj = raw as Record<string, unknown>;
  const version =
    typeof obj.version === 'string' && obj.version.trim().length > 0
      ? obj.version.trim()
      : 'custom-1.0';

  const normalizedItems: Record<string, ItemMeta> = {};
  if (Array.isArray(obj.items)) {
    if (obj.items.length === 0) {
      throw new Error('Custom recipe catalog "items" must not be empty.');
    }
    for (let i = 0; i < obj.items.length; i++) {
      const it = obj.items[i] as Record<string, unknown> | null;
      if (!it || typeof it !== 'object' || typeof it.id !== 'string' || !it.id.trim() || typeof it.name !== 'string' || !it.name.trim()) {
        throw new Error(`Invalid item at items[${i}]: expected non-empty string "id" and "name".`);
      }
      normalizedItems[it.id] = {
        id: it.id,
        name: it.name,
        color: typeof it.color === 'string' ? it.color : '#94a3b8',
        category: typeof it.category === 'string' ? it.category : 'other',
        stackSize: typeof it.stackSize === 'number' && it.stackSize > 0 ? it.stackSize : 50,
      };
    }
  } else if (obj.items && typeof obj.items === 'object') {
    const entries = Object.entries(obj.items as Record<string, unknown>);
    if (entries.length === 0) {
      throw new Error('Custom recipe catalog "items" map must not be empty.');
    }
    for (const [key, val] of entries) {
      const it = val as Record<string, unknown> | null;
      if (!it || typeof it !== 'object') {
        throw new Error(`Invalid item entry "${key}": expected an object.`);
      }
      const id = typeof it.id === 'string' && it.id.trim() ? it.id.trim() : key;
      const name = typeof it.name === 'string' && it.name.trim() ? it.name.trim() : '';
      if (!id || !name) {
        throw new Error(`Invalid item "${key}": expected non-empty string "id" and "name".`);
      }
      normalizedItems[id] = {
        id,
        name,
        color: typeof it.color === 'string' ? it.color : '#94a3b8',
        category: typeof it.category === 'string' ? it.category : 'other',
        stackSize: typeof it.stackSize === 'number' && it.stackSize > 0 ? it.stackSize : 50,
      };
    }
  } else {
    throw new Error('Custom recipe catalog must contain a non-empty "items" object or array.');
  }

  if (!Array.isArray(obj.recipes) || obj.recipes.length === 0) {
    throw new Error('Custom recipe catalog must contain a non-empty "recipes" array.');
  }

  const normalizedRecipes: RecipeDef[] = obj.recipes.map((rec, i) => {
    const r = rec as Record<string, unknown> | null;
    if (!r || typeof r !== 'object') {
      throw new Error(`Invalid recipe at recipes[${i}]: expected an object.`);
    }
    if (typeof r.id !== 'string' || !r.id.trim() || typeof r.name !== 'string' || !r.name.trim()) {
      throw new Error(`Invalid recipe at recipes[${i}]: expected non-empty string "id" and "name".`);
    }
    if (typeof r.energyRequired !== 'number' || !Number.isFinite(r.energyRequired) || r.energyRequired <= 0) {
      throw new Error(`Invalid recipe "${r.id}": "energyRequired" must be a positive number.`);
    }
    if (typeof r.outputItem !== 'string' || !r.outputItem.trim()) {
      throw new Error(`Invalid recipe "${r.id}": "outputItem" must be a non-empty string.`);
    }
    const outputCount =
      typeof r.outputCount === 'number' && Number.isFinite(r.outputCount) && r.outputCount > 0
        ? r.outputCount
        : 1;
    if (!Array.isArray(r.ingredients) || r.ingredients.length === 0) {
      throw new Error(`Invalid recipe "${r.id}": "ingredients" must be a non-empty array.`);
    }
    const ingredients = r.ingredients.map((ing, j) => {
      const g = ing as Record<string, unknown> | null;
      if (
        !g ||
        typeof g !== 'object' ||
        typeof g.item !== 'string' ||
        !g.item.trim() ||
        typeof g.amount !== 'number' ||
        !Number.isFinite(g.amount) ||
        g.amount <= 0
      ) {
        throw new Error(
          `Invalid ingredient ${j} in recipe "${r.id}": expected non-empty "item" and positive "amount".`,
        );
      }
      return {
        item: g.item.trim(),
        amount: g.amount,
        type: g.type === 'fluid' ? ('fluid' as const) : g.type === 'item' ? ('item' as const) : undefined,
      };
    });

    const category =
      typeof r.category === 'string' &&
      [
        'crafting',
        'advanced-crafting',
        'crafting-with-fluid',
        'smelting',
        'chemistry',
        'oil-processing',
        'metallurgy',
        'electromagnetics',
        'cryogenics',
      ].includes(r.category)
        ? (r.category as RecipeDef['category'])
        : 'crafting';

    return {
      id: r.id.trim(),
      name: r.name.trim(),
      category,
      energyRequired: r.energyRequired,
      ingredients,
      outputItem: r.outputItem.trim(),
      outputCount,
      allowProductivity: typeof r.allowProductivity === 'boolean' ? r.allowProductivity : false,
      hasFluid:
        typeof r.hasFluid === 'boolean'
          ? r.hasFluid
          : ingredients.some((ing) => ing.type === 'fluid') ||
            normalizedItems[r.outputItem.trim()]?.category === 'fluid',
      color: typeof r.color === 'string' ? r.color : undefined,
      group: typeof r.group === 'string' ? r.group : undefined,
    };
  });

  return {
    version,
    items: normalizedItems,
    recipes: normalizedRecipes,
  };
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
  const allTargets = [...raw.recipes];

  return {
    version: raw.version,
    items: raw.items,
    recipesById,
    recipesByOutput,
    solidTargets,
    allTargets,
  };
}

let activeCatalog: RecipeCatalog = buildCatalog(recipesJson as RawCatalogJson);

export function getCatalog(): RecipeCatalog {
  return activeCatalog;
}

export function getDefaultCatalogRaw(): RawCatalogJson {
  return structuredClone(recipesJson as RawCatalogJson);
}

export function loadCustomCatalog(raw: unknown): RecipeCatalog {
  const validated = normalizeAndValidateCatalog(raw);
  activeCatalog = buildCatalog(validated);
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

export function isFluidItem(itemId: string): boolean {
  return getItemMeta(itemId).category === 'fluid';
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
  'holmium-ore',
  'water',
  'crude-oil',
  'fluoroketone-cold',
]);

const PLATES_PRESET_ITEMS = new Set([
  ...RAW_PRESET_ITEMS,
  'heavy-oil',
  'light-oil',
  'petroleum-gas',
  'sulfuric-acid',
  'lubricant',
  'molten-iron',
  'molten-copper',
  'holmium-solution',
  'electrolyte',
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

export interface InputPresetMeta {
  id: InputPreset;
  label: string;
  shortLabel: string;
  description: string;
}

export const INPUT_PRESET_LIST: InputPresetMeta[] = [
  {
    id: 'raw',
    label: 'Raw Ores & Fluids',
    shortLabel: 'Raw',
    description:
      'Only ores, coal, stone, and raw fluids enter as pins; smelt plates and craft everything on-site.',
  },
  {
    id: 'plates',
    label: 'Plates & Base',
    shortLabel: 'Plates',
    description: 'Iron/Copper/Steel plates, stone brick, raw resources, and fluids enter as pins.',
  },
  {
    id: 'bus',
    label: 'Main Bus',
    shortLabel: 'Bus',
    description:
      'Plates plus Green/Red/Blue circuits, plastic, sulfur, battery, electric engine, and LDS.',
  },
  {
    id: 'intermediates',
    label: 'Mid-Tier Parts',
    shortLabel: 'Mid-Tier',
    description:
      'Bus items plus gears, cables, pipes, engines, robot frames, modules, rails, and Space Age intermediates.',
  },
  {
    id: 'direct',
    label: 'Direct Ingredients Only',
    shortLabel: 'Direct',
    description:
      'Synthesize only the final target recipe(s); every direct ingredient becomes an external input pin.',
  },
];

const INTERMEDIATES_PRESET_ITEMS = new Set([
  ...BUS_PRESET_ITEMS,
  'iron-gear-wheel',
  'copper-cable',
  'iron-stick',
  'pipe',
  'engine-unit',
  'flying-robot-frame',
  'inserter',
  'transport-belt',
  'rail',
  'electric-furnace',
  'speed-module',
  'productivity-module',
  'efficiency-module',
  'stone-wall',
  'grenade',
  'piercing-rounds-magazine',
  'carbon',
  'tungsten-carbide',
  'tungsten-plate',
  'holmium-plate',
  'superconductor',
  'supercapacitor',
  'carbon-fiber',
  'lithium-plate',
]);

export function isPresetInputItem(itemId: string, preset: InputPreset): boolean {
  if (preset === 'direct') return true;
  if (preset === 'raw') return RAW_PRESET_ITEMS.has(itemId);
  if (preset === 'plates') return PLATES_PRESET_ITEMS.has(itemId);
  if (preset === 'bus') return BUS_PRESET_ITEMS.has(itemId);
  return INTERMEDIATES_PRESET_ITEMS.has(itemId);
}
