import {
  AllInserterKind,
  AssemblerTier,
  BeltTier,
  Dir,
  ModuleName,
  PoleTier,
} from '../types.js';

export interface BeltSpec {
  tier: BeltTier;
  beltName: 'transport-belt' | 'fast-transport-belt' | 'express-transport-belt';
  undergroundName: 'underground-belt' | 'fast-underground-belt' | 'express-underground-belt';
  splitterName: 'splitter' | 'fast-splitter' | 'express-splitter';
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
};

export interface MachineSpec {
  name: 'assembling-machine-1' | 'assembling-machine-2' | 'assembling-machine-3' | 'electric-furnace';
  size: number;
  craftingSpeed: number;
  moduleSlots: number;
  powerKw: number;
  drainKw: number;
}

export const MACHINE_SPECS: Record<MachineSpec['name'], MachineSpec> = {
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
};

export function assemblerNameForTier(tier: AssemblerTier): MachineSpec['name'] {
  if (tier === 1) return 'assembling-machine-1';
  if (tier === 2) return 'assembling-machine-2';
  return 'assembling-machine-3';
}

export interface InserterSpec {
  kind: AllInserterKind;
  name: 'inserter' | 'long-handed-inserter' | 'fast-inserter' | 'bulk-inserter';
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
};

export const INSERTER_BY_ENTITY_NAME: Record<string, InserterSpec> = {
  inserter: INSERTER_SPECS.yellow,
  'long-handed-inserter': INSERTER_SPECS.long,
  'fast-inserter': INSERTER_SPECS.fast,
  'bulk-inserter': INSERTER_SPECS.bulk,
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
  return null;
}

export function isBeltLikeName(name: string): boolean {
  return beltTierFromEntityName(name) !== null;
}

export function isUndergroundName(name: string): boolean {
  return (
    name === 'underground-belt' ||
    name === 'fast-underground-belt' ||
    name === 'express-underground-belt'
  );
}

export function isSplitterName(name: string): boolean {
  return name === 'splitter' || name === 'fast-splitter' || name === 'express-splitter';
}

export function isMachineName(name: string): boolean {
  return name in MACHINE_SPECS;
}

export function requiresPower(name: string): boolean {
  return isMachineName(name) || name in INSERTER_BY_ENTITY_NAME;
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
