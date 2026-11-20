import { DesignSpec } from '../types.js';
import { defaultOptimizationConfig, defaultPdkConfig } from './yamlCodec.js';

export interface PresetEntry {
  id: string;
  label: string;
  description: string;
  spec: DesignSpec;
}

export const BUILTIN_PRESETS: PresetEntry[] = [
  {
    id: 'green-circuits',
    label: 'Green Circuits (1 Red Belt)',
    description: '1800/min Electronic Circuits with multi-belt Copper Cable bus & balancers',
    spec: {
      version: 1,
      name: 'Green Circuits (1800/min)',
      pdk: defaultPdkConfig(),
      targets: [{ item: 'electronic-circuit', ratePerMin: 1800 }],
      inputPreset: 'plates',
      inputOverrides: {},
      floorplan: { mode: 'auto', aspectRatio: 1.35, margin: 3, halo: 2 },
      pins: [
        { bus: 'in:copper-plate', edge: 'W', order: 1 },
        { bus: 'in:iron-plate', edge: 'W', order: 2 },
        { bus: 'out:electronic-circuit', edge: 'E', order: 1 },
      ],
      macroOverrides: {},
      optimization: defaultOptimizationConfig('compact'),
    },
  },
  {
    id: 'red-green-science',
    label: 'Red + Green Science (60/min)',
    description: '60/min Automation + Logistic Science (dual-lane Inserters & multi-target DAG)',
    spec: {
      version: 1,
      name: 'Red + Green Science (60/min)',
      pdk: {
        ...defaultPdkConfig(),
        defaultBeltTier: 'yellow',
        defaultInserterTier: 'yellow',
      },
      targets: [
        { item: 'automation-science-pack', ratePerMin: 60 },
        { item: 'logistic-science-pack', ratePerMin: 60 },
      ],
      inputPreset: 'plates',
      inputOverrides: {},
      floorplan: { mode: 'auto', aspectRatio: 1.35, margin: 3, halo: 2 },
      pins: [
        { bus: 'in:iron-plate', edge: 'W', order: 1 },
        { bus: 'in:copper-plate', edge: 'W', order: 2 },
        { bus: 'out:automation-science-pack', edge: 'E', order: 1 },
        { bus: 'out:logistic-science-pack', edge: 'E', order: 2 },
      ],
      macroOverrides: {},
      optimization: defaultOptimizationConfig('compact'),
    },
  },
  {
    id: 'red-circuits',
    label: 'Red Circuits (60/min)',
    description: '60/min Advanced Circuits with Plastic Bar external pin & pinned edge ports',
    spec: {
      version: 1,
      name: 'Red Circuits (60/min)',
      pdk: defaultPdkConfig(),
      targets: [{ item: 'advanced-circuit', ratePerMin: 60 }],
      inputPreset: 'plates',
      inputOverrides: {},
      floorplan: { mode: 'auto', aspectRatio: 1.35, margin: 3, halo: 2 },
      pins: [
        { id: 'in:iron-plate:0', edge: 'W', order: 1 },
        { id: 'in:copper-plate:0', edge: 'W', order: 2 },
        { id: 'in:plastic-bar:0', edge: 'N', order: 1 },
        { id: 'out:advanced-circuit:0', edge: 'E', order: 1 },
      ],
      macroOverrides: {},
      optimization: defaultOptimizationConfig('compact'),
    },
  },
  {
    id: 'military-science',
    label: 'Military Science (60/min)',
    description: '60/min Military Science Pack with 3-ingredient solid chain & Coal input',
    spec: {
      version: 1,
      name: 'Military Science (60/min)',
      pdk: defaultPdkConfig(),
      targets: [{ item: 'military-science-pack', ratePerMin: 60 }],
      inputPreset: 'plates',
      inputOverrides: {},
      floorplan: { mode: 'auto', aspectRatio: 1.4, margin: 3, halo: 2 },
      pins: [],
      macroOverrides: {},
      optimization: defaultOptimizationConfig('compact'),
    },
  },
  {
    id: 'purple-science',
    label: 'Production Science (30/min)',
    description: '30/min Production Science Pack (Electric Furnace + Prod Module + Rail)',
    spec: {
      version: 1,
      name: 'Production Science (30/min)',
      pdk: {
        ...defaultPdkConfig(),
        defaultAssemblerTier: 3,
      },
      targets: [{ item: 'production-science-pack', ratePerMin: 30 }],
      inputPreset: 'plates',
      inputOverrides: {},
      floorplan: { mode: 'auto', aspectRatio: 1.4, margin: 4, halo: 2 },
      pins: [],
      macroOverrides: {},
      optimization: defaultOptimizationConfig('compact'),
    },
  },
];
