import { describe, expect, it } from 'vitest';
import {
  BUILTIN_PRESETS,
  BalancerMacroSpec,
  DesignSpec,
  Dir,
  EntityInstance,
  PoleTier,
  RecipeMacroSpec,
  Rot90,
  SynthesisResult,
  compileRecipeMacroVariants,
  defaultOptimizationConfig,
  defaultPdkConfig,
  inserterDropLane,
  inserterPickupNearLane,
  mirrorMacroY,
  rotateMacro,
  runDrc,
  runFullPipeline,
  runSta,
  sideLoadTargetLane,
  simulateMacroOutputLanes,
} from '../src/index.js';

function makeMacroSpec(
  recipeId: string,
  outputItem: string,
  machineCount: number,
  outputRatePerSec: number,
  beltTier: 'yellow' | 'red' | 'blue',
  ingredients: { item: string; ratePerSec: number }[],
  opts?: { preferredRows?: number; balanceOutputLanes?: boolean },
): RecipeMacroSpec {
  return {
    id: `macro:${recipeId}`,
    kind: 'recipe-macro',
    recipeId,
    outputItem,
    machineName: 'assembling-machine-2',
    machineCount,
    exactMachines: machineCount,
    modules: [],
    effectiveSpeed: 0.75,
    effectiveProd: 1,
    outputRatePerSec,
    beltTier,
    ingredientRates: ingredients.map((ing) => ({ ...ing, beltTier })),
    preferredRows: opts?.preferredRows,
    balanceOutputLanes: opts?.balanceOutputLanes,
    sliceIndex: 0,
    sliceCount: 1,
  };
}

describe('Factorio Far-Lane Inserter Physics & Per-Lane STA', () => {
  it('computes far-lane inserter drop and near-side side-load rules accurately across directions', () => {
    // Perpendicular inserter drop: ins.direction points toward pickup, so drops along oppositeDir(insDir)
    expect(inserterDropLane(Dir.NORTH, Dir.EAST)).toBe('right'); // drops South onto East belt -> South (right) lane
    expect(inserterDropLane(Dir.SOUTH, Dir.EAST)).toBe('left'); // drops North onto East belt -> North (left) lane
    expect(inserterDropLane(Dir.EAST, Dir.SOUTH)).toBe('right'); // drops West onto South belt -> West (right) lane
    expect(inserterDropLane(Dir.WEST, Dir.NORTH)).toBe('right'); // drops East onto North belt -> East (right) lane
    // Parallel drop
    expect(inserterDropLane(Dir.WEST, Dir.EAST)).toBe('right');
    expect(inserterDropLane(Dir.EAST, Dir.EAST)).toBe('right');

    // Side-loading perpendicular belt merges both lanes onto nearest edge of destination belt
    expect(sideLoadTargetLane(Dir.SOUTH, Dir.EAST)).toBe('left'); // from North onto East -> left (North) lane
    expect(sideLoadTargetLane(Dir.NORTH, Dir.EAST)).toBe('right'); // from South onto East -> right (South) lane
    expect(sideLoadTargetLane(Dir.WEST, Dir.SOUTH)).toBe('left'); // from East onto South -> left (East) lane
    expect(sideLoadTargetLane(Dir.EAST, Dir.NORTH)).toBe('left'); // from West onto North -> left (West) lane
  });

  it('builds DRC-clean 1-row high-rate macro with mid-row lane flip achieving 50/50 compression across poles, flipY, and rotations', () => {
    const spec = makeMacroSpec(
      'electronic-circuit',
      'electronic-circuit',
      20,
      30,
      'red',
      [
        { item: 'iron-plate', ratePerSec: 30 },
        { item: 'copper-cable', ratePerSec: 90 },
      ],
      { preferredRows: 1, balanceOutputLanes: true },
    );

    for (const poleTier of ['small', 'medium', 'substation'] as PoleTier[]) {
      const pdk = { ...defaultPdkConfig(), defaultPoleTier: poleTier };
      const variants = compileRecipeMacroVariants(spec, pdk);
      const single = variants.find((v) => v.rows === 1)!;
      expect(single).toBeDefined();
      expect(single.entities.some((e) => e.intentionalSideLoad && e.item === 'electronic-circuit')).toBe(true);

      for (const base of [single, mirrorMacroY(single)]) {
        for (const rot of [0, 1, 2, 3] as Rot90[]) {
          const rotated = rotateMacro(base, rot);
          const drc = runDrc(rotated.entities, rotated.width, rotated.height);
          expect(
            drc.violations,
            `pole=${poleTier} flip=${Boolean(base.flippedY)} rot=${rot}`,
          ).toEqual([]);
          expect(drc.passed).toBe(true);

          const sim = simulateMacroOutputLanes(spec, rotated.entities);
          expect(sim.outLeft).toBeCloseTo(15, 2);
          expect(sim.outRight).toBeCloseTo(15, 2);
          expect(sim.peakLeft).toBeLessThanOrEqual(15.001);
          expect(sim.peakRight).toBeLessThanOrEqual(15.001);
        }
      }
    }
  });

  it('handles needsGap (>=3 inserters) mid-row lane flip across all pole tiers, flipY, and rotations', () => {
    // Bulk inserters at low speed or fast speed forcing >=3 inserters per side with small/medium/substation
    const spec = makeMacroSpec(
      'electronic-circuit',
      'electronic-circuit',
      4,
      14,
      'yellow',
      [
        { item: 'iron-plate', ratePerSec: 14 },
        { item: 'copper-cable', ratePerSec: 42 },
      ],
      { preferredRows: 1, balanceOutputLanes: true },
    );

    for (const poleTier of ['small', 'medium', 'substation'] as PoleTier[]) {
      const pdk = {
        ...defaultPdkConfig(),
        defaultBeltTier: 'yellow' as const,
        defaultPoleTier: poleTier,
        defaultInserterTier: 'yellow' as const,
        allowedInserterTiers: ['yellow' as const, 'long' as const],
      };
      const variants = compileRecipeMacroVariants(spec, pdk);
      const single = variants.find((v) => v.rows === 1)!;

      for (const base of [single, mirrorMacroY(single)]) {
        for (const rot of [0, 1, 2, 3] as Rot90[]) {
          const rotated = rotateMacro(base, rot);
          const drc = runDrc(rotated.entities, rotated.width, rotated.height);
          expect(
            drc.violations,
            `needsGap pole=${poleTier} flip=${Boolean(base.flippedY)} rot=${rot}`,
          ).toEqual([]);
          expect(drc.passed).toBe(true);

          const sim = simulateMacroOutputLanes(spec, rotated.entities);
          expect(sim.outLeft).toBeCloseTo(7, 2);
          expect(sim.outRight).toBeCloseTo(7, 2);
        }
      }
    }
  });

  it('builds balanced mirrored 2-row high-rate macro preserving 50/50 lane compression under flipY and rotations', () => {
    const spec = makeMacroSpec(
      'transport-belt',
      'transport-belt',
      14,
      30,
      'red',
      [
        { item: 'iron-plate', ratePerSec: 15 },
        { item: 'iron-gear-wheel', ratePerSec: 15 },
      ],
      { preferredRows: 2 },
    );

    const pdk = defaultPdkConfig();
    const variants = compileRecipeMacroVariants(spec, pdk);
    const twoRow = variants.find((v) => v.rows === 2)!;
    expect(twoRow).toBeDefined();

    for (const base of [twoRow, mirrorMacroY(twoRow)]) {
      for (const rot of [0, 1, 2, 3] as Rot90[]) {
        const rotated = rotateMacro(base, rot);
        const drc = runDrc(rotated.entities, rotated.width, rotated.height);
        expect(drc.passed).toBe(true);

        const sim = simulateMacroOutputLanes(spec, rotated.entities);
        expect(sim.outLeft).toBeCloseTo(15, 2);
        expect(sim.outRight).toBeCloseTo(15, 2);
      }
    }
  });

  it('balances M=1 macro outputs with 2-tile splitter tail cleanly across pole tiers, flipY, and rotations', () => {
    const cases = [
      makeMacroSpec(
        'iron-gear-wheel',
        'iron-gear-wheel',
        1,
        10,
        'yellow',
        [{ item: 'iron-plate', ratePerSec: 20 }],
        { balanceOutputLanes: true },
      ),
      makeMacroSpec(
        'oil-refinery',
        'oil-refinery',
        1,
        8,
        'yellow',
        [
          { item: 'steel-plate', ratePerSec: 0.5 },
          { item: 'iron-gear-wheel', ratePerSec: 0.3 },
          { item: 'stone-brick', ratePerSec: 0.3 },
          { item: 'electronic-circuit', ratePerSec: 0.3 },
          { item: 'pipe', ratePerSec: 0.3 },
        ],
        { balanceOutputLanes: true },
      ),
    ];

    for (const spec of cases) {
      for (const poleTier of ['small', 'medium', 'substation'] as PoleTier[]) {
        const pdk = { ...defaultPdkConfig(), defaultPoleTier: poleTier };
        const [single] = compileRecipeMacroVariants(spec, pdk);
        expect(single.entities.some((e) => e.id.includes(':tail:sp'))).toBe(true);

        for (const base of [single, mirrorMacroY(single)]) {
          for (const rot of [0, 1, 2, 3] as Rot90[]) {
            const rotated = rotateMacro(base, rot);
            const drc = runDrc(rotated.entities, rotated.width, rotated.height);
            expect(
              drc.violations,
              `${spec.recipeId} pole=${poleTier} flip=${Boolean(base.flippedY)} rot=${rot}`,
            ).toEqual([]);

            const sim = simulateMacroOutputLanes(spec, rotated.entities);
            expect(sim.outLeft).toBeCloseTo(spec.outputRatePerSec / 2, 2);
            expect(sim.outRight).toBeCloseTo(spec.outputRatePerSec / 2, 2);
          }
        }
      }
    }
  });

  it('bumps odd machine count near full belt capacity in synthesis so STA passes on both lanes', () => {
    const baseSpec: DesignSpec = {
      ...structuredClone(BUILTIN_PRESETS[0].spec),
      name: 'Odd Machine Near-Full Yellow Belt Test',
      pdk: {
        ...defaultPdkConfig(),
        defaultBeltTier: 'yellow',
        defaultAssemblerTier: 3, // Asm3 copper-cable = 5/s -> 12/s demands 2.4 -> 3 (odd!) -> bump to 4
        defaultInserterTier: 'bulk',
        allowedBeltTiers: ['yellow', 'red', 'blue'],
      },
      targets: [{ item: 'copper-cable', ratePerMin: 720 }],
      inputPreset: 'plates',
      inputOverrides: {},
      pins: [],
      macroOverrides: {},
      optimization: defaultOptimizationConfig('compact'),
    };

    const res = runFullPipeline(baseSpec);
    expect(res.drc.violations).toEqual([]);
    expect(res.drc.passed).toBe(true);
    expect(res.sta.passed).toBe(true);

    const cableMacro = res.synthesis.nodes.find(
      (n): n is RecipeMacroSpec => n.kind === 'recipe-macro' && n.outputItem === 'copper-cable',
    )!;
    expect(cableMacro.machineCount).toBe(4);
  });

  it('balances multiple merged macro slices feeding a shared output net above 0.5 belt', () => {
    // 1500/min = 25/s green circuits (> 15/s half red belt, > 16 Asm2 machines -> 2 slices merging via 2x1 balancer)
    const spec: DesignSpec = {
      ...structuredClone(BUILTIN_PRESETS[0].spec),
      name: 'Multi-Source Merge Green Circuits',
      pdk: {
        ...defaultPdkConfig(),
        defaultBeltTier: 'red',
        defaultAssemblerTier: 2,
        defaultInserterTier: 'bulk',
        allowedBeltTiers: ['yellow', 'red', 'blue'],
      },
      targets: [{ item: 'electronic-circuit', ratePerMin: 1500 }],
      inputPreset: 'bus',
      inputOverrides: { 'electronic-circuit': 'synthesize', 'copper-cable': 'input' },
      pins: [],
      macroOverrides: {},
      optimization: defaultOptimizationConfig('compact'),
    };

    const res = runFullPipeline(spec);
    expect(res.drc.violations).toEqual([]);
    expect(res.drc.passed).toBe(true);
    expect(res.sta.passed).toBe(true);

    const balNets = res.sta.nets.filter((n) => n.item === 'electronic-circuit');
    expect(balNets.length).toBeGreaterThanOrEqual(3);
    for (const net of balNets) {
      expect(net.laneUtilization ?? 0).toBeLessThanOrEqual(1.0001);
      expect(net.leftRatePerSec ?? 0).toBeLessThanOrEqual(15.01);
      expect(net.rightRatePerSec ?? 0).toBeLessThanOrEqual(15.01);
    }
  });

  it('fails STA when an unbalanced 1-row macro or merged single-lane net overflows half a belt', () => {
    const pdk = defaultPdkConfig();
    // Compile an unbalanced 1-row macro (outputRatePerSec = 10/s < 14.7 so no flip jog is built),
    // then evaluate STA pretending it outputs 20/s on a red belt (all 20/s piles on Right lane > 15/s half belt)
    const lowSpec = makeMacroSpec(
      'iron-gear-wheel',
      'iron-gear-wheel',
      14,
      10,
      'red',
      [{ item: 'iron-plate', ratePerSec: 20 }],
      { preferredRows: 1 },
    );
    const [unbalanced] = compileRecipeMacroVariants(lowSpec, pdk);

    const overflowMacro: RecipeMacroSpec = { ...lowSpec, outputRatePerSec: 20 };
    const synthSingle: SynthesisResult = {
      spec: structuredClone(BUILTIN_PRESETS[0].spec),
      nodes: [overflowMacro],
      nets: [
        {
          id: 'net:out',
          busId: 'iron-gear-wheel',
          busIndex: 0,
          item: 'iron-gear-wheel',
          ratePerSec: 20,
          beltTier: 'red',
          source: { nodeId: overflowMacro.id, pinId: 'out:iron-gear-wheel', kind: 'source', item: 'iron-gear-wheel' },
          sink: { nodeId: 'out:iron-gear-wheel:0', pinId: 'out:iron-gear-wheel:0', kind: 'sink', item: 'iron-gear-wheel' },
        },
      ],
      dag: [],
      bom: { entities: {}, modules: {}, estimatedPowerKw: 0, totalMachines: 14 },
      warnings: [],
    };
    const staSingle = runSta(synthSingle, unbalanced.entities, pdk);
    expect(staSingle.passed).toBe(false);
    expect(staSingle.macros[0].laneOk).toBe(false);
    expect(staSingle.nets[0].passed).toBe(false);
    expect(staSingle.nets[0].rightRatePerSec).toBeCloseTo(20, 2);

    // Negative test 2: Two unbalanced 12/s macros (total 24/s <= 30/s total red cap, > 15/s single-lane cap)
    // feeding a 2x1 merger into one red belt
    const m0 = { ...lowSpec, id: 'macro:gear:0', outputRatePerSec: 12, sliceIndex: 0, sliceCount: 2 };
    const m1 = { ...lowSpec, id: 'macro:gear:1', outputRatePerSec: 12, sliceIndex: 1, sliceCount: 2 };
    const e0: EntityInstance[] = compileRecipeMacroVariants(m0, pdk)[0].entities.map((e) => ({
      ...e,
      id: `0:${e.id}`,
      macroId: m0.id,
    }));
    const e1: EntityInstance[] = compileRecipeMacroVariants(m1, pdk)[0].entities.map((e) => ({
      ...e,
      id: `1:${e.id}`,
      macroId: m1.id,
    }));
    const bal: BalancerMacroSpec = {
      id: 'bal:iron-gear-wheel:2x1',
      kind: 'balancer-macro',
      item: 'iron-gear-wheel',
      inputs: 2,
      outputs: 1,
      beltTier: 'red',
      totalRatePerSec: 24,
      templateId: 'builtin-2x1',
    };

    const synthMerged: SynthesisResult = {
      spec: structuredClone(BUILTIN_PRESETS[0].spec),
      nodes: [m0, m1, bal],
      nets: [
        {
          id: 'net:in0',
          busId: 'g:in',
          busIndex: 0,
          item: 'iron-gear-wheel',
          ratePerSec: 12,
          beltTier: 'red',
          source: { nodeId: m0.id, pinId: 'out:iron-gear-wheel', kind: 'source', item: 'iron-gear-wheel' },
          sink: { nodeId: bal.id, pinId: 'in:0', kind: 'sink', item: 'iron-gear-wheel' },
        },
        {
          id: 'net:in1',
          busId: 'g:in',
          busIndex: 1,
          item: 'iron-gear-wheel',
          ratePerSec: 12,
          beltTier: 'red',
          source: { nodeId: m1.id, pinId: 'out:iron-gear-wheel', kind: 'source', item: 'iron-gear-wheel' },
          sink: { nodeId: bal.id, pinId: 'in:1', kind: 'sink', item: 'iron-gear-wheel' },
        },
        {
          id: 'net:merged',
          busId: 'g:out',
          busIndex: 0,
          item: 'iron-gear-wheel',
          ratePerSec: 24,
          beltTier: 'red',
          source: { nodeId: bal.id, pinId: 'out:0', kind: 'source', item: 'iron-gear-wheel' },
          sink: { nodeId: 'out:iron-gear-wheel:0', pinId: 'out:iron-gear-wheel:0', kind: 'sink', item: 'iron-gear-wheel' },
        },
      ],
      dag: [],
      bom: { entities: {}, modules: {}, estimatedPowerKw: 0, totalMachines: 28 },
      warnings: [],
    };
    const staMerged = runSta(synthMerged, [...e0, ...e1], pdk);
    expect(staMerged.passed).toBe(false);
    const mergedNet = staMerged.nets.find((n) => n.netId === 'net:merged')!;
    expect(mergedNet.passed).toBe(false);
    expect(mergedNet.rightRatePerSec).toBeCloseTo(24, 2);
  });

  it('computes near-lane-first inserter pickup lane accurately across perpendicular and parallel orientations', () => {
    // ins.direction points from inserter center toward pickup belt:
    // Inserter South of EAST belt has ins.direction = NORTH -> belt's South (right) lane is near
    expect(inserterPickupNearLane(Dir.NORTH, Dir.EAST)).toBe('right');
    // Inserter North of EAST belt has ins.direction = SOUTH -> belt's North (left) lane is near
    expect(inserterPickupNearLane(Dir.SOUTH, Dir.EAST)).toBe('left');
    // Inserter West of SOUTH belt has ins.direction = EAST -> belt's West (right) lane is near
    expect(inserterPickupNearLane(Dir.EAST, Dir.SOUTH)).toBe('right');
    // Inserter East of NORTH belt has ins.direction = WEST -> belt's East (right) lane is near
    expect(inserterPickupNearLane(Dir.WEST, Dir.NORTH)).toBe('right');
    // Parallel pickup defaults to left lane
    expect(inserterPickupNearLane(Dir.EAST, Dir.EAST)).toBe('left');
    expect(inserterPickupNearLane(Dir.WEST, Dir.EAST)).toBe('left');
  });

  it('populates per-tile entityLanes for macro outputs (including lane-flip transitions), inputs, and balancers on Green Circuits', () => {
    const res = runFullPipeline(structuredClone(BUILTIN_PRESETS[0].spec));
    expect(res.drc.passed).toBe(true);
    expect(res.sta.passed).toBe(true);
    expect(res.sta.entityLanes).toBeDefined();

    const entityLanes = res.sta.entityLanes!;
    // Routed belts should NOT be duplicated into entityLanes
    for (const e of res.allEntities) {
      if (e.netId) {
        expect(entityLanes[e.id]).toBeUndefined();
      }
    }

    // Balancer entities must be populated with non-zero L/R rates
    const balancerEnts = res.allEntities.filter((e) => e.role === 'balancer');
    expect(balancerEnts.length).toBeGreaterThan(0);
    for (const b of balancerEnts) {
      const info = entityLanes[b.id];
      expect(info, `balancer ${b.id}`).toBeDefined();
      expect(info.source).toBe('balancer');
      expect(info.leftRatePerSec + info.rightRatePerSec).toBeGreaterThan(0);
    }

    // Every macro transport tile should appear in entityLanes
    const macroTransport = res.allEntities.filter(
      (e) =>
        (e.role === 'belt-macro' || e.role === 'ug-macro' || e.role === 'splitter-macro') &&
        !e.netId,
    );
    expect(macroTransport.length).toBeGreaterThan(0);
    for (const e of macroTransport) {
      expect(entityLanes[e.id], `macro tile ${e.id}`).toBeDefined();
    }

    // Check output macro lane-flip: tiles exist both with single-lane accumulation and post-flip balance
    const ecOutputs = macroTransport.filter(
      (e) => entityLanes[e.id]?.source === 'macro-output' && entityLanes[e.id]?.leftItem === 'electronic-circuit',
    );
    expect(ecOutputs.length).toBeGreaterThan(0);
    expect(
      ecOutputs.some((e) => {
        const lr = entityLanes[e.id]!;
        return lr.leftRatePerSec > 0 && lr.rightRatePerSec === 0;
      }) ||
        ecOutputs.some((e) => {
          const lr = entityLanes[e.id]!;
          return lr.rightRatePerSec > 0 && lr.leftRatePerSec === 0;
        }),
    ).toBe(true);
    expect(
      ecOutputs.some((e) => {
        const lr = entityLanes[e.id]!;
        return lr.leftRatePerSec > 0.5 && lr.rightRatePerSec > 0.5;
      }),
    ).toBe(true);

    // Check near-lane-first drain on single-item iron-plate macro input belts
    const ironInputs = macroTransport.filter(
      (e) => entityLanes[e.id]?.source === 'macro-input' && entityLanes[e.id]?.leftItem === 'iron-plate',
    );
    expect(ironInputs.length).toBeGreaterThan(0);
    // Downstream of near-lane consumption (and before/after midpoint), at least some tiles should show unequal L vs R rates while mid-row drains
    expect(
      ironInputs.some((e) => {
        const lr = entityLanes[e.id]!;
        return lr.leftRatePerSec + lr.rightRatePerSec > 0.1 && Math.abs(lr.leftRatePerSec - lr.rightRatePerSec) > 0.05;
      }),
    ).toBe(true);
  });

  it('tracks dual-lane macro input belts and header UG bridges separately per lane on Military Science', () => {
    const milPreset = BUILTIN_PRESETS.find((p) => p.id === 'military-science')!;
    const res = runFullPipeline(structuredClone(milPreset.spec));
    expect(res.drc.passed).toBe(true);
    expect(res.sta.passed).toBe(true);
    const entityLanes = res.sta.entityLanes!;

    const dualLaneEnts = res.allEntities.filter(
      (e) => e.laneItems && e.laneItems.length === 2,
    );
    expect(dualLaneEnts.length).toBeGreaterThan(0);
    for (const e of dualLaneEnts) {
      const info = entityLanes[e.id];
      expect(info, `dual-lane ${e.id}`).toBeDefined();
      expect(info.source).toBe('macro-input');
      expect(info.leftItem).toBe(e.laneItems![0]);
      expect(info.rightItem).toBe(e.laneItems![1]);
      expect(info.leftItem).not.toBe(info.rightItem);
      expect(info.leftRatePerSec).toBeGreaterThanOrEqual(0);
      expect(info.rightRatePerSec).toBeGreaterThanOrEqual(0);
    }

    // Dual-lane merge header tiles must start with positive steady-state rates on BOTH lanes matching incoming nets
    const mergeHeaders = dualLaneEnts.filter((e) => e.intentionalSideLoad);
    expect(mergeHeaders.length).toBeGreaterThan(0);
    for (const hdr of mergeHeaders) {
      const info = entityLanes[hdr.id]!;
      expect(info.leftRatePerSec).toBeGreaterThan(0);
      expect(info.rightRatePerSec).toBeGreaterThan(0);
    }

    // Header ug-macro tiles inside dual-lane macros must inherit item identities & positive throughput
    const headerUgs = res.allEntities.filter((e) => e.role === 'ug-macro');
    expect(headerUgs.length).toBeGreaterThan(0);
    for (const ug of headerUgs) {
      const info = entityLanes[ug.id];
      expect(info, `header ug ${ug.id}`).toBeDefined();
      expect(info.leftItem || info.rightItem).toBeTruthy();
      expect(info.leftRatePerSec + info.rightRatePerSec).toBeGreaterThan(0);
    }
  });

  it('populates per-tile entityLanes on tiled megafactories without duplicating routed nets', () => {
    const spec: DesignSpec = {
      ...structuredClone(BUILTIN_PRESETS[0].spec),
      name: 'Speed Module 3 Telemetry Check',
      targets: [{ item: 'speed-module-3', ratePerMin: 60 }],
      pins: [],
      optimization: defaultOptimizationConfig('compact'),
    };
    const res = runFullPipeline(spec);
    expect(res.drc.passed).toBe(true);
    expect(res.sta.passed).toBe(true);
    expect(res.tiling).toBeDefined();

    const entityLanes = res.sta.entityLanes!;
    const routedCount = res.allEntities.filter((e) => e.netId !== undefined).length;
    expect(routedCount).toBeGreaterThan(100);
    expect(Object.keys(entityLanes).length).toBeLessThan(routedCount + res.allEntities.filter((e) => !e.netId).length);

    // Every tiler splitter has balancer telemetry
    const balEnts = res.allEntities.filter((e) => e.role === 'balancer');
    expect(balEnts.length).toBeGreaterThan(0);
    for (const b of balEnts) {
      expect(entityLanes[b.id]?.source).toBe('balancer');
      expect((entityLanes[b.id]?.leftRatePerSec ?? 0) + (entityLanes[b.id]?.rightRatePerSec ?? 0)).toBeGreaterThan(0);
    }
  });
});
