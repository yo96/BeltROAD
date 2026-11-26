import { describe, expect, it } from 'vitest';
import {
  DesignSpec,
  PoleTier,
  RecipeMacroSpec,
  decodeSpecFromUrlHash,
  defaultOptimizationConfig,
  defaultPdkConfig,
  encodeSpecToUrlHash,
  parseSpecYaml,
  runDrc,
  runFullPipeline,
  serializeSpecYaml,
} from '../src/index.js';
import { isPipeName, isPipeUndergroundName } from '../src/data/entities.js';
import { dirDelta } from '../src/geometry.js';

function makeSpec(
  name: string,
  targets: DesignSpec['targets'],
  opts?: {
    inputPreset?: DesignSpec['inputPreset'];
    byproductPolicy?: DesignSpec['byproductPolicy'];
    poleTier?: PoleTier;
    inputOverrides?: DesignSpec['inputOverrides'];
    pdk?: Partial<DesignSpec['pdk']>;
  },
): DesignSpec {
  return {
    version: 1,
    name,
    pdk: {
      ...defaultPdkConfig(),
      enableFluids: true,
      defaultPoleTier: opts?.poleTier ?? 'medium',
      ...opts?.pdk,
    },
    targets,
    inputPreset: opts?.inputPreset ?? 'raw',
    inputOverrides: opts?.inputOverrides ?? {},
    byproductPolicy: opts?.byproductPolicy ?? 'auto-consume',
    floorplan: { mode: 'auto', aspectRatio: 1.35, margin: 3, halo: 2 },
    pins: [],
    macroOverrides: {},
    optimization: defaultOptimizationConfig('compact'),
  };
}

function assertStrictPipeSeparation(entities: ReturnType<typeof runFullPipeline>['allEntities'], label: string) {
  const pipes = entities.filter((e) => isPipeName(e.name));
  const byTile = new Map<string, (typeof pipes)[number]>();
  for (const p of pipes) byTile.set(`${p.tx},${p.ty}`, p);
  const hasPort = (ent: (typeof pipes)[number], dx: number, dy: number) => {
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
      if (a.item && b.item) expect(a.item, `${label} pipe fluid mixing`).toBe(b.item);
      if (a.netId && b.netId) expect(a.netId, `${label} adjacent pipe nets`).toBe(b.netId);
    }
  }
}

describe('Phase 1 Side Products (Multi-Output Refinery, LP Cracking & Byproduct Pins)', () => {
  it('compiles 3-output oil-refinery for heavy-oil across small/medium/substation poles with BYPRODUCT pins', () => {
    for (const poleTier of ['small', 'medium', 'substation'] as PoleTier[]) {
      const spec = makeSpec(`Heavy Oil (${poleTier})`, [{ item: 'heavy-oil', ratePerMin: 0, machines: 4 }], {
        poleTier,
      });
      const out = runFullPipeline(spec);
      expect(out.drc.errorCount, `${poleTier} DRC: ${JSON.stringify(out.drc.violations)}`).toBe(0);
      expect(out.sta.passed, `${poleTier} STA: ${out.sta.bottlenecks.join('; ')}`).toBe(true);
      assertStrictPipeSeparation(out.allEntities, `heavy-${poleTier}`);

      const refMacro = out.synthesis.nodes.find(
        (n): n is RecipeMacroSpec => n.kind === 'recipe-macro' && n.recipeId === 'advanced-oil-processing',
      )!;
      expect(refMacro.machineName).toBe('oil-refinery');
      expect(refMacro.machineCount).toBe(4);
      expect(refMacro.fluidOutputs?.map((o) => o.item)).toEqual([
        'heavy-oil',
        'light-oil',
        'petroleum-gas',
      ]);

      const primaryOutPins = out.floorplan.pins.filter((p) => p.kind === 'output' && !p.isByproduct);
      const bypPins = out.floorplan.pins.filter((p) => p.kind === 'output' && p.isByproduct);
      expect(primaryOutPins.map((p) => p.item)).toEqual(['heavy-oil']);
      expect(new Set(bypPins.map((p) => p.item))).toEqual(new Set(['light-oil', 'petroleum-gas']));
      expect(out.synthesis.byproducts?.length).toBe(2);
    }
  });

  it('auto-cracks vs exports side products for light-oil under raw preset', () => {
    const autoOut = runFullPipeline(
      makeSpec('Light Oil Auto-Crack', [{ item: 'light-oil', ratePerMin: 1800 }], {
        byproductPolicy: 'auto-consume',
      }),
    );
    expect(autoOut.drc.errorCount, JSON.stringify(autoOut.drc.violations)).toBe(0);
    expect(autoOut.sta.passed, autoOut.sta.bottlenecks.join('; ')).toBe(true);
    assertStrictPipeSeparation(autoOut.allEntities, 'light-auto');

    const exportOut = runFullPipeline(
      makeSpec('Light Oil Export', [{ item: 'light-oil', ratePerMin: 1800 }], {
        byproductPolicy: 'export',
      }),
    );
    expect(exportOut.drc.errorCount, JSON.stringify(exportOut.drc.violations)).toBe(0);
    expect(exportOut.sta.passed, exportOut.sta.bottlenecks.join('; ')).toBe(true);
    assertStrictPipeSeparation(exportOut.allEntities, 'light-export');

    // Auto-consume uses heavy-oil-cracking so zero heavy-oil byproduct & strictly less crude oil
    expect(
      autoOut.synthesis.nodes.some(
        (n) => n.kind === 'recipe-macro' && n.recipeId === 'heavy-oil-cracking',
      ),
    ).toBe(true);
    expect(
      autoOut.floorplan.pins.some((p) => p.isByproduct && p.item === 'heavy-oil'),
    ).toBe(false);

    // Export mode uses 0 cracking machines and exports both heavy-oil and petroleum-gas
    expect(
      exportOut.synthesis.nodes.some(
        (n) => n.kind === 'recipe-macro' && n.recipeId === 'heavy-oil-cracking',
      ),
    ).toBe(false);
    const expBypItems = new Set(
      exportOut.floorplan.pins.filter((p) => p.isByproduct).map((p) => p.item),
    );
    expect(expBypItems).toEqual(new Set(['heavy-oil', 'petroleum-gas']));

    const crudeAuto = autoOut.floorplan.pins
      .filter((p) => p.kind === 'input' && p.item === 'crude-oil')
      .reduce((s, p) => s + p.ratePerSec, 0);
    const crudeExport = exportOut.floorplan.pins
      .filter((p) => p.kind === 'input' && p.item === 'crude-oil')
      .reduce((s, p) => s + p.ratePerSec, 0);
    expect(crudeAuto).toBeLessThan(crudeExport);
  });

  it('compiles coupled Lubricant + Petroleum Gas and Yellow Science end-to-end under raw preset', () => {
    const lubeGas = runFullPipeline(
      makeSpec('Lubricant + Gas (Raw)', [
        { item: 'lubricant', ratePerMin: 1500 },
        { item: 'petroleum-gas', ratePerMin: 5100 },
      ]),
    );
    expect(lubeGas.drc.errorCount, JSON.stringify(lubeGas.drc.violations)).toBe(0);
    expect(lubeGas.sta.passed, lubeGas.sta.bottlenecks.join('; ')).toBe(true);
    assertStrictPipeSeparation(lubeGas.allEntities, 'lube-gas');

    const yellowRaw = runFullPipeline(
      makeSpec('Yellow Science (Raw)', [{ item: 'utility-science-pack', ratePerMin: 30 }], {
        pdk: { defaultBeltTier: 'red', defaultAssemblerTier: 2 },
      }),
    );
    expect(yellowRaw.drc.errorCount, JSON.stringify(yellowRaw.drc.violations)).toBe(0);
    expect(yellowRaw.sta.passed, yellowRaw.sta.bottlenecks.join('; ')).toBe(true);
    assertStrictPipeSeparation(yellowRaw.allEntities, 'yellow-raw');
    const inItems = new Set(yellowRaw.floorplan.pins.filter((p) => p.kind === 'input').map((p) => p.item));
    expect(inItems.has('crude-oil')).toBe(true);
    expect(inItems.has('water')).toBe(true);
  });

  it('flags UNCONNECTED_BYPRODUCT in DRC and round-trips byproductPolicy across YAML/URL codecs', () => {
    const drcRes = runDrc(
      [
        {
          id: 'ref:0',
          name: 'oil-refinery',
          tx: 2,
          ty: 2,
          w: 5,
          h: 5,
          direction: 8,
          hasFluidBox: true,
          recipe: 'advanced-oil-processing',
          role: 'machine',
        },
        {
          id: 'p:heavy',
          name: 'pipe',
          tx: 6,
          ty: 7,
          w: 1,
          h: 1,
          direction: 0,
          item: 'heavy-oil',
          role: 'pipe-macro',
        },
      ],
      16,
      16,
    );
    expect(drcRes.violations.some((v) => v.code === 'UNCONNECTED_BYPRODUCT')).toBe(true);

    const spec = makeSpec('Policy Roundtrip', [{ item: 'heavy-oil', ratePerMin: 900 }], {
      byproductPolicy: 'export',
    });
    const yamlParsed = parseSpecYaml(serializeSpecYaml(spec));
    expect(yamlParsed.byproductPolicy).toBe('export');
    const urlParsed = decodeSpecFromUrlHash(encodeSpecToUrlHash(spec));
    expect(urlParsed?.byproductPolicy).toBe('export');
  });
});
