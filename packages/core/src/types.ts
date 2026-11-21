export const FACTORIO_2_0_VERSION = 562949958139904;
export const FACTORIO_2_0_MIN_VERSION = 562949953421312;

export enum Dir {
  NORTH = 0,
  EAST = 4,
  SOUTH = 8,
  WEST = 12,
}

export type Edge = 'N' | 'S' | 'E' | 'W';
export type Rot90 = 0 | 1 | 2 | 3;

export type BeltTier = 'yellow' | 'red' | 'blue';
export type AssemblerTier = 1 | 2 | 3;
export type InserterTier = 'yellow' | 'fast' | 'bulk';
export type AllInserterKind = 'yellow' | 'long' | 'fast' | 'bulk';
export type PoleTier = 'small' | 'medium' | 'substation';
export type ModuleName =
  | 'speed-module'
  | 'speed-module-2'
  | 'speed-module-3'
  | 'productivity-module'
  | 'productivity-module-2'
  | 'productivity-module-3'
  | 'efficiency-module'
  | 'efficiency-module-2'
  | 'efficiency-module-3';

export type PortMarkerMode = 'none' | 'display-panel' | 'constant-combinator';
export type InputPreset = 'plates' | 'bus' | 'raw';

export interface PdkConfig {
  defaultBeltTier: BeltTier;
  allowedBeltTiers: BeltTier[];
  downsizeLowRateBelts: boolean;
  defaultAssemblerTier: AssemblerTier;
  allowedAssemblerTiers: AssemblerTier[];
  defaultInserterTier: InserterTier;
  allowedInserterTiers: AllInserterKind[];
  defaultPoleTier: PoleTier;
  modules: {
    global: ModuleName[];
    byRecipe: Record<string, ModuleName[]>;
  };
  allowBeltWeaving: false;
  portMarkers: PortMarkerMode;
}

export interface TargetSpec {
  item: string;
  ratePerMin: number;
}

export interface FloorplanConfig {
  mode: 'auto' | 'fixed';
  width?: number;
  height?: number;
  aspectRatio: number;
  margin: number;
  halo: number;
}

export interface PinConstraint {
  /** Exact pin id (e.g. "in:iron-plate:0" or "out:electronic-circuit:0") */
  id?: string;
  /** Bus name ("in:iron-plate" or "iron-plate") when constraining a bus group */
  bus?: string;
  edge?: Edge;
  order?: number;
  offset?: number;
  locked?: boolean;
}

export interface MacroOverride {
  x?: number;
  y?: number;
  rotation?: Rot90;
  flipY?: boolean;
  locked?: boolean;
  rows?: number;
}

export interface BalancerPort {
  x: number;
  y: number;
  dir: Dir;
}

export interface BalancerEntityDef {
  tx: number;
  ty: number;
  w: number;
  h: number;
  kind: 'belt' | 'underground' | 'splitter';
  direction: Dir;
  ugType?: 'input' | 'output';
}

export interface BalancerTemplate {
  id: string;
  name: string;
  inputs: number;
  outputs: number;
  width: number;
  height: number;
  beltTier: BeltTier;
  maxUgDistance: number;
  entities: BalancerEntityDef[];
  inputPorts: BalancerPort[];
  outputPorts: BalancerPort[];
  source: 'builtin' | 'imported' | 'procedural';
}

export type OptimizationLevel = 'fast' | 'balanced' | 'compact';

export interface OptimizationConfig {
  level: OptimizationLevel;
  compactMacros: boolean;
  alignPins: boolean;
  compactFloorplan: boolean;
  optimizeRoutes: boolean;
  layeredFloorplan?: boolean;
  busTaps?: boolean;
  portSwap?: boolean;
  allowFlipY?: boolean;
}

export interface DesignSpec {
  version: number;
  name: string;
  pdk: PdkConfig;
  targets: TargetSpec[];
  inputPreset: InputPreset;
  inputOverrides: Record<string, 'input' | 'synthesize'>;
  floorplan: FloorplanConfig;
  pins: PinConstraint[];
  macroOverrides: Record<string, MacroOverride>;
  customBalancers?: BalancerTemplate[];
  optimization?: OptimizationConfig;
}

export interface RecipeIngredient {
  item: string;
  amount: number;
  type?: 'item' | 'fluid';
}

export interface RecipeDef {
  id: string;
  name: string;
  category: 'crafting' | 'advanced-crafting' | 'crafting-with-fluid' | 'smelting' | 'chemistry' | 'oil-processing';
  energyRequired: number;
  ingredients: RecipeIngredient[];
  outputItem: string;
  outputCount: number;
  allowProductivity: boolean;
  hasFluid: boolean;
  /** Optional display metadata */
  color?: string;
  group?: string;
}

export interface ItemMeta {
  id: string;
  name: string;
  color: string;
  category: string;
  stackSize: number;
}

export type EntityRole =
  | 'machine'
  | 'inserter-in'
  | 'inserter-out'
  | 'belt-macro'
  | 'belt-route'
  | 'ug-macro'
  | 'ug-route'
  | 'splitter-macro'
  | 'balancer'
  | 'pole-macro'
  | 'pole-pdn'
  | 'port-marker';

export interface EntityInstance {
  id: string;
  name: string;
  /** Top-left integer tile coordinate */
  tx: number;
  ty: number;
  w: number;
  h: number;
  direction: Dir;
  type?: 'input' | 'output'; // for underground-belt
  recipe?: string;
  items?: ModuleName[]; // modules inside crafting machine
  macroId?: string;
  netId?: string;
  item?: string; // carried item (for belt/DRC/render)
  laneItems?: [string, string]; // [leftLane, rightLane] for dual-lane belts
  role: EntityRole;
  /** Explicit intentional dual-lane merge point inside a macro input manifold */
  intentionalSideLoad?: boolean;
  markerText?: string;
  markerIcon?: string;
  markerRatePerMin?: number;
}

export interface NetEndpoint {
  nodeId: string;
  pinId: string;
  kind: 'source' | 'sink';
  item: string;
}

export interface SynthNet {
  id: string;
  busId: string;
  busIndex: number;
  item: string;
  ratePerSec: number;
  beltTier: BeltTier;
  source: NetEndpoint;
  sink: NetEndpoint;
}

export interface SynthInputNode {
  id: string;
  kind: 'primary-input';
  item: string;
  busIndex: number;
  ratePerSec: number;
  beltTier: BeltTier;
  pinId: string;
}

export interface SynthOutputNode {
  id: string;
  kind: 'primary-output';
  item: string;
  busIndex: number;
  ratePerSec: number;
  beltTier: BeltTier;
  pinId: string;
}

export interface RecipeMacroSpec {
  id: string;
  kind: 'recipe-macro';
  recipeId: string;
  outputItem: string;
  machineName: 'assembling-machine-1' | 'assembling-machine-2' | 'assembling-machine-3' | 'electric-furnace';
  machineCount: number;
  exactMachines: number;
  modules: ModuleName[];
  effectiveSpeed: number;
  effectiveProd: number;
  outputRatePerSec: number;
  beltTier: BeltTier;
  ingredientRates: { item: string; ratePerSec: number; beltTier: BeltTier }[];
  preferredRows?: number;
  balanceOutputLanes?: boolean;
  sliceIndex: number;
  sliceCount: number;
}

export interface BalancerMacroSpec {
  id: string;
  kind: 'balancer-macro';
  item: string;
  inputs: number;
  outputs: number;
  beltTier: BeltTier;
  totalRatePerSec: number;
  templateId: string;
}

export type SynthNode = SynthInputNode | SynthOutputNode | RecipeMacroSpec | BalancerMacroSpec;

export interface DagSummaryNode {
  item: string;
  name: string;
  demandPerSec: number;
  demandPerMin: number;
  mode: 'input-pin' | 'synthesize';
  forcedInputReason?: 'no-recipe' | 'fluid-v1' | 'preset';
  recipeId?: string;
  machineName?: string;
  exactMachines: number;
  machineCount: number;
  beltCount: number;
  ingredients: { item: string; ratePerSec: number }[];
}

export interface BomSummary {
  entities: Record<string, number>;
  modules: Record<string, number>;
  estimatedPowerKw: number;
  totalMachines: number;
}

export interface SynthesisResult {
  spec: DesignSpec;
  nodes: SynthNode[];
  nets: SynthNet[];
  dag: DagSummaryNode[];
  bom: BomSummary;
  warnings: string[];
}

export interface MacroPin {
  id: string;
  item: string;
  direction: Dir; // direction items flow AT the pin (into macro for input, out of macro for output)
  kind: 'input' | 'output';
  /** Relative integer tile inside macro bounding box where external belt connects */
  x: number;
  y: number;
  /** Tile immediately outside macro where router connects */
  portX: number;
  portY: number;
  ratePerSec: number;
  beltTier: BeltTier;
}

export interface CompiledMacro {
  id: string;
  kind: 'recipe-macro' | 'balancer-macro';
  label: string;
  sublabel: string;
  recipeId?: string;
  outputItem: string;
  rows: number;
  width: number;
  height: number;
  rotation: Rot90;
  flippedY?: boolean;
  entities: EntityInstance[];
  pins: MacroPin[];
  /** Tiles that are open interior paths for power poles etc., vs occupied */
  powerTargets: { tx: number; ty: number; w: number; h: number }[];
}

export interface PlacedMacro {
  id: string;
  macro: CompiledMacro;
  x: number;
  y: number;
  locked: boolean;
  /** Available aspect-ratio variants before rotation */
  variants: CompiledMacro[];
}

export interface PerimeterPin {
  id: string;
  busId: string;
  busIndex: number;
  kind: 'input' | 'output';
  item: string;
  ratePerSec: number;
  beltTier: BeltTier;
  edge: Edge;
  /** Coordinate along edge (y for W/E, x for N/S) */
  offset: number;
  /** Tile coordinate on die perimeter */
  x: number;
  y: number;
  /** Direction items flow */
  dir: Dir;
  order: number;
  locked: boolean;
  netId?: string;
}

export interface FloorplanResult {
  width: number;
  height: number;
  margin: number;
  halo: number;
  macros: PlacedMacro[];
  pins: PerimeterPin[];
  /** Estimated HPWL wirelength */
  hpwl: number;
  warnings: string[];
}

export interface RoutedNetSegment {
  netId: string;
  item: string;
  beltTier: BeltTier;
  tiles: { tx: number; ty: number; dir: Dir; kind: 'belt' | 'ug-in' | 'ug-out'; jumpDist?: number }[];
  routed: boolean;
  length: number;
  undergroundCount: number;
}

export interface RouteResult {
  width: number;
  height: number;
  routedNets: RoutedNetSegment[];
  entities: EntityInstance[];
  iterations: number;
  conflictsRemaining: number;
  elapsedMs: number;
  autoExpandedCount: number;
}

export interface PdnResult {
  entities: EntityInstance[];
  addedPoles: number;
  totalPoles: number;
  componentsBefore: number;
  componentsAfter: number;
}

export type DrcCode =
  | 'COLLISION'
  | 'UNDERGROUND_PAIR'
  | 'NO_BELT_WEAVING'
  | 'INSERTER_VALID'
  | 'NO_SIDE_LOAD_CONTAMINATION'
  | 'POWER_COVERAGE'
  | 'POWER_CONNECTIVITY'
  | 'DIE_BOUNDS'
  | 'UNROUTED_NET';

export interface DrcViolation {
  id: string;
  code: DrcCode;
  severity: 'error' | 'warning';
  message: string;
  tx: number;
  ty: number;
  entityIds: string[];
}

export interface DrcReport {
  passed: boolean;
  errorCount: number;
  warningCount: number;
  violations: DrcViolation[];
}

export interface StaNetReport {
  netId: string;
  item: string;
  ratePerSec: number;
  capacityPerSec: number;
  utilization: number;
  leftRatePerSec?: number;
  rightRatePerSec?: number;
  laneUtilization?: number;
  beltTier: BeltTier;
  passed: boolean;
}

export interface StaMacroReport {
  macroId: string;
  label: string;
  machineCount: number;
  exactMachines: number;
  utilization: number;
  outputLeftPerSec?: number;
  outputRightPerSec?: number;
  inserterOk: boolean;
  laneOk: boolean;
  issues: string[];
}

export interface StaReport {
  passed: boolean;
  maxUtilization: number;
  bottlenecks: string[];
  nets: StaNetReport[];
  macros: StaMacroReport[];
}

export interface PipelineProgress {
  stage: 'synth' | 'floorplan' | 'route' | 'pdn' | 'signoff' | 'done';
  message: string;
  iteration?: number;
  maxIterations?: number;
  conflicts?: number;
  elapsedMs?: number;
}

export interface PipelineResult {
  spec: DesignSpec;
  synthesis: SynthesisResult;
  floorplan: FloorplanResult;
  route: RouteResult;
  pdn: PdnResult;
  allEntities: EntityInstance[];
  drc: DrcReport;
  sta: StaReport;
  bom: BomSummary;
  blueprintString: string;
  elapsedMs: number;
}
