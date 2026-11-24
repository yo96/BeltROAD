import yaml from 'js-yaml';
import {
  BeaconMode,
  BeaconModuleName,
  BeltStackSize,
  DesignSpec,
  OptimizationConfig,
  OptimizationLevel,
  PdkConfig,
  PinConstraint,
  QualityTier,
  TargetSpec,
} from '../types.js';
import { QUALITY_SPECS } from '../data/entities.js';
import { getCatalog } from '../data/catalog.js';

export function defaultOptimizationConfig(level: OptimizationLevel = 'compact'): OptimizationConfig {
  if (level === 'fast') {
    return {
      level: 'fast',
      compactMacros: true,
      alignPins: true,
      compactFloorplan: false,
      optimizeRoutes: false,
      layeredFloorplan: true,
      busTaps: false,
      portSwap: true,
      allowFlipY: true,
      tiling: 'auto',
      tileLayout: 'auto',
      directInsertion: false,
    };
  }
  if (level === 'balanced') {
    return {
      level: 'balanced',
      compactMacros: true,
      alignPins: true,
      compactFloorplan: true,
      optimizeRoutes: false,
      layeredFloorplan: true,
      busTaps: true,
      portSwap: true,
      allowFlipY: true,
      tiling: 'auto',
      tileLayout: 'auto',
      directInsertion: false,
    };
  }
  return {
    level: 'compact',
    compactMacros: true,
    alignPins: true,
    compactFloorplan: true,
    optimizeRoutes: true,
    layeredFloorplan: true,
    busTaps: true,
    portSwap: true,
    allowFlipY: true,
    tiling: 'auto',
    tileLayout: 'auto',
    directInsertion: false,
  };
}

export function defaultPdkConfig(): PdkConfig {
  return {
    defaultBeltTier: 'red',
    allowedBeltTiers: ['yellow', 'red', 'blue'],
    downsizeLowRateBelts: false,
    beltStackSize: 1,
    defaultAssemblerTier: 2,
    allowedAssemblerTiers: [1, 2, 3],
    defaultInserterTier: 'fast',
    allowedInserterTiers: ['yellow', 'long', 'fast', 'bulk'],
    defaultPoleTier: 'medium',
    machineQuality: 'normal',
    spaceAgeBuildings: false,
    beaconMode: 'none',
    beaconModules: ['speed-module-3', 'speed-module-3'],
    modules: {
      global: [],
      byRecipe: {},
    },
    allowBeltWeaving: false,
    portMarkers: 'display-panel',
    enableFluids: false,
  };
}

const VALID_BEACON_MODULES = new Set<BeaconModuleName>([
  'speed-module',
  'speed-module-2',
  'speed-module-3',
  'efficiency-module',
  'efficiency-module-2',
  'efficiency-module-3',
]);

export function normalizeSpec(raw: Partial<DesignSpec>): DesignSpec {
  const defPdk = defaultPdkConfig();
  const rawPdk = raw.pdk ?? ({} as Partial<PdkConfig>);

  const rawStack = rawPdk.beltStackSize;
  const beltStackSize: BeltStackSize = rawStack === 2 || rawStack === 4 ? rawStack : 1;
  const rawQuality = rawPdk.machineQuality;
  const machineQuality: QualityTier =
    rawQuality && rawQuality in QUALITY_SPECS ? rawQuality : 'normal';
  const rawBeaconMode = rawPdk.beaconMode;
  const beaconMode: BeaconMode =
    rawBeaconMode === 'row-4' || rawBeaconMode === 'row-8' ? rawBeaconMode : 'none';
  const rawBeaconMods = Array.isArray(rawPdk.beaconModules)
    ? rawPdk.beaconModules.filter((m): m is BeaconModuleName => VALID_BEACON_MODULES.has(m))
    : undefined;
  const beaconModules: BeaconModuleName[] =
    rawBeaconMods && rawBeaconMods.length > 0
      ? rawBeaconMods.slice(0, 2)
      : [...(defPdk.beaconModules ?? ['speed-module-3', 'speed-module-3'])];

  const pdk: PdkConfig = {
    defaultBeltTier: rawPdk.defaultBeltTier ?? defPdk.defaultBeltTier,
    allowedBeltTiers:
      rawPdk.allowedBeltTiers && rawPdk.allowedBeltTiers.length > 0
        ? [...rawPdk.allowedBeltTiers]
        : [...defPdk.allowedBeltTiers],
    downsizeLowRateBelts: rawPdk.downsizeLowRateBelts ?? defPdk.downsizeLowRateBelts,
    beltStackSize,
    defaultAssemblerTier: rawPdk.defaultAssemblerTier ?? defPdk.defaultAssemblerTier,
    allowedAssemblerTiers:
      rawPdk.allowedAssemblerTiers && rawPdk.allowedAssemblerTiers.length > 0
        ? [...rawPdk.allowedAssemblerTiers]
        : [...defPdk.allowedAssemblerTiers],
    defaultInserterTier: rawPdk.defaultInserterTier ?? defPdk.defaultInserterTier,
    allowedInserterTiers:
      rawPdk.allowedInserterTiers && rawPdk.allowedInserterTiers.length > 0
        ? [...rawPdk.allowedInserterTiers]
        : [...defPdk.allowedInserterTiers],
    defaultPoleTier: rawPdk.defaultPoleTier ?? defPdk.defaultPoleTier,
    machineQuality,
    spaceAgeBuildings: Boolean(rawPdk.spaceAgeBuildings),
    beaconMode,
    beaconModules,
    modules: {
      global: rawPdk.modules?.global ?? [],
      byRecipe: rawPdk.modules?.byRecipe ?? {},
    },
    allowBeltWeaving: false,
    portMarkers: rawPdk.portMarkers ?? defPdk.portMarkers,
    enableFluids: Boolean(rawPdk.enableFluids),
  };

  if (!pdk.allowedBeltTiers.includes(pdk.defaultBeltTier)) {
    pdk.allowedBeltTiers = [pdk.defaultBeltTier, ...pdk.allowedBeltTiers];
  }
  if (!pdk.allowedInserterTiers.includes(pdk.defaultInserterTier)) {
    pdk.allowedInserterTiers = [...pdk.allowedInserterTiers, pdk.defaultInserterTier];
  }
  if (beltStackSize > 1 && !pdk.allowedInserterTiers.includes('stack')) {
    pdk.allowedInserterTiers = [...pdk.allowedInserterTiers, 'stack'];
  }

  const rawFloor = raw.floorplan ?? ({} as DesignSpec['floorplan']);
  const floorplan: DesignSpec['floorplan'] = {
    mode: rawFloor.mode ?? 'auto',
    width: rawFloor.width,
    height: rawFloor.height,
    aspectRatio: rawFloor.aspectRatio ?? 1.35,
    margin: rawFloor.margin ?? 3,
    halo: rawFloor.halo ?? 2,
    requireEdgePins: rawFloor.requireEdgePins ?? true,
    headerMode:
      rawFloor.headerMode === 'bus-header' || rawFloor.headerMode === 'train-station'
        ? rawFloor.headerMode
        : 'none',
  };

  const optDef = defaultOptimizationConfig(raw.optimization?.level ?? 'compact');
  const rawTiling = raw.optimization?.tiling;
  let tiling: OptimizationConfig['tiling'] = optDef.tiling;
  if (rawTiling === 'auto' || rawTiling === 'off') {
    tiling = rawTiling;
  } else if (typeof rawTiling === 'number' && Number.isFinite(rawTiling) && rawTiling >= 2) {
    tiling = Math.round(rawTiling);
  }
  const rawTileLayout = raw.optimization?.tileLayout;
  const tileLayout: OptimizationConfig['tileLayout'] =
    rawTileLayout === 'stack' || rawTileLayout === 'twin' || rawTileLayout === 'auto'
      ? rawTileLayout
      : optDef.tileLayout;

  const optimization: OptimizationConfig = {
    level: raw.optimization?.level ?? optDef.level,
    compactMacros: raw.optimization?.compactMacros ?? optDef.compactMacros,
    alignPins: raw.optimization?.alignPins ?? optDef.alignPins,
    compactFloorplan: raw.optimization?.compactFloorplan ?? optDef.compactFloorplan,
    optimizeRoutes: raw.optimization?.optimizeRoutes ?? optDef.optimizeRoutes,
    layeredFloorplan: raw.optimization?.layeredFloorplan ?? optDef.layeredFloorplan,
    busTaps: raw.optimization?.busTaps ?? optDef.busTaps,
    portSwap: raw.optimization?.portSwap ?? optDef.portSwap,
    allowFlipY: raw.optimization?.allowFlipY ?? optDef.allowFlipY,
    tiling,
    tileLayout,
    directInsertion: raw.optimization?.directInsertion ?? optDef.directInsertion ?? false,
  };

  const targets: TargetSpec[] = (raw.targets ?? []).map((t) => {
    const hasMachines =
      typeof t.machines === 'number' && Number.isFinite(t.machines) && t.machines > 0;
    return {
      item: String(t.item),
      ratePerMin: Number(t.ratePerMin ?? 0),
      ...(hasMachines ? { machines: Math.max(1, Math.round(t.machines!)) } : {}),
    };
  });

  const pins: PinConstraint[] = (raw.pins ?? []).map((p) => ({ ...p }));

  return {
    version: raw.version ?? 1,
    name: raw.name?.trim() || 'Factorio EDA Design',
    pdk,
    targets,
    inputPreset: raw.inputPreset ?? 'plates',
    inputOverrides: { ...(raw.inputOverrides ?? {}) },
    floorplan,
    pins,
    macroOverrides: { ...(raw.macroOverrides ?? {}) },
    customBalancers: raw.customBalancers ? [...raw.customBalancers] : undefined,
    optimization,
  };
}

export function validateSpec(spec: DesignSpec): string[] {
  const errors: string[] = [];
  const catalog = getCatalog();

  if (!spec.targets || spec.targets.length === 0) {
    errors.push('Spec must include at least one target in "targets".');
  } else {
    for (const t of spec.targets) {
      if (!t.item) {
        errors.push('Every target must specify an "item".');
      } else if (!catalog.items[t.item] && !catalog.recipesByOutput[t.item]) {
        errors.push(`Unknown target item "${t.item}".`);
      }
      const hasRate = Number.isFinite(t.ratePerMin) && t.ratePerMin > 0;
      const hasMachines =
        typeof t.machines === 'number' && Number.isFinite(t.machines) && t.machines > 0;
      if (!hasRate && !hasMachines) {
        errors.push(`Target "${t.item}" ratePerMin (or machines) must be > 0.`);
      }
    }
  }

  if (spec.floorplan.mode === 'fixed') {
    if (!spec.floorplan.width || spec.floorplan.width < 16) {
      errors.push('Fixed floorplan requires "width" >= 16.');
    }
    if (!spec.floorplan.height || spec.floorplan.height < 16) {
      errors.push('Fixed floorplan requires "height" >= 16.');
    }
  }

  for (const pin of spec.pins) {
    if (!pin.id && !pin.bus) {
      errors.push('Each pin constraint must specify "id" or "bus".');
    }
    if (pin.edge && !['N', 'S', 'E', 'W'].includes(pin.edge)) {
      errors.push(`Invalid pin edge "${pin.edge}" (expected N, S, E, or W).`);
    }
  }

  return errors;
}

export function parseSpecYaml(yamlText: string): DesignSpec {
  const parsed = yaml.load(yamlText);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('YAML spec must be a mapping object.');
  }
  const spec = normalizeSpec(parsed as Partial<DesignSpec>);
  const errors = validateSpec(spec);
  if (errors.length > 0) {
    throw new Error(errors.join(' '));
  }
  return spec;
}

export function serializeSpecYaml(spec: DesignSpec): string {
  // Strip undefined / empty optional fields for clean readable YAML
  const clean: Record<string, unknown> = {
    version: spec.version,
    name: spec.name,
    pdk: spec.pdk,
    targets: spec.targets,
    inputPreset: spec.inputPreset,
  };
  if (Object.keys(spec.inputOverrides).length > 0) {
    clean.inputOverrides = spec.inputOverrides;
  }
  clean.floorplan = spec.floorplan;
  if (spec.pins.length > 0) {
    clean.pins = spec.pins;
  }
  if (Object.keys(spec.macroOverrides).length > 0) {
    clean.macroOverrides = spec.macroOverrides;
  }
  if (spec.customBalancers && spec.customBalancers.length > 0) {
    clean.customBalancers = spec.customBalancers;
  }
  if (spec.optimization) {
    clean.optimization = spec.optimization;
  }
  return yaml.dump(clean, {
    noRefs: true,
    lineWidth: 100,
    sortKeys: false,
  });
}
