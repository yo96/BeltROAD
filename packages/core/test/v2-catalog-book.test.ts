import { afterEach, describe, expect, it } from 'vitest';
import {
  BUILTIN_PRESETS,
  DesignSpec,
  Dir,
  EntityInstance,
  FACTORIO_2_0_VERSION,
  createBlueprintBookData,
  createBlueprintBookFromStrings,
  createBlueprintBookString,
  decodeBlueprintWrapper,
  defaultOptimizationConfig,
  defaultPdkConfig,
  entitiesToBlueprintString,
  entitiesToFactorio2BlueprintData,
  getCatalog,
  getDefaultCatalogRaw,
  loadCustomCatalog,
  pipelineResultToBlueprintBookString,
  resetDefaultCatalog,
  runFullPipeline,
} from '../src/index.js';

describe('v2.1 Blueprint Books & Custom Recipe Catalogs', () => {
  afterEach(() => {
    resetDefaultCatalog();
  });

  it('encodes and round-trips multi-entry Factorio 2.0 blueprint books', () => {
    const entA: EntityInstance[] = [
      {
        id: 'm1',
        name: 'assembling-machine-2',
        tx: 2,
        ty: 2,
        w: 3,
        h: 3,
        direction: Dir.NORTH,
        recipe: 'iron-gear-wheel',
        role: 'machine',
      },
    ];
    const entB: EntityInstance[] = [
      {
        id: 'b1',
        name: 'fast-transport-belt',
        tx: 0,
        ty: 0,
        w: 1,
        h: 1,
        direction: Dir.EAST,
        role: 'belt-route',
      },
      {
        id: 'b2',
        name: 'fast-transport-belt',
        tx: 1,
        ty: 0,
        w: 1,
        h: 1,
        direction: Dir.EAST,
        role: 'belt-route',
      },
    ];

    const bpA = entitiesToFactorio2BlueprintData(entA, {
      label: 'Assembler Unit',
      portMarkers: 'none',
    });
    const bpB = entitiesToFactorio2BlueprintData(entB, {
      label: 'Belt Bus',
      portMarkers: 'none',
    });

    const bookData = createBlueprintBookData([bpA, bpB], {
      label: 'Test EDA Book',
      description: 'Two entries',
      activeIndex: 1,
      icons: ['iron-gear-wheel', 'fast-transport-belt'],
    });
    expect(bookData.item).toBe('blueprint-book');
    expect(bookData.version).toBe(FACTORIO_2_0_VERSION);
    expect(bookData.active_index).toBe(1);
    expect(bookData.blueprints.map((b) => b.index)).toEqual([0, 1]);

    const bookStr = createBlueprintBookString([bpA, bpB], {
      label: 'Test EDA Book',
    });
    expect(bookStr.startsWith('0eN')).toBe(true);

    const decoded = decodeBlueprintWrapper(bookStr);
    expect(decoded.blueprint_book?.item).toBe('blueprint-book');
    expect(decoded.blueprint_book?.blueprints).toHaveLength(2);
    expect(decoded.blueprint_book?.blueprints[0].blueprint?.entities).toHaveLength(1);
    expect(decoded.blueprint_book?.blueprints[1].blueprint?.entities).toHaveLength(2);

    const strA = entitiesToBlueprintString(entA, { label: 'A', portMarkers: 'none' });
    const strB = entitiesToBlueprintString(entB, { label: 'B', portMarkers: 'none' });
    const fromStrings = createBlueprintBookFromStrings([strA, strB], {
      label: 'From Strings',
    });
    const decodedFromStrings = decodeBlueprintWrapper(fromStrings);
    expect(decodedFromStrings.blueprint_book?.blueprints).toHaveLength(2);
    expect(decodedFromStrings.blueprint_book?.label).toBe('From Strings');
  });

  it('packages flat and tiled PipelineResults into Factorio 2.0 blueprint books', () => {
    const flatSpec = structuredClone(BUILTIN_PRESETS[1].spec);
    flatSpec.pdk.portMarkers = 'display-panel';
    const flatRes = runFullPipeline(flatSpec);
    expect(flatRes.drc.passed).toBe(true);
    expect(flatRes.sta.passed).toBe(true);

    const flatBook = pipelineResultToBlueprintBookString(flatRes);
    expect(flatBook.labels.length).toBeGreaterThanOrEqual(2);
    expect(flatBook.labels[0]).toContain('(Full)');
    expect(flatBook.labels.some((l) => l.includes('No Markers'))).toBe(true);

    const decodedFlat = decodeBlueprintWrapper(flatBook.bookString);
    const flatEntries = decodedFlat.blueprint_book?.blueprints ?? [];
    expect(flatEntries).toHaveLength(flatBook.labels.length);
    const fullEnts = flatEntries[0].blueprint?.entities ?? [];
    const cleanEnts = flatEntries[flatEntries.length - 1].blueprint?.entities ?? [];
    expect(fullEnts.some((e) => e.name === 'display-panel')).toBe(true);
    expect(cleanEnts.some((e) => e.name === 'display-panel')).toBe(false);

    // Tiled preset (600/min Red + Green Science) -> includes Full, 1x Tile, and No Markers
    const tiledSpec = structuredClone(BUILTIN_PRESETS[1].spec);
    tiledSpec.targets = tiledSpec.targets.map((t) => ({ ...t, ratePerMin: 600 }));
    tiledSpec.pdk.defaultBeltTier = 'blue';
    tiledSpec.pdk.defaultAssemblerTier = 3;
    tiledSpec.pdk.defaultInserterTier = 'bulk';
    tiledSpec.pdk.portMarkers = 'display-panel';
    const tiledRes = runFullPipeline(tiledSpec);
    expect(tiledRes.tiling?.tileCount).toBeGreaterThan(1);
    const tiledBook = pipelineResultToBlueprintBookString(tiledRes);
    expect(tiledBook.labels).toHaveLength(3);
    expect(tiledBook.labels[1]).toContain('1x Tile');
    const decodedTiled = decodeBlueprintWrapper(tiledBook.bookString);
    expect(decodedTiled.blueprint_book?.blueprints).toHaveLength(3);
  });

  it('validates custom JSON recipe catalogs and compiles custom modded recipes cleanly', () => {
    const defaultCount = Object.keys(getCatalog().recipesById).length;
    expect(() => loadCustomCatalog(null)).toThrow(/JSON object/i);
    expect(() => loadCustomCatalog({ items: {}, recipes: [] })).toThrow(/empty/i);
    expect(() =>
      loadCustomCatalog({
        version: 'bad',
        items: { 'iron-plate': { id: 'iron-plate', name: 'Iron Plate' } },
        recipes: [{ id: 'bad-r', name: 'Bad', energyRequired: -1, outputItem: 'x', ingredients: [] }],
      }),
    ).toThrow(/energyRequired/i);

    // Invalid loads must not corrupt the active default catalog
    expect(Object.keys(getCatalog().recipesById)).toHaveLength(defaultCount);

    const customRaw = getDefaultCatalogRaw();
    customRaw.version = 'custom-krastorio-test';
    customRaw.items['krastorio-core'] = {
      id: 'krastorio-core',
      name: 'Krastorio Core',
      color: '#a855f7',
      category: 'intermediate',
      stackSize: 50,
    };
    customRaw.recipes.push({
      id: 'krastorio-core',
      name: 'Krastorio Core',
      category: 'crafting',
      energyRequired: 2.0,
      ingredients: [
        { item: 'iron-plate', amount: 2 },
        { item: 'copper-plate', amount: 2 },
      ],
      outputItem: 'krastorio-core',
      outputCount: 1,
      allowProductivity: true,
      hasFluid: false,
    });

    const loaded = loadCustomCatalog(customRaw);
    expect(loaded.recipesById['krastorio-core']).toBeDefined();

    const moddedSpec: DesignSpec = {
      version: 1,
      name: 'Modded Krastorio Core',
      pdk: defaultPdkConfig(),
      targets: [{ item: 'krastorio-core', ratePerMin: 60 }],
      inputPreset: 'plates',
      inputOverrides: {},
      floorplan: { mode: 'auto', aspectRatio: 1.35, margin: 3, halo: 2 },
      pins: [],
      macroOverrides: {},
      optimization: defaultOptimizationConfig('compact'),
    };

    const res = runFullPipeline(moddedSpec);
    expect(res.drc.passed).toBe(true);
    expect(res.drc.errorCount).toBe(0);
    expect(res.sta.passed).toBe(true);
    expect(res.bom.totalMachines).toBeGreaterThanOrEqual(2);
    expect(res.blueprintString.startsWith('0eN')).toBe(true);
  });
});
