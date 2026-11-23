import {
  AllInserterKind,
  AssemblerTier,
  BeltTier,
  Dir,
  MachineName,
  ModuleName,
  PdkConfig,
  PoleTier,
  QualityTier,
  RecipeDef,
} from '../types.js';

export interface BeltSpec {
  tier: BeltTier;
  beltName:
    | 'transport-belt'
    | 'fast-transport-belt'
    | 'express-transport-belt'
    | 'turbo-transport-belt';
  undergroundName:
    | 'underground-belt'
    | 'fast-underground-belt'
    | 'express-underground-belt'
    | 'turbo-underground-belt';
  splitterName: 'splitter' | 'fast-splitter' | 'express-splitter' | 'turbo-splitter';
  itemsPerSec: number;
  /** Factorio max_distance between underground pair (5 = max 4 skipped tiles) */
  maxUgDistance: number;
  color: string;
}

export const BELT_SPECS: Record<BeltTier, BeltSpec> = {
  yellow: {
    tier: 'yellow',
    beltName: 'transport-belt',
    undergroundName: 'underground-belt',
    splitterName: 'splitter',
    itemsPerSec: 15,
    maxUgDistance: 5,
    color: '#eab308',
  },
  red: {
    tier: 'red',
    beltName: 'fast-transport-belt',
    undergroundName: 'fast-underground-belt',
    splitterName: 'fast-splitter',
    itemsPerSec: 30,
    maxUgDistance: 7,
    color: '#ef4444',
  },
  blue: {
    tier: 'blue',
    beltName: 'express-transport-belt',
    undergroundName: 'express-underground-belt',
    splitterName: 'express-splitter',
    itemsPerSec: 45,
    maxUgDistance: 9,
    color: '#38bdf8',
  },
  turbo: {
    tier: 'turbo',
    beltName: 'turbo-transport-belt',
    undergroundName: 'turbo-underground-belt',
    splitterName: 'turbo-splitter',
    itemsPerSec: 60,
    maxUgDistance: 11,
    color: '#22c55e',
  },
};

export function effectiveBeltCapacity(
  tier: BeltTier,
  pdk?: Pick<PdkConfig, 'beltStackSize'>,
): number {
  const stack = pdk?.beltStackSize ?? 1;
  return BELT_SPECS[tier].itemsPerSec * stack;
}

export interface QualitySpec {
  tier: QualityTier;
  label: string;
  speedMultiplier: number;
  color: string;
  level: number;
}

export const QUALITY_SPECS: Record<QualityTier, QualitySpec> = {
  normal: { tier: 'normal', label: 'Normal', speedMultiplier: 1.0, color: '#94a3b8', level: 0 },
  uncommon: { tier: 'uncommon', label: 'Uncommon', speedMultiplier: 1.3, color: '#4ade80', level: 1 },
  rare: { tier: 'rare', label: 'Rare', speedMultiplier: 1.6, color: '#38bdf8', level: 2 },
  epic: { tier: 'epic', label: 'Epic', speedMultiplier: 1.9, color: '#c084fc', level: 3 },
  legendary: { tier: 'legendary', label: 'Legendary', speedMultiplier: 2.5, color: '#f59e0b', level: 4 },
};

export interface MachineSpec {
  name: MachineName;
  size: number;
  craftingSpeed: number;
  moduleSlots: number;
  baseProductivity?: number;
  powerKw: number;
  drainKw: number;
}

export const MACHINE_SPECS: Record<MachineName, MachineSpec> = {
  'assembling-machine-1': {
    name: 'assembling-machine-1',
    size: 3,
    craftingSpeed: 0.5,
    moduleSlots: 0,
    powerKw: 75,
    drainKw: 2.5,
  },
  'assembling-machine-2': {
    name: 'assembling-machine-2',
    size: 3,
    craftingSpeed: 0.75,
    moduleSlots: 2,
    powerKw: 150,
    drainKw: 5,
  },
  'assembling-machine-3': {
    name: 'assembling-machine-3',
    size: 3,
    craftingSpeed: 1.25,
    moduleSlots: 4,
    powerKw: 375,
    drainKw: 12.5,
  },
  'electric-furnace': {
    name: 'electric-furnace',
    size: 3,
    craftingSpeed: 2.0,
    moduleSlots: 2,
    powerKw: 180,
    drainKw: 6,
  },
  foundry: {
    name: 'foundry',
    size: 4,
    craftingSpeed: 4.0,
    moduleSlots: 4,
    baseProductivity: 0.5,
    powerKw: 2500,
    drainKw: 83.3,
  },
  'electromagnetic-plant': {
    name: 'electromagnetic-plant',
    size: 4,
    craftingSpeed: 2.0,
    moduleSlots: 5,
    baseProductivity: 0.5,
    powerKw: 2000,
    drainKw: 66.7,
  },
  'cryogenic-plant': {
    name: 'cryogenic-plant',
    size: 5,
    craftingSpeed: 2.0,
    moduleSlots: 8,
    baseProductivity: 0,
    powerKw: 1500,
    drainKw: 50,
  },
};

export const EM_PLANT_RECIPES = new Set([
  'copper-cable',
  'electronic-circuit',
  'advanced-circuit',
  'processing-unit',
  'battery',
  'accumulator',
  'solar-panel',
  'substation',
  'beacon',
  'roboport',
  'speed-module',
  'speed-module-2',
  'speed-module-3',
  'productivity-module',
  'productivity-module-2',
  'productivity-module-3',
  'efficiency-module',
  'efficiency-module-2',
  'efficiency-module-3',
]);

export const FOUNDRY_RECIPES = new Set([
  'transport-belt',
  'fast-transport-belt',
  'express-transport-belt',
  'turbo-transport-belt',
  'underground-belt',
  'fast-underground-belt',
  'express-underground-belt',
  'turbo-underground-belt',
  'splitter',
  'fast-splitter',
  'express-splitter',
  'turbo-splitter',
  'pipe',
  'pipe-to-ground',
  'concrete',
  'refined-concrete',
]);

export const CRYO_PLANT_RECIPES = new Set([
  'plastic-bar',
  'sulfur',
  'explosives',
  'solid-fuel',
  'sulfuric-acid',
  'lubricant',
]);

export function selectMachineForRecipe(recipe: RecipeDef, pdk: PdkConfig): MachineName {
  if (pdk.spaceAgeBuildings) {
    if (EM_PLANT_RECIPES.has(recipe.id) || EM_PLANT_RECIPES.has(recipe.outputItem)) {
      return 'electromagnetic-plant';
    }
    if (FOUNDRY_RECIPES.has(recipe.id) || FOUNDRY_RECIPES.has(recipe.outputItem)) {
      return 'foundry';
    }
    if (
      recipe.category === 'chemistry' ||
      CRYO_PLANT_RECIPES.has(recipe.id) ||
      CRYO_PLANT_RECIPES.has(recipe.outputItem)
    ) {
      return 'cryogenic-plant';
    }
  }
  return recipe.category === 'smelting'
    ? 'electric-furnace'
    : assemblerNameForTier(pdk.defaultAssemblerTier);
}

export function assemblerNameForTier(tier: AssemblerTier): MachineName {
  if (tier === 1) return 'assembling-machine-1';
  if (tier === 2) return 'assembling-machine-2';
  return 'assembling-machine-3';
}

export interface InserterSpec {
  kind: AllInserterKind;
  name:
    | 'inserter'
    | 'long-handed-inserter'
    | 'fast-inserter'
    | 'bulk-inserter'
    | 'stack-inserter';
  reach: 1 | 2;
  /** Conservative belt<->machine items/s throughput */
  itemsPerSec: number;
  powerKw: number;
  color: string;
}

export const INSERTER_SPECS: Record<AllInserterKind, InserterSpec> = {
  yellow: {
    kind: 'yellow',
    name: 'inserter',
    reach: 1,
    itemsPerSec: 0.83,
    powerKw: 15,
    color: '#facc15',
  },
  long: {
    kind: 'long',
    name: 'long-handed-inserter',
    reach: 2,
    itemsPerSec: 1.15,
    powerKw: 20,
    color: '#ef4444',
  },
  fast: {
    kind: 'fast',
    name: 'fast-inserter',
    reach: 1,
    itemsPerSec: 2.31,
    powerKw: 59,
    color: '#38bdf8',
  },
  bulk: {
    kind: 'bulk',
    name: 'bulk-inserter',
    reach: 1,
    itemsPerSec: 6.0,
    powerKw: 169,
    color: '#4ade80',
  },
  stack: {
    kind: 'stack',
    name: 'stack-inserter',
    reach: 1,
    itemsPerSec: 16.0,
    powerKw: 200,
    color: '#f8fafc',
  },
};

export const INSERTER_BY_ENTITY_NAME: Record<string, InserterSpec> = {
  inserter: INSERTER_SPECS.yellow,
  'long-handed-inserter': INSERTER_SPECS.long,
  'fast-inserter': INSERTER_SPECS.fast,
  'bulk-inserter': INSERTER_SPECS.bulk,
  'stack-inserter': INSERTER_SPECS.stack,
};

export interface PoleSpec {
  tier: PoleTier;
  name: 'small-electric-pole' | 'medium-electric-pole' | 'substation';
  size: 1 | 2;
  /** Half-width of supply square centered at pole center */
  supplyRadius: number;
  wireReach: number;
  color: string;
}

export const POLE_SPECS: Record<PoleTier, PoleSpec> = {
  small: {
    tier: 'small',
    name: 'small-electric-pole',
    size: 1,
    supplyRadius: 2.5,
    wireReach: 7.5,
    color: '#d97706',
  },
  medium: {
    tier: 'medium',
    name: 'medium-electric-pole',
    size: 1,
    supplyRadius: 3.5,
    wireReach: 9.0,
    color: '#94a3b8',
  },
  substation: {
    tier: 'substation',
    name: 'substation',
    size: 2,
    supplyRadius: 9.0,
    wireReach: 18.0,
    color: '#38bdf8',
  },
};

export const POLE_BY_ENTITY_NAME: Record<string, PoleSpec> = {
  'small-electric-pole': POLE_SPECS.small,
  'medium-electric-pole': POLE_SPECS.medium,
  substation: POLE_SPECS.substation,
};

export const BEACON_SPEC = {
  name: 'beacon' as const,
  size: 3,
  supplyDistance: 3,
  moduleSlots: 2,
  powerKw: 480,
  baseEffectivity: 1.5,
};

export const BEACON_QUALITY_EFFECTIVITY: Record<QualityTier, number> = {
  normal: 1.5,
  uncommon: 1.7,
  rare: 1.9,
  epic: 2.1,
  legendary: 2.5,
};

/** Factorio 2.0 beacon transmission efficiency: effectivity * sqrt(N) */
export function beaconTransmissionMultiplier(
  beaconCount: number,
  quality: QualityTier = 'normal',
): number {
  if (beaconCount <= 0) return 0;
  return BEACON_QUALITY_EFFECTIVITY[quality] * Math.sqrt(beaconCount);
}

export function doesBeaconAffectEntity(
  beacon: { tx: number; ty: number; w: number; h: number },
  target: { tx: number; ty: number; w: number; h: number },
): boolean {
  const d = BEACON_SPEC.supplyDistance;
  return (
    target.tx + target.w > beacon.tx - d &&
    target.tx < beacon.tx + beacon.w + d &&
    target.ty + target.h > beacon.ty - d &&
    target.ty < beacon.ty + beacon.h + d
  );
}

export function countBeaconsAffectingMachine(
  machine: { tx: number; ty: number; w: number; h: number },
  beacons: Array<{ tx: number; ty: number; w: number; h: number }>,
): number {
  let count = 0;
  for (const b of beacons) {
    if (doesBeaconAffectEntity(b, machine)) count++;
  }
  return count;
}

export interface ModuleModifier {
  name: ModuleName;
  label: string;
  speed: number;
  productivity: number;
  consumption: number;
}

export const MODULE_SPECS: Record<ModuleName, ModuleModifier> = {
  'speed-module': { name: 'speed-module', label: 'Speed 1', speed: 0.2, productivity: 0, consumption: 0.5 },
  'speed-module-2': { name: 'speed-module-2', label: 'Speed 2', speed: 0.3, productivity: 0, consumption: 0.6 },
  'speed-module-3': { name: 'speed-module-3', label: 'Speed 3', speed: 0.5, productivity: 0, consumption: 0.7 },
  'productivity-module': { name: 'productivity-module', label: 'Prod 1', speed: -0.05, productivity: 0.04, consumption: 0.4 },
  'productivity-module-2': { name: 'productivity-module-2', label: 'Prod 2', speed: -0.1, productivity: 0.06, consumption: 0.6 },
  'productivity-module-3': { name: 'productivity-module-3', label: 'Prod 3', speed: -0.15, productivity: 0.1, consumption: 0.8 },
  'efficiency-module': { name: 'efficiency-module', label: 'Eff 1', speed: 0, productivity: 0, consumption: -0.3 },
  'efficiency-module-2': { name: 'efficiency-module-2', label: 'Eff 2', speed: 0, productivity: 0, consumption: -0.4 },
  'efficiency-module-3': { name: 'efficiency-module-3', label: 'Eff 3', speed: 0, productivity: 0, consumption: -0.5 },
};

export function beltTierFromEntityName(name: string): BeltTier | null {
  if (name === 'transport-belt' || name === 'underground-belt' || name === 'splitter') return 'yellow';
  if (name === 'fast-transport-belt' || name === 'fast-underground-belt' || name === 'fast-splitter') return 'red';
  if (name === 'express-transport-belt' || name === 'express-underground-belt' || name === 'express-splitter') return 'blue';
  if (name === 'turbo-transport-belt' || name === 'turbo-underground-belt' || name === 'turbo-splitter') return 'turbo';
  return null;
}

export function isBeltLikeName(name: string): boolean {
  return beltTierFromEntityName(name) !== null;
}

export function isUndergroundName(name: string): boolean {
  return (
    name === 'underground-belt' ||
    name === 'fast-underground-belt' ||
    name === 'express-underground-belt' ||
    name === 'turbo-underground-belt'
  );
}

export function isSplitterName(name: string): boolean {
  return (
    name === 'splitter' ||
    name === 'fast-splitter' ||
    name === 'express-splitter' ||
    name === 'turbo-splitter'
  );
}

export function isMachineName(name: string): boolean {
  return name in MACHINE_SPECS;
}

export function requiresPower(name: string): boolean {
  return isMachineName(name) || name === 'beacon' || name in INSERTER_BY_ENTITY_NAME;
}

export function splitterFootprint(direction: Dir): { w: number; h: number } {
  // North/South splitters are 2 wide x 1 tall; East/West are 1 wide x 2 tall.
  return direction === Dir.NORTH || direction === Dir.SOUTH ? { w: 2, h: 1 } : { w: 1, h: 2 };
}

export function doesPoleSupplyEntity(
  poleTx: number,
  poleTy: number,
  poleSpec: PoleSpec,
  entTx: number,
  entTy: number,
  entW: number,
  entH: number,
): boolean {
  const pcx = poleTx + poleSpec.size / 2;
  const pcy = poleTy + poleSpec.size / 2;
  const sMinX = pcx - poleSpec.supplyRadius;
  const sMaxX = pcx + poleSpec.supplyRadius;
  const sMinY = pcy - poleSpec.supplyRadius;
  const sMaxY = pcy + poleSpec.supplyRadius;

  const eMinX = entTx;
  const eMaxX = entTx + entW;
  const eMinY = entTy;
  const eMaxY = entTy + entH;

  // Factorio checks overlap between entity bounding box and pole supply area
  return eMaxX > sMinX && eMinX < sMaxX && eMaxY > sMinY && eMinY < sMaxY;
}
