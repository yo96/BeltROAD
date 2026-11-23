import {
  AllInserterKind,
  CompiledMacro,
  Dir,
  EntityInstance,
  InserterTier,
  MacroPin,
  PdkConfig,
  QualityTier,
  RecipeMacroSpec,
} from '../types.js';
import {
  BELT_SPECS,
  INSERTER_SPECS,
  MACHINE_SPECS,
  POLE_SPECS,
  QUALITY_SPECS,
  effectiveBeltCapacity,
} from '../data/entities.js';
import { getCatalog } from '../data/catalog.js';
import { pinOutsideOffset } from './transform.js';

function selectInserterKind(
  ratePerSlotOrMach: number,
  reach: 1 | 2,
  pdk: PdkConfig,
  maxSlots = 3,
  preferStack = false,
): { kind: AllInserterKind; count: number } {
  if (reach === 2) {
    const spec = INSERTER_SPECS.long;
    const count = Math.min(maxSlots, Math.max(1, Math.ceil(ratePerSlotOrMach / spec.itemsPerSec)));
    return { kind: 'long', count };
  }

  const tierOrder: InserterTier[] = ['yellow', 'fast', 'bulk', 'stack'];
  const allowed = tierOrder.filter((t) => pdk.allowedInserterTiers.includes(t));
  const pool: InserterTier[] = allowed.length > 0 ? allowed : [pdk.defaultInserterTier];
  if (preferStack && pool.includes('stack')) {
    const stackCount = Math.min(
      maxSlots,
      Math.max(1, Math.ceil(ratePerSlotOrMach / INSERTER_SPECS.stack.itemsPerSec)),
    );
    return { kind: 'stack', count: stackCount };
  }
  const defIdx = Math.max(0, pool.indexOf(pdk.defaultInserterTier));

  for (let i = defIdx; i < pool.length; i++) {
    const k = pool[i];
    if (INSERTER_SPECS[k].itemsPerSec + 1e-6 >= ratePerSlotOrMach) {
      return { kind: k, count: 1 };
    }
  }
  const fastest = pool[pool.length - 1];
  const count = Math.min(
    maxSlots,
    Math.max(1, Math.ceil(ratePerSlotOrMach / INSERTER_SPECS[fastest].itemsPerSec)),
  );
  return { kind: fastest, count };
}

function qualityPrefix(quality?: QualityTier): string {
  return quality && quality !== 'normal' ? `${QUALITY_SPECS[quality].label} ` : '';
}

function createBuilder(spec: RecipeMacroSpec, pdk: PdkConfig) {
  const beltSpec = BELT_SPECS[spec.beltTier];
  const poleSpec = POLE_SPECS[pdk.defaultPoleTier];
  const entities: EntityInstance[] = [];
  const pins: MacroPin[] = [];
  const placedPoles = new Set<string>();
  let seq = 0;
  const eid = (prefix: string) => `${spec.id}:di:${prefix}:${seq++}`;

  const mkBelt = (
    tx: number,
    ty: number,
    direction: Dir,
    item?: string,
    intentionalSideLoad?: boolean,
    laneItems?: [string, string],
  ) => {
    entities.push({
      id: eid('b'),
      name: beltSpec.beltName,
      tx,
      ty,
      w: 1,
      h: 1,
      direction,
      macroId: spec.id,
      item,
      laneItems,
      intentionalSideLoad,
      role: 'belt-macro',
    });
  };

  const mkUg = (
    tx: number,
    ty: number,
    direction: Dir,
    ugType: 'input' | 'output',
    item?: string,
  ) => {
    entities.push({
      id: eid('u'),
      name: beltSpec.undergroundName,
      tx,
      ty,
      w: 1,
      h: 1,
      direction,
      type: ugType,
      macroId: spec.id,
      item,
      role: 'ug-macro',
    });
  };

  const mkSplitter = (tx: number, ty: number, direction: Dir) => {
    entities.push({
      id: eid('sp'),
      name: beltSpec.splitterName,
      tx,
      ty,
      w: direction === Dir.EAST || direction === Dir.WEST ? 1 : 2,
      h: direction === Dir.EAST || direction === Dir.WEST ? 2 : 1,
      direction,
      macroId: spec.id,
      role: 'splitter-macro',
    });
  };

  const mkIns = (
    tx: number,
    ty: number,
    direction: Dir,
    kind: AllInserterKind,
    role: 'inserter-in' | 'inserter-out' | 'inserter-direct',
    item?: string,
  ) => {
    entities.push({
      id: eid(role === 'inserter-direct' ? 'id' : role === 'inserter-out' ? 'io' : 'ii'),
      name: INSERTER_SPECS[kind].name,
      tx,
      ty,
      w: 1,
      h: 1,
      direction,
      macroId: spec.id,
      item,
      role,
    });
  };

  const mkMach = (
    tx: number,
    ty: number,
    size: number,
    name: string,
    recipeId: string,
    outputItem: string,
    modules: typeof spec.modules,
  ) => {
    entities.push({
      id: eid('m'),
      name,
      tx,
      ty,
      w: size,
      h: size,
      direction: Dir.NORTH,
      recipe: recipeId,
      quality: spec.quality,
      items: modules.length > 0 ? [...modules] : undefined,
      macroId: spec.id,
      item: outputItem,
      role: 'machine',
    });
  };

  const mkPole = (tx: number, ty: number) => {
    const key = `${tx},${ty}`;
    if (placedPoles.has(key)) return;
    placedPoles.add(key);
    entities.push({
      id: eid('p'),
      name: poleSpec.name,
      tx,
      ty,
      w: poleSpec.size,
      h: poleSpec.size,
      direction: Dir.NORTH,
      macroId: spec.id,
      role: 'pole-macro',
    });
  };

  const addInPin = (item: string, ratePerSec: number, x: number, y: number, dir: Dir) => {
    const out = pinOutsideOffset(x, y, dir, 'input');
    pins.push({
      id: `in:${item}`,
      item,
      direction: dir,
      kind: 'input',
      x,
      y,
      portX: out.portX,
      portY: out.portY,
      ratePerSec,
      beltTier: spec.beltTier,
    });
  };

  const addOutPin = (x: number, y: number) => {
    const out = pinOutsideOffset(x, y, Dir.EAST, 'output');
    pins.push({
      id: `out:${spec.outputItem}`,
      item: spec.outputItem,
      direction: Dir.EAST,
      kind: 'output',
      x,
      y,
      portX: out.portX,
      portY: out.portY,
      ratePerSec: spec.outputRatePerSec,
      beltTier: spec.beltTier,
    });
  };

  const emitOutputTailAndJog = (opts: {
    yOut: number;
    hasMidJog: boolean;
    gx: number;
    jogDir: 'north' | 'south';
    hasTailSplitter: boolean;
    endX: number;
    width: number;
  }) => {
    const { yOut, hasMidJog, gx, jogDir, hasTailSplitter, endX, width } = opts;
    if (hasMidJog) {
      const ySide = jogDir === 'north' ? yOut - 1 : yOut + 1;
      const toSide = jogDir === 'north' ? Dir.NORTH : Dir.SOUTH;
      const toMain = jogDir === 'north' ? Dir.SOUTH : Dir.NORTH;
      mkBelt(gx, yOut, toSide, spec.outputItem);
      mkBelt(gx, ySide, Dir.EAST, spec.outputItem);
      mkBelt(gx + 1, ySide, Dir.EAST, spec.outputItem);
      mkBelt(gx + 2, ySide, toMain, spec.outputItem);
      mkBelt(gx + 2, yOut, Dir.EAST, spec.outputItem, true);
    }

    if (hasTailSplitter) {
      if (jogDir === 'north') {
        const ySide = yOut - 1;
        mkSplitter(endX, ySide, Dir.EAST);
        mkBelt(endX + 1, ySide, Dir.SOUTH, spec.outputItem);
        mkBelt(endX + 1, yOut, Dir.EAST, spec.outputItem, true);
      } else {
        const ySide = yOut + 1;
        mkSplitter(endX, yOut, Dir.EAST);
        mkBelt(endX + 1, ySide, Dir.NORTH, spec.outputItem);
        mkBelt(endX + 1, yOut, Dir.EAST, spec.outputItem, true);
      }
      for (let x = endX + 2; x < width; x++) {
        mkBelt(x, yOut, Dir.EAST, spec.outputItem);
      }
    } else {
      for (let x = endX; x < width; x++) {
        mkBelt(x, yOut, Dir.EAST, spec.outputItem);
      }
    }
    addOutPin(width - 1, yOut);
  };

  const finalize = (width: number, height: number, sublabel: string): CompiledMacro => {
    const catalog = getCatalog();
    const recipe = catalog.recipesById[spec.recipeId];
    const powerTargets = entities
      .filter(
        (e) =>
          e.role === 'machine' ||
          e.role === 'inserter-in' ||
          e.role === 'inserter-out' ||
          e.role === 'inserter-direct',
      )
      .map((e) => ({ tx: e.tx, ty: e.ty, w: e.w, h: e.h }));

    return {
      id: spec.id,
      kind: 'recipe-macro',
      label: recipe?.name ?? spec.outputItem,
      sublabel,
      recipeId: spec.recipeId,
      outputItem: spec.outputItem,
      rows: 1,
      width,
      height,
      rotation: 0,
      entities,
      pins,
      powerTargets,
    };
  };

  return {
    beltSpec,
    poleSpec,
    mkBelt,
    mkUg,
    mkSplitter,
    mkIns,
    mkMach,
    mkPole,
    addInPin,
    emitOutputTailAndJog,
    finalize,
  };
}

/**
 * 3:2 direct-insertion compound macro (e.g. 3 copper-cable -> 2 electronic-circuit).
 * Producer row y=2..4 (units at [0..2],[3..5],[6..8]), direct strip y=5,
 * consumer row y=6..8 (units at [1..3],[5..7]), output belt y=10, iron belt y=11.
 */
function build3To2Macro(spec: RecipeMacroSpec, pdk: PdkConfig): CompiledMacro {
  const di = spec.directInsert!;
  const b = createBuilder(spec, pdk);
  const preferStack = (pdk.beltStackSize ?? 1) > 1;
  const unitW = 10;
  const unitCount = di.unitCount;
  const hasMidJog = Boolean(spec.balanceOutputLanes && unitCount >= 2);
  const hasTailSplitter = Boolean(!hasMidJog && spec.balanceOutputLanes && unitCount === 1);
  const midUnit = Math.floor(unitCount / 2);
  const gx = hasMidJog ? midUnit * unitW : -1;
  const unitX = (u: number) => u * unitW + (hasMidJog && u >= midUnit ? 3 : 0);
  const endX = unitX(unitCount);
  const tailW = hasTailSplitter ? 2 : 0;
  const width = endX + tailW + 1;
  const height = 12;

  const yProdIn = 0;
  const yInsN = 1;
  const yProdMach = 2;
  const yDirect = 5;
  const yConsMach = 6;
  const yInsS = 9;
  const yOut = 10;
  const yIronS = 11;

  const prodIn = di.producerInputs[0];
  const consExtra = di.consumerExtraInputs[0];
  const prodCount = unitCount * di.producerMachinesPerUnit;
  const consCount = unitCount * di.consumerMachinesPerUnit;

  const ccInIns = prodIn
    ? selectInserterKind(prodIn.ratePerSec / prodCount, 1, pdk, 2)
    : null;
  const directKind = selectInserterKind(di.intermediateRatePerSec / (unitCount * 6), 1, pdk, 1).kind;
  const outIns = selectInserterKind(
    spec.outputRatePerSec / consCount,
    1,
    pdk,
    2,
    preferStack,
  );
  const ironIns = consExtra
    ? selectInserterKind(consExtra.ratePerSec / consCount, 2, pdk, 2)
    : null;

  let maxNorthX = 0;
  let maxSouthX = 0;

  for (let u = 0; u < unitCount; u++) {
    const ux = unitX(u);
    const prodFreeSlots = [
      [ux + 1, ux + 2],
      [ux + 3, ux + 5],
      [ux + 6, ux + 7],
    ];
    for (let c = 0; c < 3; c++) {
      b.mkMach(
        ux + c * 3,
        yProdMach,
        3,
        di.producerMachineName,
        di.producerRecipeId,
        di.intermediateItem,
        di.producerModules,
      );
      if (ccInIns && prodIn) {
        const slots = prodFreeSlots[c];
        for (let i = 0; i < ccInIns.count && i < slots.length; i++) {
          const ix = slots[i];
          if (ix > maxNorthX) maxNorthX = ix;
          b.mkIns(ix, yInsN, Dir.NORTH, ccInIns.kind, 'inserter-in', prodIn.item);
        }
      }
    }

    for (const dx of [1, 2, 3, 5, 6, 7]) {
      b.mkIns(ux + dx, yDirect, Dir.NORTH, directKind, 'inserter-direct', di.intermediateItem);
    }

    for (const mx of [ux + 1, ux + 5]) {
      b.mkMach(
        mx,
        yConsMach,
        3,
        spec.machineName,
        spec.recipeId,
        spec.outputItem,
        spec.modules,
      );
      const outCount = Math.min(2, outIns.count);
      for (let i = 0; i < outCount; i++) {
        b.mkIns(mx + i, yInsS, Dir.NORTH, outIns.kind, 'inserter-out', spec.outputItem);
      }
      if (ironIns && consExtra) {
        const ironCount = Math.min(3 - outCount, ironIns.count);
        for (let i = 0; i < ironCount; i++) {
          const ix = mx + 2 - i;
          if (ix > maxSouthX) maxSouthX = ix;
          b.mkIns(ix, yInsS, Dir.SOUTH, ironIns.kind, 'inserter-in', consExtra.item);
        }
      }
    }

    for (let x = ux; x < ux + unitW; x++) {
      b.mkBelt(x, yOut, Dir.EAST, spec.outputItem);
    }

    if (b.poleSpec.name === 'substation') {
      b.mkPole(ux + 8, yConsMach);
    } else {
      for (const py of [yInsN, yDirect, yInsS]) {
        for (const px of [ux + 0, ux + 4, ux + 8]) {
          b.mkPole(px, py);
        }
      }
    }
  }

  if (hasMidJog && b.poleSpec.name !== 'substation') {
    b.mkPole(gx + 1, yDirect);
  }

  if (prodIn) {
    const northEnd = Math.min(endX, maxNorthX + 1);
    for (let x = 0; x < northEnd; x++) {
      b.mkBelt(x, yProdIn, Dir.EAST, prodIn.item);
    }
    b.addInPin(prodIn.item, prodIn.ratePerSec, 0, yProdIn, Dir.EAST);
  }

  if (consExtra) {
    const southEnd = Math.min(endX, maxSouthX + 1);
    for (let x = 0; x < southEnd; x++) {
      b.mkBelt(x, yIronS, Dir.EAST, consExtra.item);
    }
    b.addInPin(consExtra.item, consExtra.ratePerSec, 0, yIronS, Dir.EAST);
  }

  b.emitOutputTailAndJog({
    yOut,
    hasMidJog,
    gx,
    jogDir: 'north',
    hasTailSplitter,
    endX,
    width,
  });

  return b.finalize(
    width,
    height,
    `${prodCount}:${consCount} ${qualityPrefix(spec.quality)}3:2 Direct`,
  );
}

/**
 * 1:2 direct-insertion compound macro (e.g. 1 iron-stick -> 2 rail).
 * Producer Stick at [2..4, y=2..4], direct & output inserters y=5,
 * Rail output belt tunnels under Stick along y=4 (UG across [1..5]),
 * Rail0 [0..2, y=6..8], Rail1 [4..6, y=6..8], dual-lane stone+steel input y=10.
 */
function build1To2Macro(spec: RecipeMacroSpec, pdk: PdkConfig): CompiledMacro {
  const di = spec.directInsert!;
  const b = createBuilder(spec, pdk);
  const preferStack = (pdk.beltStackSize ?? 1) > 1;
  const xStart = 2;
  const unitW = 8;
  const unitCount = di.unitCount;
  const hasMidJog = Boolean(spec.balanceOutputLanes && unitCount >= 2);
  const hasTailSplitter = Boolean(!hasMidJog && spec.balanceOutputLanes && unitCount === 1);
  const midUnit = Math.floor(unitCount / 2);
  const gx = hasMidJog ? xStart + midUnit * unitW : -1;
  const unitX = (u: number) => xStart + u * unitW + (hasMidJog && u >= midUnit ? 3 : 0);
  const endX = unitX(unitCount);
  const tailW = hasTailSplitter ? 2 : 0;
  const width = endX + tailW + 1;
  const height = 12;

  const yProdIn = 0;
  const yInsN = 1;
  const yProdMach = 2;
  const yOut = 4;
  const yDirect = 5;
  const yConsMach = 6;
  const yInsS = 9;
  const yExtraS = 10;

  const prodIn = di.producerInputs[0];
  const extraA = di.consumerExtraInputs[0];
  const extraB = di.consumerExtraInputs[1];
  const prodCount = unitCount * di.producerMachinesPerUnit;
  const consCount = unitCount * di.consumerMachinesPerUnit;

  const prodIns = prodIn
    ? selectInserterKind(prodIn.ratePerSec / prodCount, 1, pdk, 2)
    : null;
  const directKind = selectInserterKind(di.intermediateRatePerSec / consCount, 1, pdk, 1).kind;
  const outIns = selectInserterKind(
    spec.outputRatePerSec / consCount,
    1,
    pdk,
    2,
    preferStack,
  );
  const extraRateTotal = di.consumerExtraInputs.reduce((acc, i) => acc + i.ratePerSec, 0);
  const extraIns =
    extraRateTotal > 0 ? selectInserterKind(extraRateTotal / consCount, 1, pdk, 3) : null;

  let maxNorthX = xStart;
  let maxSouthX = xStart;

  if (b.poleSpec.name !== 'substation') {
    b.mkPole(1, yDirect);
    b.mkPole(1, yConsMach + 2);
  }

  for (let u = 0; u < unitCount; u++) {
    const ux = unitX(u);
    b.mkMach(
      ux + 2,
      yProdMach,
      3,
      di.producerMachineName,
      di.producerRecipeId,
      di.intermediateItem,
      di.producerModules,
    );

    if (prodIns && prodIn) {
      const nSlots = [ux + 2, ux + 4];
      for (let i = 0; i < prodIns.count && i < nSlots.length; i++) {
        const ix = nSlots[i];
        if (ix > maxNorthX) maxNorthX = ix;
        b.mkIns(ix, yInsN, Dir.NORTH, prodIns.kind, 'inserter-in', prodIn.item);
      }
    }

    // Rail0 and Rail1 consumers
    b.mkMach(ux + 0, yConsMach, 3, spec.machineName, spec.recipeId, spec.outputItem, spec.modules);
    b.mkMach(ux + 4, yConsMach, 3, spec.machineName, spec.recipeId, spec.outputItem, spec.modules);

    // Direct inserters Stick -> Rail0 / Rail1
    b.mkIns(ux + 2, yDirect, Dir.NORTH, directKind, 'inserter-direct', di.intermediateItem);
    b.mkIns(ux + 4, yDirect, Dir.NORTH, directKind, 'inserter-direct', di.intermediateItem);

    // Output belt segment along yOut=4 tunneling under Stick [ux+2..ux+4]
    b.mkBelt(ux + 0, yOut, Dir.EAST, spec.outputItem);
    b.mkUg(ux + 1, yOut, Dir.EAST, 'input', spec.outputItem);
    b.mkUg(ux + 5, yOut, Dir.EAST, 'output', spec.outputItem);
    b.mkBelt(ux + 6, yOut, Dir.EAST, spec.outputItem);
    b.mkBelt(ux + 7, yOut, Dir.EAST, spec.outputItem);

    // Rail output inserters dropping NORTH from machine to yOut (Dir.SOUTH)
    const r0OutSlots = [ux + 1, ux + 0];
    const r1OutSlots = [ux + 5, ux + 6];
    for (let i = 0; i < Math.min(2, outIns.count); i++) {
      b.mkIns(r0OutSlots[i], yDirect, Dir.SOUTH, outIns.kind, 'inserter-out', spec.outputItem);
      b.mkIns(r1OutSlots[i], yDirect, Dir.SOUTH, outIns.kind, 'inserter-out', spec.outputItem);
    }

    if (extraIns) {
      for (const sOffset of [0, 1, 2].slice(0, extraIns.count)) {
        const ix0 = ux + sOffset;
        const ix1 = ux + 4 + sOffset;
        if (ix1 > maxSouthX) maxSouthX = ix1;
        b.mkIns(ix0, yInsS, Dir.SOUTH, extraIns.kind, 'inserter-in');
        b.mkIns(ix1, yInsS, Dir.SOUTH, extraIns.kind, 'inserter-in');
      }
    }

    if (b.poleSpec.name === 'substation') {
      b.mkPole(ux + 0, yProdMach);
    } else {
      for (const py of [yInsN, yDirect, yInsS]) {
        b.mkPole(ux + 3, py);
        b.mkPole(ux + 7, py);
      }
    }
  }

  if (hasMidJog && b.poleSpec.name !== 'substation') {
    b.mkPole(gx + 1, yInsN);
    b.mkPole(gx + 1, yInsS);
  }

  if (prodIn) {
    const northEnd = Math.min(endX, maxNorthX + 1);
    for (let x = 0; x < northEnd; x++) {
      b.mkBelt(x, yProdIn, Dir.EAST, prodIn.item);
    }
    b.addInPin(prodIn.item, prodIn.ratePerSec, 0, yProdIn, Dir.EAST);
  }

  const southEnd = Math.min(endX, maxSouthX + 1);
  if (extraA && extraB) {
    const lanes: [string, string] = [extraA.item, extraB.item];
    b.mkBelt(0, yExtraS - 1, Dir.EAST, extraA.item);
    b.addInPin(extraA.item, extraA.ratePerSec, 0, yExtraS - 1, Dir.EAST);
    b.mkBelt(1, yExtraS - 1, Dir.SOUTH, extraA.item);

    b.mkBelt(0, yExtraS + 1, Dir.EAST, extraB.item);
    b.addInPin(extraB.item, extraB.ratePerSec, 0, yExtraS + 1, Dir.EAST);
    b.mkBelt(1, yExtraS + 1, Dir.NORTH, extraB.item);

    b.mkBelt(1, yExtraS, Dir.EAST, undefined, true, lanes);
    for (let x = xStart; x < southEnd; x++) {
      b.mkBelt(x, yExtraS, Dir.EAST, undefined, false, lanes);
    }
  } else if (extraA) {
    for (let x = 0; x < southEnd; x++) {
      b.mkBelt(x, yExtraS, Dir.EAST, extraA.item);
    }
    b.addInPin(extraA.item, extraA.ratePerSec, 0, yExtraS, Dir.EAST);
  }

  b.emitOutputTailAndJog({
    yOut,
    hasMidJog,
    gx,
    jogDir: 'south',
    hasTailSplitter,
    endX,
    width,
  });

  return b.finalize(
    width,
    height,
    `${prodCount}:${consCount} ${qualityPrefix(spec.quality)}1:2 Direct`,
  );
}

/**
 * 1:1 Space Age Electromagnetic Plant compound macro (4x4 CC -> 4x4 EC).
 * Uses a 3-tile side aisle per unit for zig-zag iron-plate undergrounds (diff=5).
 */
function build1To1EmMacro(spec: RecipeMacroSpec, pdk: PdkConfig): CompiledMacro {
  const di = spec.directInsert!;
  const b = createBuilder(spec, pdk);
  const preferStack = (pdk.beltStackSize ?? 1) > 1;
  const xStart = 2;
  const unitW = 7;
  const unitCount = di.unitCount;
  const hasMidJog = Boolean(spec.balanceOutputLanes && unitCount >= 2);
  const hasTailSplitter = Boolean(!hasMidJog && spec.balanceOutputLanes && unitCount === 1);
  const midUnit = Math.floor(unitCount / 2);
  const gx = hasMidJog ? xStart + midUnit * unitW : -1;
  const unitX = (u: number) => xStart + u * unitW + (hasMidJog && u >= midUnit ? 3 : 0);
  const endX = unitX(unitCount);
  const tailW = hasTailSplitter ? 2 : 0;
  const width = endX + tailW + 1;
  const height = 13;

  const yProdIn = 0;
  const yInsN = 1;
  const yProdMach = 2;
  const yDirect = 6;
  const yConsMach = 7;
  const yInsS = 11;
  const yOut = 12;

  const prodIn = di.producerInputs[0];
  const consExtra = di.consumerExtraInputs[0];
  const isSubstation = b.poleSpec.name === 'substation';
  const freeOffsets = isSubstation ? [0, 1, 2, 3] : [0, 2, 3];

  const ccInIns = prodIn
    ? selectInserterKind(prodIn.ratePerSec / unitCount, 1, pdk, freeOffsets.length)
    : null;
  const directIns = selectInserterKind(
    di.intermediateRatePerSec / unitCount,
    1,
    pdk,
    freeOffsets.length,
  );
  const outIns = selectInserterKind(
    spec.outputRatePerSec / unitCount,
    1,
    pdk,
    freeOffsets.length,
    preferStack,
  );
  const ironIns = consExtra
    ? selectInserterKind(consExtra.ratePerSec / unitCount, 1, pdk, 2)
    : null;

  let maxNorthX = xStart;

  // Iron input West header tunneling under unit 0
  if (consExtra) {
    b.mkBelt(0, yConsMach, Dir.EAST, consExtra.item);
    b.addInPin(consExtra.item, consExtra.ratePerSec, 0, yConsMach, Dir.EAST);
    b.mkUg(1, yConsMach, Dir.EAST, 'input', consExtra.item);
  }

  for (let u = 0; u < unitCount; u++) {
    const ux = unitX(u);
    b.mkMach(
      ux,
      yProdMach,
      4,
      di.producerMachineName,
      di.producerRecipeId,
      di.intermediateItem,
      di.producerModules,
    );
    b.mkMach(
      ux,
      yConsMach,
      4,
      spec.machineName,
      spec.recipeId,
      spec.outputItem,
      spec.modules,
    );

    if (ccInIns && prodIn) {
      for (let i = 0; i < ccInIns.count && i < freeOffsets.length; i++) {
        const ix = ux + freeOffsets[i];
        if (ix > maxNorthX) maxNorthX = ix;
        b.mkIns(ix, yInsN, Dir.NORTH, ccInIns.kind, 'inserter-in', prodIn.item);
      }
    }

    for (let i = 0; i < directIns.count && i < freeOffsets.length; i++) {
      b.mkIns(
        ux + freeOffsets[i],
        yDirect,
        Dir.NORTH,
        directIns.kind,
        'inserter-direct',
        di.intermediateItem,
      );
    }

    for (let i = 0; i < outIns.count && i < freeOffsets.length; i++) {
      b.mkIns(
        ux + freeOffsets[i],
        yInsS,
        Dir.NORTH,
        outIns.kind,
        'inserter-out',
        spec.outputItem,
      );
    }

    // Iron-plate zig-zag aisle [ux+4, ux+5, ux+6] across y=7..10
    if (consExtra && ironIns) {
      const even = u % 2 === 0;
      const yIn = even ? yConsMach : yConsMach + 3;
      const yExit = even ? yConsMach + 3 : yConsMach;
      const vDir = even ? Dir.SOUTH : Dir.NORTH;

      b.mkUg(ux + 4, yIn, Dir.EAST, 'output', consExtra.item);
      b.mkBelt(ux + 5, yIn, vDir, consExtra.item);
      b.mkBelt(ux + 5, yConsMach + 1, vDir, consExtra.item);
      b.mkBelt(ux + 5, yConsMach + 2, vDir, consExtra.item);
      b.mkBelt(ux + 5, yExit, Dir.EAST, consExtra.item);

      const ironYs = [yConsMach + 1, yConsMach + 2];
      for (let i = 0; i < ironIns.count && i < ironYs.length; i++) {
        b.mkIns(ux + 4, ironYs[i], Dir.EAST, ironIns.kind, 'inserter-in', consExtra.item);
      }

      if (u < unitCount - 1) {
        if (hasMidJog && u === midUnit - 1) {
          b.mkBelt(ux + 6, yExit, Dir.EAST, consExtra.item);
          b.mkBelt(gx, yExit, Dir.EAST, consExtra.item);
          b.mkBelt(gx + 1, yExit, Dir.EAST, consExtra.item);
          b.mkUg(gx + 2, yExit, Dir.EAST, 'input', consExtra.item);
        } else {
          b.mkUg(ux + 6, yExit, Dir.EAST, 'input', consExtra.item);
        }
      }
    }

    for (let x = ux; x < ux + unitW; x++) {
      b.mkBelt(x, yOut, Dir.EAST, spec.outputItem);
    }

    if (isSubstation) {
      b.mkPole(ux + 4, yProdMach);
    } else {
      for (const py of [yInsN, yDirect, yInsS]) {
        b.mkPole(ux + 1, py);
        b.mkPole(ux + 4, py);
      }
    }
  }

  if (hasMidJog && !isSubstation) {
    b.mkPole(gx + 1, yDirect);
  }

  if (prodIn) {
    const northEnd = Math.min(endX, maxNorthX + 1);
    for (let x = 0; x < northEnd; x++) {
      b.mkBelt(x, yProdIn, Dir.EAST, prodIn.item);
    }
    b.addInPin(prodIn.item, prodIn.ratePerSec, 0, yProdIn, Dir.EAST);
  }

  // Fill output belt across left header [0..xStart-1] so tail connects cleanly to first unit?
  // Note: units cover [xStart..endX-1] cleanly; leave [0..xStart-1] free unless needed.
  void effectiveBeltCapacity;

  b.emitOutputTailAndJog({
    yOut,
    hasMidJog,
    gx,
    jogDir: 'north',
    hasTailSplitter,
    endX,
    width,
  });

  return b.finalize(
    width,
    height,
    `${unitCount}:${unitCount} ${qualityPrefix(spec.quality)}EM 1:1 Direct`,
  );
}

export function compileDirectInsertMacro(
  spec: RecipeMacroSpec,
  pdk: PdkConfig,
): CompiledMacro[] {
  const di = spec.directInsert;
  if (!di) {
    throw new Error(`compileDirectInsertMacro called without directInsert on ${spec.id}`);
  }
  if (di.ratio === '3:2') {
    return [build3To2Macro(spec, pdk)];
  }
  if (di.ratio === '1:2') {
    return [build1To2Macro(spec, pdk)];
  }
  return [build1To1EmMacro(spec, pdk)];
}
