import { describe, expect, it } from 'vitest';
import {
  Dir,
  EntityInstance,
  FACTORIO_2_0_VERSION,
  decodeBlueprintWrapper,
  encodeBlueprintWrapper,
  entitiesToBlueprintString,
  entitiesToFactorio2BlueprintData,
  importBalancerBook,
  inserterDirectionFromPickupDir,
  inserterReachTiles,
} from '../src/index.js';

describe('Factorio 2.0 Blueprint Codec', () => {
  it('encodes and decodes entities with exact Factorio 2.0 positions, modules, and markers', () => {
    const entities: EntityInstance[] = [
      {
        id: 'm1',
        name: 'assembling-machine-2',
        tx: 4,
        ty: 4,
        w: 3,
        h: 3,
        direction: Dir.NORTH,
        recipe: 'electronic-circuit',
        items: ['productivity-module-2', 'speed-module-2'],
        role: 'machine',
      },
      {
        id: 'sp1',
        name: 'fast-splitter',
        tx: 0,
        ty: 2,
        w: 1,
        h: 2,
        direction: Dir.EAST,
        role: 'splitter-macro',
      },
      {
        id: 'ins1',
        name: 'fast-inserter',
        tx: 4,
        ty: 3,
        w: 1,
        h: 1,
        direction: inserterDirectionFromPickupDir(Dir.NORTH),
        role: 'inserter-in',
      },
      {
        id: 'dp1',
        name: 'display-panel',
        tx: -1,
        ty: 2,
        w: 1,
        h: 1,
        direction: Dir.NORTH,
        role: 'port-marker',
        markerText: 'IN: iron-plate',
        markerIcon: 'iron-plate',
      },
    ];

    const bpData = entitiesToFactorio2BlueprintData(entities, {
      label: 'Test 2.0 BP',
      icons: ['electronic-circuit'],
      portMarkers: 'display-panel',
    });

    expect(bpData.version).toBe(FACTORIO_2_0_VERSION);
    expect(bpData.entities).toHaveLength(4);

    // 3x3 assembler at (4,4) -> center (5.5, 5.5)
    const asm = bpData.entities[0];
    expect(asm.position).toEqual({ x: 5.5, y: 5.5 });
    expect(asm.items).toEqual([
      {
        id: { name: 'productivity-module-2' },
        items: { in_inventory: [{ inventory: 4, stack: 0, count: 1 }] },
      },
      {
        id: { name: 'speed-module-2' },
        items: { in_inventory: [{ inventory: 4, stack: 1, count: 1 }] },
      },
    ]);

    // 1x2 East splitter at (0,2) -> center (0.5, 3.0), direction 4
    const sp = bpData.entities[1];
    expect(sp.position).toEqual({ x: 0.5, y: 3.0 });
    expect(sp.direction).toBe(Dir.EAST);

    // Display panel schema
    const dp = bpData.entities[3];
    expect(dp.text).toBe('IN: iron-plate');
    expect(dp.always_show).toBe(true);
    expect(dp.icon).toEqual({ type: 'item', name: 'iron-plate' });

    // Round-trip encoded string
    const str = entitiesToBlueprintString(entities, {
      label: 'Test 2.0 BP',
      portMarkers: 'display-panel',
    });
    expect(str.startsWith('0eN')).toBe(true);
    const decoded = decodeBlueprintWrapper(str);
    expect(decoded.blueprint?.entities).toHaveLength(4);
  });

  it('supports Factorio 2.0 uncompressed JSON import and verifies inserter pickup/drop', () => {
    const rawJson = JSON.stringify({
      blueprint: { item: 'blueprint', version: FACTORIO_2_0_VERSION, entities: [] },
    });
    const decoded = decodeBlueprintWrapper(rawJson);
    expect(decoded.blueprint?.version).toBe(FACTORIO_2_0_VERSION);

    const reachN = inserterReachTiles(5, 3, Dir.NORTH, 1);
    expect(reachN).toEqual({ pickupX: 5, pickupY: 2, dropX: 5, dropY: 4 });
    const reachS = inserterReachTiles(5, 7, Dir.SOUTH, 2);
    expect(reachS).toEqual({ pickupX: 5, pickupY: 9, dropX: 5, dropY: 5 });
  });

  it('imports Factorio 1.1 balancer book and doubles 8-way directions to 16-way 2.0', () => {
    // Minimal Factorio 1.1 1x2 East-facing splitter blueprint (dir=2 in 1.1 -> dir=4 in 2.0)
    const v11Book = encodeBlueprintWrapper({
      blueprint_book: {
        item: 'blueprint-book',
        label: 'Balancers 1.1',
        blueprints: [
          {
            index: 0,
            blueprint: {
              item: 'blueprint',
              label: '1x2 Yellow',
              version: 281479275675648, // 1.1 version < 2.0 min
              entities: [
                { entity_number: 1, name: 'transport-belt', position: { x: 0.5, y: 0.5 }, direction: 2 },
                { entity_number: 2, name: 'splitter', position: { x: 1.5, y: 1.0 }, direction: 2 },
                { entity_number: 3, name: 'transport-belt', position: { x: 2.5, y: 0.5 }, direction: 2 },
                { entity_number: 4, name: 'transport-belt', position: { x: 2.5, y: 1.5 }, direction: 2 },
              ],
            },
          },
        ],
      },
    });

    const res = importBalancerBook(v11Book);
    expect(res.balancers).toHaveLength(1);
    const b = res.balancers[0];
    expect(b.inputs).toBe(1);
    expect(b.outputs).toBe(2);
    expect(b.entities.every((e) => e.direction === Dir.EAST)).toBe(true);
  });
});
