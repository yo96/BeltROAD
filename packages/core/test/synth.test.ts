import { describe, expect, it } from 'vitest';
import {
  BUILTIN_PRESETS,
  defaultPdkConfig,
  synthesizeDesign,
} from '../src/index.js';

describe('Synthesis & Tech-Mapping', () => {
  it('computes exact Green Circuit (30/s) machine counts & copper cable multi-belt slicing', () => {
    const preset = structuredClone(BUILTIN_PRESETS[0].spec); // 1800/min electronic-circuit, red belts, asm2
    const synth = synthesizeDesign(preset);

    const ecDag = synth.dag.find((d) => d.item === 'electronic-circuit');
    expect(ecDag).toBeDefined();
    // 30/s * 0.5s / 0.75 speed = 20 Assembler 2s
    expect(ecDag!.exactMachines).toBeCloseTo(20, 4);
    expect(ecDag!.machineCount).toBe(20);

    const cableDag = synth.dag.find((d) => d.item === 'copper-cable');
    expect(cableDag).toBeDefined();
    // 30/s circuits need 90/s copper cable; 1 asm2 crafts 2 cables / (0.5/0.75 s) = 3/s -> 30 asm2s
    expect(cableDag!.exactMachines).toBeCloseTo(30, 4);
    expect(cableDag!.machineCount).toBe(30);

    // 90/s copper cable exceeds 30/s red belt -> must split into >= 3 slices
    const cableMacros = synth.nodes.filter(
      (n) => n.kind === 'recipe-macro' && n.recipeId === 'copper-cable',
    );
    expect(cableMacros.length).toBeGreaterThanOrEqual(3);
  });

  it('applies productivity + speed module math correctly without inflating ingredient demand', () => {
    const baseSpec = {
      version: 1,
      name: 'Prod Test',
      pdk: {
        ...defaultPdkConfig(),
        defaultAssemblerTier: 3 as const,
        modules: {
          global: [
            'productivity-module-3',
            'productivity-module-3',
            'productivity-module-3',
            'productivity-module-3',
          ] as const,
          byRecipe: {},
        },
      },
      targets: [{ item: 'electronic-circuit', ratePerMin: 1800 }],
      inputPreset: 'plates' as const,
      inputOverrides: {},
      floorplan: { mode: 'auto' as const, aspectRatio: 1.35, margin: 5, halo: 3 },
      pins: [],
      macroOverrides: {},
    };

    const synth = synthesizeDesign({
      ...baseSpec,
      pdk: {
        ...baseSpec.pdk,
        modules: {
          global: [...baseSpec.pdk.modules.global],
          byRecipe: {},
        },
      },
    });

    const ecDag = synth.dag.find((d) => d.item === 'electronic-circuit')!;
    // Asm3 (1.25) * (1 - 4*0.15 = 0.40) = 0.50 effective speed; 1.4x prod
    // Out/machine = 1 * 1.4 * 0.5 / 0.5 = 1.4/s -> 30 / 1.4 = 21.4286 machines
    expect(ecDag.exactMachines).toBeCloseTo(30 / 1.4, 3);

    // Ingredient consumption: 21.4286 * (1 * 0.5 / 0.5) = 21.4286 iron-plate/s (less than 30/s due to prod!)
    const ironDag = synth.dag.find((d) => d.item === 'iron-plate')!;
    expect(ironDag.demandPerSec).toBeCloseTo(30 / 1.4, 3);
  });

  it('automatically cuts fluid-dependent recipes as external input pins in v1', () => {
    const synth = synthesizeDesign({
      version: 1,
      name: 'Yellow Science',
      pdk: defaultPdkConfig(),
      targets: [{ item: 'utility-science-pack', ratePerMin: 60 }],
      inputPreset: 'plates',
      inputOverrides: {},
      floorplan: { mode: 'auto', aspectRatio: 1.35, margin: 5, halo: 3 },
      pins: [],
      macroOverrides: {},
    });

    const blueCircuits = synth.dag.find((d) => d.item === 'processing-unit');
    expect(blueCircuits?.mode).toBe('input-pin');
    expect(blueCircuits?.forcedInputReason).toBe('fluid-v1');

    const plastic = synth.dag.find((d) => d.item === 'plastic-bar');
    expect(plastic?.mode).toBe('input-pin');
    expect(plastic?.forcedInputReason).toBe('fluid-v1');

    const frame = synth.dag.find((d) => d.item === 'flying-robot-frame');
    expect(frame?.mode).toBe('synthesize');
  });
});
