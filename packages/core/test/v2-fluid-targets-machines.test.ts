import { describe, expect, it } from 'vitest';
import {
  BUILTIN_PRESETS,
  Dir,
  PIPE_SPEC,
  compileRecipeMacroVariants,
  computeRecipeThroughputPerMachine,
  decodeBlueprintWrapper,
  defaultOptimizationConfig,
  defaultPdkConfig,
  isPipeName,
  isPipeUndergroundName,
  normalizeSpec,
  parseSpecYaml,
  runDrc,
  runFullPipeline,
  serializeSpecYaml,
} from '../src/index.js';
import type { DesignSpec, EntityInstance, RecipeMacroSpec } from '../src/index.js';
import { dirDelta } from '../src/geometry.js';

function baseSpec(
  name: string,
  targets: DesignSpec['targets'],
  pdkOverrides?: Partial<DesignSpec['pdk']>,
): DesignSpec {
  return {
    version: 1,
    name,
    pdk: {
      ...defaultPdkConfig(),
      enableFluids: true,
      ...pdkOverrides,
    },
    targets,
    inputPreset: 'plates',
    inputOverrides: {},
    floorplan: { mode: 'auto', aspectRatio: 1.35, margin: 3, halo: 2 },
    pins: [],
    macroOverrides: {},
    optimization: defaultOptimizationConfig('compact'),
  };
}

function assertStrictPipeSeparation(entities: EntityInstance[], context: string): void {
  const pipes = entities.filter((e) => isPipeName(e.name));
  const byTile = new Map<string, EntityInstance>();
  for (const p of pipes) {
    byTile.set(`${p.tx},${p.ty}`, p);
  }
  const hasPort = (ent: EntityInstance, dx: number, dy: number): boolean => {
    if (!isPipeUndergroundName(ent.name)) return true;
    const d = dirDelta(ent.direction);
    return d.dx === dx && d.dy === dy;
  };
  for (const a of pipes) {
    for (const [dx, dy] of [
      [1, 0],
      [0, 1],
    ] as const) {
      const b = byTile.get(`${a.tx + dx},${a.ty + dy}`);
      if (!b) continue;
      if (!hasPort(a, dx, dy) || !hasPort(b, -dx, -dy)) continue;

      if (a.item && b.item) {
        expect(a.item, `${context}: mixed fluid at (${a.tx},${a.ty})`).toBe(b.item);
      }
      if (a.netId && b.netId) {
        expect(
          a.netId,
          `${context}: adjacent distinct routed pipe nets ${a.netId} and ${b.netId} at (${a.tx},${a.ty})`,
        ).toBe(b.netId);
      }
      if (a.macroId && b.macroId) {
        expect(
          a.macroId,
          `${context}: adjacent distinct macro pipes ${a.macroId} and ${b.macroId}`,
        ).toBe(b.macroId);
      }
    }
  }
}

describe('Liquid Targets, Non-Adjacent Liquid Pipes & Machine-Count Targets', () => {
  it('synthesizes, routes, and passes DRC+STA for all 8 base & Space Age liquid targets', () => {
    const cases: Array<{
      item: string;
      ratePerMin: number;
      expectedMachine: string;
      spaceAge?: boolean;
    }> = [
      { item: 'sulfuric-acid', ratePerMin: 6000, expectedMachine: 'chemical-plant' },
      { item: 'sulfuric-acid', ratePerMin: 12000, expectedMachine: 'cryogenic-plant', spaceAge: true },
      { item: 'lubricant', ratePerMin: 2400, expectedMachine: 'chemical-plant' },
      { item: 'light-oil', ratePerMin: 3600, expectedMachine: 'chemical-plant' },
      { item: 'heavy-oil', ratePerMin: 1800, expectedMachine: 'oil-refinery' },
      { item: 'petroleum-gas', ratePerMin: 2400, expectedMachine: 'oil-refinery' },
      { item: 'water', ratePerMin: 4800, expectedMachine: 'chemical-plant' },
      { item: 'molten-iron', ratePerMin: 15000, expectedMachine: 'foundry', spaceAge: true },
      { item: 'molten-copper', ratePerMin: 15000, expectedMachine: 'foundry', spaceAge: true },
      { item: 'holmium-solution', ratePerMin: 6000, expectedMachine: 'cryogenic-plant', spaceAge: true },
      { item: 'holmium-solution', ratePerMin: 3000, expectedMachine: 'chemical-plant', spaceAge: false },
    ];

    for (const c of cases) {
      const spec = baseSpec(
        `Liquid: ${c.item}`,
        [{ item: c.item, ratePerMin: c.ratePerMin }],
        {
          spaceAgeBuildings: Boolean(c.spaceAge),
          defaultBeltTier: c.spaceAge ? 'turbo' : 'red',
        },
      );
      const out = runFullPipeline(spec);
      expect(out.drc.errorCount, `${c.item} DRC: ${JSON.stringify(out.drc.violations)}`).toBe(0);
      expect(out.sta.passed, `${c.item} STA: ${out.sta.bottlenecks.join('; ')}`).toBe(true);

      const outPins = out.floorplan.pins.filter((p) => p.kind === 'output' && !p.isByproduct);
      expect(outPins.length).toBeGreaterThanOrEqual(1);
      expect(outPins.every((p) => p.isFluid && p.item === c.item)).toBe(true);
      if (c.item === 'heavy-oil') {
        const bypPins = out.floorplan.pins.filter((p) => p.kind === 'output' && p.isByproduct);
        const bypItems = new Set(bypPins.map((p) => p.item));
        expect(bypItems.has('light-oil')).toBe(true);
        expect(bypItems.has('petroleum-gas')).toBe(true);
        expect(bypPins.every((p) => p.isFluid)).toBe(true);
      }

      const rms = out.synthesis.nodes.filter(
        (n): n is RecipeMacroSpec => n.kind === 'recipe-macro' && n.outputItem === c.item,
      );
      expect(rms.length).toBeGreaterThanOrEqual(1);
      expect(rms[0].machineName).toBe(c.expectedMachine);
      expect(rms[0].outputIsFluid).toBe(true);

      const decoded = decodeBlueprintWrapper(out.blueprintString);
      expect(decoded.blueprint?.icons?.[0]?.signal?.type).toBe('fluid');
      assertStrictPipeSeparation(out.allEntities, c.item);
    }
  });

  it('keeps existing Science presets treating upstream fluids as external input pins (no regression)', () => {
    for (const presetId of ['blue-science', 'yellow-science', 'vulcanus-metallurgic', 'fulgora-electromagnetic']) {
      const preset = BUILTIN_PRESETS.find((p) => p.id === presetId)!;
      const out = runFullPipeline(structuredClone(preset.spec));
      expect(out.drc.errorCount, `${presetId} DRC: ${JSON.stringify(out.drc.violations)}`).toBe(0);
      expect(out.sta.passed, `${presetId} STA: ${out.sta.bottlenecks.join('; ')}`).toBe(true);
      assertStrictPipeSeparation(out.allEntities, presetId);
    }
  });

  it('enforces non-adjacent liquid pipes in DRC and across parallel same-fluid routes', () => {
    // 1. Direct DRC check: two distinct routed nets of the SAME fluid placed orthogonally adjacent -> NO_ADJACENT_PIPES
    const adjSameFluid: EntityInstance[] = [
      { id: 'n1', name: 'pipe', tx: 3, ty: 3, w: 1, h: 1, direction: Dir.NORTH, netId: 'net:0', item: 'water', role: 'pipe-route' },
      { id: 'n2', name: 'pipe', tx: 3, ty: 4, w: 1, h: 1, direction: Dir.NORTH, netId: 'net:1', item: 'water', role: 'pipe-route' },
    ];
    const adjReport = runDrc(adjSameFluid, 10, 10);
    expect(adjReport.violations.some((v) => v.code === 'NO_ADJACENT_PIPES')).toBe(true);

    // 2. Multi-pipe same-fluid output (>= 2 output pipes of sulfuric-acid) + multi-fluid target
    const highRateFluid = baseSpec('Dual Output Pipe Sulfuric Acid', [
      { item: 'sulfuric-acid', ratePerMin: PIPE_SPEC.capacityPerSec * 60 * 2 * 0.75 },
    ]);
    const highOut = runFullPipeline(highRateFluid);
    expect(highOut.drc.errorCount, JSON.stringify(highOut.drc.violations)).toBe(0);
    expect(highOut.sta.passed, highOut.sta.bottlenecks.join('; ')).toBe(true);
    const outPins = highOut.floorplan.pins.filter((p) => p.kind === 'output' && p.isFluid);
    expect(outPins.length).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < outPins.length; i++) {
      for (let j = i + 1; j < outPins.length; j++) {
        if (outPins[i].edge === outPins[j].edge) {
          expect(Math.abs(outPins[i].offset - outPins[j].offset)).toBeGreaterThanOrEqual(2);
        }
      }
    }
    assertStrictPipeSeparation(highOut.allEntities, 'high-rate-sulfuric-acid');

    // 3. Multi-target liquid plant (Sulfuric Acid + Lubricant + Light Oil)
    const multiFluid = baseSpec('Multi-Liquid Plant', [
      { item: 'sulfuric-acid', ratePerMin: 3000 },
      { item: 'lubricant', ratePerMin: 1800 },
      { item: 'light-oil', ratePerMin: 1800 },
    ]);
    const multiOut = runFullPipeline(multiFluid);
    expect(multiOut.drc.errorCount, JSON.stringify(multiOut.drc.violations)).toBe(0);
    expect(multiOut.sta.passed, multiOut.sta.bottlenecks.join('; ')).toBe(true);
    assertStrictPipeSeparation(multiOut.allEntities, 'multi-liquid');
  });

  it('supports exact machine-count (full throughput) targets across PDK configurations and liquids', () => {
    // Solid target with Asm3 + Prod3+Speed3 modules (multi-ingredient, exact 6 machines)
    const pdkMod = {
      ...defaultPdkConfig(),
      defaultBeltTier: 'blue' as const,
      defaultAssemblerTier: 3 as const,
      modules: {
        global: [
          'productivity-module-3' as const,
          'productivity-module-3' as const,
          'speed-module-3' as const,
        ],
        byRecipe: {},
      },
    };
    const infoAc = computeRecipeThroughputPerMachine('advanced-circuit', pdkMod, 6)!;
    expect(infoAc).not.toBeNull();
    const specAc = baseSpec(
      '6x Asm3 Red Circuits',
      [{ item: 'advanced-circuit', ratePerMin: 0, machines: 6 }],
      pdkMod,
    );
    const outAc = runFullPipeline(specAc);
    expect(outAc.drc.errorCount, JSON.stringify(outAc.drc.violations)).toBe(0);
    expect(outAc.sta.passed, outAc.sta.bottlenecks.join('; ')).toBe(true);
    const acMacros = outAc.synthesis.nodes.filter(
      (n): n is RecipeMacroSpec => n.kind === 'recipe-macro' && n.outputItem === 'advanced-circuit',
    );
    const acTotalMach = acMacros.reduce((s, m) => s + m.machineCount, 0);
    const acTotalExact = acMacros.reduce((s, m) => s + m.exactMachines, 0);
    const acTotalRate = acMacros.reduce((s, m) => s + m.outputRatePerSec, 0);
    expect(acTotalMach).toBe(6);
    expect(Math.abs(acTotalExact - 6)).toBeLessThan(1e-4);
    expect(acTotalRate).toBeCloseTo(6 * infoAc.itemsPerSec, 3);

    // Multi-slice exact machine count: 8x Asm2 Electronic Circuits (2x4 slices totaling 8)
    const specEcAsm2 = baseSpec('8x Asm2 Circuits', [{ item: 'electronic-circuit', ratePerMin: 0, machines: 8 }]);
    const outEcAsm2 = runFullPipeline(specEcAsm2);
    expect(outEcAsm2.drc.errorCount, JSON.stringify(outEcAsm2.drc.violations)).toBe(0);
    expect(outEcAsm2.sta.passed, outEcAsm2.sta.bottlenecks.join('; ')).toBe(true);
    const ecAsm2Macros = outEcAsm2.synthesis.nodes.filter(
      (n): n is RecipeMacroSpec => n.kind === 'recipe-macro' && n.outputItem === 'electronic-circuit',
    );
    expect(ecAsm2Macros.reduce((s, m) => s + m.machineCount, 0)).toBe(8);
    expect(Math.abs(ecAsm2Macros.reduce((s, m) => s + m.exactMachines, 0) - 8)).toBeLessThan(1e-4);

    // Single-slice solid exact machine count: 4x Asm2 Electronic Circuits
    const specEc4 = baseSpec('4x Asm2 Circuits', [{ item: 'electronic-circuit', ratePerMin: 0, machines: 4 }]);
    const outEc4 = runFullPipeline(specEc4);
    expect(outEc4.drc.errorCount, JSON.stringify(outEc4.drc.violations)).toBe(0);
    expect(outEc4.sta.passed, outEc4.sta.bottlenecks.join('; ')).toBe(true);
    const ec4Macros = outEc4.synthesis.nodes.filter(
      (n): n is RecipeMacroSpec => n.kind === 'recipe-macro' && n.outputItem === 'electronic-circuit',
    );
    expect(ec4Macros.length).toBe(1);
    expect(ec4Macros[0].machineCount).toBe(4);
    expect(Math.abs(ec4Macros[0].exactMachines - 4)).toBeLessThan(1e-4);

    // Liquid target: 6x Chemical Plant Sulfuric Acid at full throughput
    const specAcidMach = baseSpec('6x Sulfuric Acid', [
      { item: 'sulfuric-acid', ratePerMin: 0, machines: 6 },
    ]);
    const outAcid = runFullPipeline(specAcidMach);
    expect(outAcid.drc.errorCount, JSON.stringify(outAcid.drc.violations)).toBe(0);
    expect(outAcid.sta.passed, outAcid.sta.bottlenecks.join('; ')).toBe(true);
    const acidMacro = outAcid.synthesis.nodes.find(
      (n): n is RecipeMacroSpec => n.kind === 'recipe-macro' && n.outputItem === 'sulfuric-acid',
    )!;
    expect(acidMacro.machineCount).toBe(6);
    expect(Math.abs(acidMacro.exactMachines - 6)).toBeLessThan(1e-4);

    // Space Age Foundry Molten Iron: 4x Foundries with legendary quality
    const pdkSa = {
      ...defaultPdkConfig(),
      defaultBeltTier: 'turbo' as const,
      spaceAgeBuildings: true,
      machineQuality: 'legendary' as const,
    };
    const specMoltenMach = baseSpec('4x Legendary Foundry Molten Iron', [
      { item: 'molten-iron', ratePerMin: 0, machines: 4 },
    ], pdkSa);
    const outMolten = runFullPipeline(specMoltenMach);
    expect(outMolten.drc.errorCount, JSON.stringify(outMolten.drc.violations)).toBe(0);
    expect(outMolten.sta.passed, outMolten.sta.bottlenecks.join('; ')).toBe(true);
    const moltenMacros = outMolten.synthesis.nodes.filter(
      (n): n is RecipeMacroSpec => n.kind === 'recipe-macro' && n.outputItem === 'molten-iron',
    );
    expect(moltenMacros.length).toBeGreaterThanOrEqual(1);
    expect(moltenMacros[0].machineName).toBe('foundry');
    expect(moltenMacros.reduce((s, m) => s + m.machineCount, 0)).toBe(4);
    expect(Math.abs(moltenMacros.reduce((s, m) => s + m.exactMachines, 0) - 4)).toBeLessThan(1e-4);

    // YAML round-trip preserves `machines`
    const yamlText = serializeSpecYaml(normalizeSpec(specAc));
    const parsed = parseSpecYaml(yamlText);
    expect(parsed.targets[0].machines).toBe(6);
  });

  it('refines crude oil via oil-refinery and prunes redundant macro power poles on cracking cryogenic plants', () => {
    // 1. Crude oil -> petroleum-gas (oil-refinery)
    const petroRawSpec = {
      ...baseSpec('Petroleum Gas from Crude Oil', [{ item: 'petroleum-gas', ratePerMin: 1800 }]),
      inputPreset: 'raw' as const,
    };
    const petroRawOut = runFullPipeline(petroRawSpec);
    expect(petroRawOut.drc.errorCount, JSON.stringify(petroRawOut.drc.violations)).toBe(0);
    expect(petroRawOut.sta.passed, petroRawOut.sta.bottlenecks.join('; ')).toBe(true);
    const refineryNodes = petroRawOut.synthesis.nodes.filter(
      (n): n is RecipeMacroSpec => n.kind === 'recipe-macro' && n.machineName === 'oil-refinery',
    );
    expect(refineryNodes.length).toBeGreaterThanOrEqual(1);
    const rawInPins = new Set(
      petroRawOut.floorplan.pins.filter((p) => p.kind === 'input').map((p) => p.item),
    );
    expect(rawInPins.has('crude-oil')).toBe(true);
    assertStrictPipeSeparation(petroRawOut.allEntities, 'petro-crude-raw');

    // 2. User screenshot repro: heavy-oil-cracking + light-oil-cracking in 2x cryogenic-plant
    // Previously placed 4 poles per cryogenic plant (8 poles total); should prune to 1 per plant (2 total).
    const saPdk = { ...defaultPdkConfig(), spaceAgeBuildings: true, defaultBeltTier: 'turbo' as const };
    const heavyCrack = compileRecipeMacroVariants(
      {
        id: 'm:heavy-crack',
        kind: 'recipe-macro',
        recipeId: 'heavy-oil-cracking',
        outputItem: 'light-oil',
        outputRatePerSec: 30,
        machineCount: 1,
        exactMachines: 1,
        machineName: 'cryogenic-plant',
        modules: [],
        beltTier: 'turbo',
        ingredientRates: [],
        fluidInputs: [
          { item: 'water', ratePerSec: 30 },
          { item: 'heavy-oil', ratePerSec: 40 },
        ],
        outputIsFluid: true,
      },
      saPdk,
    )[0];
    const lightCrack = compileRecipeMacroVariants(
      {
        id: 'm:light-crack',
        kind: 'recipe-macro',
        recipeId: 'light-oil-cracking',
        outputItem: 'petroleum-gas',
        outputRatePerSec: 20,
        machineCount: 1,
        exactMachines: 1,
        machineName: 'cryogenic-plant',
        modules: [],
        beltTier: 'turbo',
        ingredientRates: [],
        fluidInputs: [
          { item: 'water', ratePerSec: 30 },
          { item: 'light-oil', ratePerSec: 30 },
        ],
        outputIsFluid: true,
      },
      saPdk,
    )[0];
    const heavyPoles = heavyCrack.entities.filter((e) => e.role === 'pole-macro');
    const lightPoles = lightCrack.entities.filter((e) => e.role === 'pole-macro');
    expect(heavyPoles.length).toBe(1);
    expect(lightPoles.length).toBe(1);
    expect(runDrc(heavyCrack.entities, heavyCrack.width, heavyCrack.height).errorCount).toBe(0);
    expect(runDrc(lightCrack.entities, lightCrack.width, lightCrack.height).errorCount).toBe(0);

    // 3. Full-pipeline multi-cryo plant DRC + STA + minimal poles
    const cryoPipelineOut = runFullPipeline({
      ...baseSpec(
        'Two Cryo Cracking',
        [
          { item: 'light-oil', ratePerMin: 900 },
          { item: 'sulfuric-acid', ratePerMin: 1500 },
        ],
        { spaceAgeBuildings: true, defaultBeltTier: 'turbo' },
      ),
    });
    expect(cryoPipelineOut.drc.errorCount, JSON.stringify(cryoPipelineOut.drc.violations)).toBe(0);
    expect(cryoPipelineOut.sta.passed, cryoPipelineOut.sta.bottlenecks.join('; ')).toBe(true);
    const cryoMacroNodes = cryoPipelineOut.synthesis.nodes.filter(
      (n): n is RecipeMacroSpec => n.kind === 'recipe-macro',
    );
    const cryoMacroPoles = cryoPipelineOut.allEntities.filter((e) => e.role === 'pole-macro');
    // 3 fluid/chemical macros (light-oil, sulfur, sulfuric-acid): 1 minimal pole per macro instead of 12
    expect(cryoMacroPoles.length).toBe(cryoMacroNodes.length);
    expect(cryoMacroPoles.length).toBeLessThanOrEqual(3);
    assertStrictPipeSeparation(cryoPipelineOut.allEntities, 'cryo-pruned-poles');
  });
});
