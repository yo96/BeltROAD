import { describe, expect, it } from 'vitest';
import {
  INPUT_PRESET_LIST,
  applyInputOverride,
  decodeSpecFromUrlHash,
  defaultOptimizationConfig,
  defaultPdkConfig,
  encodeSpecToUrlHash,
  inspectInputBoundary,
  normalizeSpec,
  parseSpecYaml,
  runFullPipeline,
  serializeSpecYaml,
} from '../src/index.js';
import type { DesignSpec, InputPreset } from '../src/index.js';

function yellowScienceSpec(inputPreset: InputPreset, enableFluids = true): DesignSpec {
  return {
    version: 1,
    name: `Yellow (${inputPreset})`,
    pdk: {
      ...defaultPdkConfig(),
      defaultBeltTier: 'red',
      defaultAssemblerTier: 2,
      enableFluids,
    },
    targets: [{ item: 'utility-science-pack', ratePerMin: 30 }],
    inputPreset,
    inputOverrides: {},
    floorplan: { mode: 'auto', aspectRatio: 1.35, margin: 3, halo: 2 },
    pins: [],
    macroOverrides: {},
    optimization: defaultOptimizationConfig('compact'),
  };
}

describe('Multi-Level Input Material Selection & Boundary Presets', () => {
  it('exposes all 5 presets and differentiates boundary depth cleanly on Yellow Science', () => {
    expect(INPUT_PRESET_LIST.map((p) => p.id)).toEqual([
      'raw',
      'plates',
      'bus',
      'intermediates',
      'direct',
    ]);

    const rawIns = inspectInputBoundary(yellowScienceSpec('raw'));
    const rawIds = new Set(rawIns.activeInputs.map((i) => i.item));
    expect(rawIds.has('iron-ore')).toBe(true);
    expect(rawIds.has('copper-ore')).toBe(true);
    expect(rawIds.has('iron-plate')).toBe(false);

    const platesIns = inspectInputBoundary(yellowScienceSpec('plates'));
    const platesIds = new Set(platesIns.activeInputs.map((i) => i.item));
    expect(platesIds.has('iron-plate')).toBe(true);
    expect(platesIds.has('copper-plate')).toBe(true);
    expect(platesIds.has('steel-plate')).toBe(true);
    expect(platesIds.has('iron-ore')).toBe(false);
    expect(platesIds.has('electronic-circuit')).toBe(false);

    const busIns = inspectInputBoundary(yellowScienceSpec('bus'));
    const busIds = new Set(busIns.activeInputs.map((i) => i.item));
    // Flying robot frame is synthesized under 'bus', exposing its bus inputs + direct LDS/PU
    expect(busIds).toEqual(
      new Set([
        'processing-unit',
        'electric-engine-unit',
        'battery',
        'steel-plate',
        'electronic-circuit',
        'low-density-structure',
      ]),
    );

    const interIns = inspectInputBoundary(yellowScienceSpec('intermediates'));
    const interIds = new Set(interIns.activeInputs.map((i) => i.item));
    expect(interIds.has('processing-unit')).toBe(true);
    expect(interIds.has('flying-robot-frame')).toBe(true);
    expect(interIds.has('low-density-structure')).toBe(true);

    const directIns = inspectInputBoundary(yellowScienceSpec('direct'));
    expect(directIns.activeInputs.map((i) => i.item).sort()).toEqual([
      'flying-robot-frame',
      'low-density-structure',
      'processing-unit',
    ]);
    // Deep intermediates should still be discoverable in `allItems`
    const deepGear = directIns.allItems.find((i) => i.item === 'iron-gear-wheel');
    expect(deepGear?.mode).toBe('behind-input');
  });

  it('compiles all 5 presets cleanly through runFullPipeline with DRC=0 & STA=PASS', () => {
    for (const preset of ['direct', 'intermediates', 'bus', 'plates'] as InputPreset[]) {
      const out = runFullPipeline(yellowScienceSpec(preset));
      expect(out.drc.errorCount, `${preset} DRC: ${JSON.stringify(out.drc.violations)}`).toBe(0);
      expect(out.sta.passed, `${preset} STA: ${out.sta.bottlenecks.join('; ')}`).toBe(true);
    }

    // Also test 'raw' smelting end-to-end on Electronic Circuits
    const rawEcSpec: DesignSpec = {
      version: 1,
      name: 'Raw Ore Green Circuits',
      pdk: defaultPdkConfig(),
      targets: [{ item: 'electronic-circuit', ratePerMin: 120 }],
      inputPreset: 'raw',
      inputOverrides: {},
      floorplan: { mode: 'auto', aspectRatio: 1.35, margin: 3, halo: 2 },
      pins: [],
      macroOverrides: {},
      optimization: defaultOptimizationConfig('compact'),
    };
    const rawOut = runFullPipeline(rawEcSpec);
    expect(rawOut.drc.errorCount, JSON.stringify(rawOut.drc.violations)).toBe(0);
    expect(rawOut.sta.passed, rawOut.sta.bottlenecks.join('; ')).toBe(true);
    const inItems = new Set(rawOut.floorplan.pins.filter((p) => p.kind === 'input').map((p) => p.item));
    expect(inItems.has('iron-ore')).toBe(true);
    expect(inItems.has('copper-ore')).toBe(true);
  });

  it('supports fine-grained arbitrary-level overrides including ancestor promotion & fluid auto-enable', () => {
    // 1. Start from 'direct' on Yellow Science, customize a deeper item ('electronic-circuit' -> input)
    let spec = yellowScienceSpec('direct');
    spec = applyInputOverride(spec, 'electronic-circuit', 'input');
    const ins1 = inspectInputBoundary(spec);
    const inItems1 = new Set(ins1.activeInputs.map((i) => i.item));
    // 'processing-unit' must be promoted to synthesize so 'electronic-circuit' becomes a live input pin
    expect(inItems1.has('processing-unit')).toBe(false);
    expect(inItems1.has('electronic-circuit')).toBe(true);
    expect(inItems1.has('advanced-circuit')).toBe(true);
    expect(inItems1.has('sulfuric-acid')).toBe(true);

    const out1 = runFullPipeline(spec);
    expect(out1.drc.errorCount, JSON.stringify(out1.drc.violations)).toBe(0);
    expect(out1.sta.passed, out1.sta.bottlenecks.join('; ')).toBe(true);

    // 2. Start from 'plates' on Red Circuits (enableFluids: false), override 'plastic-bar' -> synthesize
    const redPlates: DesignSpec = {
      version: 1,
      name: 'Red Circuits + On-Site Plastic',
      pdk: { ...defaultPdkConfig(), enableFluids: false },
      targets: [{ item: 'advanced-circuit', ratePerMin: 60 }],
      inputPreset: 'plates',
      inputOverrides: {},
      floorplan: { mode: 'auto', aspectRatio: 1.35, margin: 3, halo: 2 },
      pins: [],
      macroOverrides: {},
      optimization: defaultOptimizationConfig('compact'),
    };
    const withPlasticSynth = applyInputOverride(redPlates, 'plastic-bar', 'synthesize');
    expect(withPlasticSynth.pdk.enableFluids).toBe(true);
    const plasticOut = runFullPipeline(withPlasticSynth);
    expect(plasticOut.drc.errorCount, JSON.stringify(plasticOut.drc.violations)).toBe(0);
    expect(plasticOut.sta.passed, plasticOut.sta.bottlenecks.join('; ')).toBe(true);
    const plasticInPins = new Set(
      plasticOut.floorplan.pins.filter((p) => p.kind === 'input').map((p) => p.item),
    );
    expect(plasticInPins.has('petroleum-gas')).toBe(true);
    expect(plasticInPins.has('coal')).toBe(true);
    expect(plasticInPins.has('plastic-bar')).toBe(false);

    // 3. Overriding a plates-default item ('electronic-circuit': 'input') and reverting to 'synthesize' cleans overrideCount to 0
    const withEcIn = applyInputOverride(redPlates, 'electronic-circuit', 'input');
    expect(inspectInputBoundary(withEcIn).overrideCount).toBe(1);
    const reverted = applyInputOverride(withEcIn, 'electronic-circuit', 'synthesize');
    expect(inspectInputBoundary(reverted).overrideCount).toBe(0);

    // 4. Explicit targets cannot be forced to 'input'
    const guarded = applyInputOverride(redPlates, 'advanced-circuit', 'input');
    expect(guarded.inputOverrides['advanced-circuit']).toBeUndefined();

    // 5. Crude oil becomes active input under 'raw' preset (and stays synthesized downstream of petroleum-gas under 'raw')
    const yellowRaw = inspectInputBoundary(yellowScienceSpec('raw'));
    const yellowRawItems = new Set(yellowRaw.activeInputs.map((i) => i.item));
    expect(yellowRawItems.has('crude-oil')).toBe(true);
    expect(yellowRawItems.has('petroleum-gas')).toBe(false);
    expect(yellowRawItems.has('sulfuric-acid')).toBe(false);
  });

  it('preserves new presets and fine-grained overrides across YAML and URL codecs', () => {
    const base = applyInputOverride(yellowScienceSpec('intermediates'), 'flying-robot-frame', 'synthesize');
    const norm = normalizeSpec(base);
    expect(norm.inputPreset).toBe('intermediates');
    expect(norm.inputOverrides['flying-robot-frame']).toBe('synthesize');

    const yamlRound = parseSpecYaml(serializeSpecYaml(norm));
    expect(yamlRound.inputPreset).toBe('intermediates');
    expect(yamlRound.inputOverrides['flying-robot-frame']).toBe('synthesize');

    const urlRound = decodeSpecFromUrlHash(encodeSpecToUrlHash(norm));
    expect(urlRound?.inputPreset).toBe('intermediates');
    expect(urlRound?.inputOverrides['flying-robot-frame']).toBe('synthesize');
  });
});
