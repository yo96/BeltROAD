import {
  AllInserterKind,
  CompiledMacro,
  Dir,
  EntityInstance,
  InserterTier,
  MacroPin,
  PdkConfig,
  RecipeMacroSpec,
} from '../types.js';
import {
  BELT_SPECS,
  INSERTER_SPECS,
  MACHINE_SPECS,
  POLE_SPECS,
  PoleSpec,
  doesPoleSupplyEntity,
} from '../data/entities.js';
import { getCatalog } from '../data/catalog.js';
import { pinOutsideOffset } from './transform.js';

interface IngredientTrack {
  items: { item: string; ratePerSec: number }[];
  isDualLane: boolean;
}

function selectInserterKind(
  ratePerMachine: number,
  reach: 1 | 2,
  pdk: PdkConfig,
): { kind: AllInserterKind; count: number } {
  if (reach === 2) {
    const spec = INSERTER_SPECS.long;
    const count = Math.min(2, Math.max(1, Math.ceil(ratePerMachine / spec.itemsPerSec)));
    return { kind: 'long', count };
  }

  const tierOrder: InserterTier[] = ['yellow', 'fast', 'bulk'];
  const allowed = tierOrder.filter((t) => pdk.allowedInserterTiers.includes(t));
  const pool: InserterTier[] = allowed.length > 0 ? allowed : [pdk.defaultInserterTier];
  const defIdx = Math.max(0, pool.indexOf(pdk.defaultInserterTier));

  for (let i = defIdx; i < pool.length; i++) {
    const k = pool[i];
    if (INSERTER_SPECS[k].itemsPerSec + 1e-6 >= ratePerMachine) {
      return { kind: k, count: 1 };
    }
  }
  const fastest = pool[pool.length - 1];
  const count = Math.min(3, Math.max(1, Math.ceil(ratePerMachine / INSERTER_SPECS[fastest].itemsPerSec)));
  return { kind: fastest, count };
}

function assignTracks(spec: RecipeMacroSpec): {
  northFar: IngredientTrack | null;
  northNear: IngredientTrack | null;
  southFar: IngredientTrack | null;
} {
  // Sort highest throughput ingredients first so they sit on reach-1 (northNear) tracks
  const ings = [...spec.ingredientRates].sort((a, b) => b.ratePerSec - a.ratePerSec);
  const cap = BELT_SPECS[spec.beltTier].itemsPerSec;
  const tracks: IngredientTrack[] = [];

  if (ings.length <= 2) {
    for (const ing of ings) {
      tracks.push({ items: [{ item: ing.item, ratePerSec: ing.ratePerSec }], isDualLane: false });
    }
  } else {
    const full: typeof ings = [];
    const half: typeof ings = [];
    for (const ing of ings) {
      if (ing.ratePerSec > 0.48 * cap) full.push(ing);
      else half.push(ing);
    }
    for (const f of full) {
      tracks.push({ items: [{ item: f.item, ratePerSec: f.ratePerSec }], isDualLane: false });
    }
    for (let i = 0; i < half.length; i += 2) {
      if (i + 1 < half.length) {
        tracks.push({
          items: [
            { item: half[i].item, ratePerSec: half[i].ratePerSec },
            { item: half[i + 1].item, ratePerSec: half[i + 1].ratePerSec },
          ],
          isDualLane: true,
        });
      } else {
        tracks.push({
          items: [{ item: half[i].item, ratePerSec: half[i].ratePerSec }],
          isDualLane: false,
        });
      }
    }
  }

  if (tracks.length === 0) {
    return { northFar: null, northNear: null, southFar: null };
  }
  if (tracks.length === 1) {
    return { northFar: null, northNear: tracks[0], southFar: null };
  }
  if (tracks.length === 2) {
    // Highest-rate track goes to northNear (reach 1); lower-rate goes to northFar (reach 2)
    return { northFar: tracks[1], northNear: tracks[0], southFar: null };
  }
  return {
    northFar: tracks[1],
    northNear: tracks[0],
    southFar: tracks[2],
  };
}

interface MachineRowGeometry {
  machineXs: number[];
  poleXs: number[];
  substationXs: number[];
  endX: number;
  laneFlipX?: number;
}

function layoutSegmentSubstations(
  startX: number,
  count: number,
  poleSpec: PoleSpec,
  existingLastSub: number | undefined,
): { machineXs: number[]; substationXs: number[]; endX: number } {
  const machineXs: number[] = [];
  const substationXs: number[] = [];
  let x = startX;
  let lastSub = existingLastSub;
  const firstSubIdx = count <= 4 ? Math.floor(count / 2) : 2;

  for (let i = 0; i < count; i++) {
    const needWireBridge =
      lastSub !== undefined && x + 1 - (lastSub + 1) > poleSpec.wireReach - 4;
    const needCover =
      lastSub === undefined ||
      !doesPoleSupplyEntity(lastSub, 0, poleSpec, x, 0, 1, 1) ||
      !doesPoleSupplyEntity(lastSub, 0, poleSpec, x + 2, 0, 1, 1);

    const periodicSub =
      existingLastSub === undefined
        ? i === firstSubIdx || (i > firstSubIdx && (i - firstSubIdx) % 5 === 0)
        : i > 0 && i % 5 === 0;

    if (periodicSub || needCover || needWireBridge) {
      substationXs.push(x);
      lastSub = x;
      x += 2;
    }
    machineXs.push(x);
    x += 3;
  }

  if (count > 0 && lastSub === undefined) {
    substationXs.push(x);
    lastSub = x;
    x += 2;
  } else if (count > 0 && lastSub !== undefined) {
    const lastMx = machineXs[count - 1];
    if (
      !doesPoleSupplyEntity(lastSub, 0, poleSpec, lastMx, 0, 3, 1) ||
      !doesPoleSupplyEntity(lastSub, 0, poleSpec, lastMx + 2, 0, 1, 1)
    ) {
      substationXs.push(x);
      x += 2;
    }
  }

  return { machineXs, substationXs, endX: x };
}

function layoutMachineRow(
  startX: number,
  machineCount: number,
  northInsertersPerMachine: number,
  southInsertersPerMachine: number,
  pdk: PdkConfig,
  laneFlipAfterIdx?: number,
): MachineRowGeometry {
  const poleSpec = POLE_SPECS[pdk.defaultPoleTier];
  const hasSplit =
    laneFlipAfterIdx !== undefined &&
    laneFlipAfterIdx >= 0 &&
    laneFlipAfterIdx < machineCount - 1;

  if (poleSpec.tier === 'substation') {
    if (!hasSplit) {
      const seg = layoutSegmentSubstations(startX, machineCount, poleSpec, undefined);
      return {
        machineXs: seg.machineXs,
        poleXs: [],
        substationXs: seg.substationXs,
        endX: seg.endX,
      };
    }

    const leftCount = laneFlipAfterIdx + 1;
    const rightCount = machineCount - leftCount;
    const leftSeg = layoutSegmentSubstations(startX, leftCount, poleSpec, undefined);
    const laneFlipX = leftSeg.endX;
    const lastLeftSub = leftSeg.substationXs[leftSeg.substationXs.length - 1];
    const rightSeg = layoutSegmentSubstations(
      laneFlipX + 3,
      rightCount,
      poleSpec,
      lastLeftSub,
    );

    return {
      machineXs: [...leftSeg.machineXs, ...rightSeg.machineXs],
      poleXs: [],
      substationXs: [...leftSeg.substationXs, ...rightSeg.substationXs],
      endX: rightSeg.endX,
      laneFlipX,
    };
  }

  // Small or Medium poles sit on the north & south inserter strips.
  // If any machine needs all 3 slots for inserters on North or South, use stride 4 so poles sit cleanly in the 1-tile gap.
  const needsGap = northInsertersPerMachine >= 3 || southInsertersPerMachine >= 3;
  const stride = needsGap ? 4 : 3;
  const poleOffset = needsGap ? 3 : 2;
  const step = poleSpec.tier === 'small' ? 1 : 2;
  const needSmallStarter = needsGap && poleSpec.tier === 'small' && machineCount > 0;
  const leftMachineStartX = needSmallStarter ? startX + 1 : startX;

  if (!hasSplit) {
    const machineXs: number[] = [];
    for (let i = 0; i < machineCount; i++) {
      machineXs.push(leftMachineStartX + i * stride);
    }
    const endX =
      leftMachineStartX + (machineCount > 0 ? (machineCount - 1) * stride + 3 : 0);

    const poleXs: number[] = [];
    if (needSmallStarter) {
      poleXs.push(startX);
    }
    for (let i = 0; i < machineCount; i += step) {
      poleXs.push(machineXs[i] + poleOffset);
    }
    if (machineCount > 0) {
      const lastMx = machineXs[machineCount - 1];
      const coveredLast = poleXs.some(
        (px) =>
          doesPoleSupplyEntity(px, 0, poleSpec, lastMx, 0, 3, 1) &&
          doesPoleSupplyEntity(px, 0, poleSpec, lastMx + (needsGap ? 2 : 1), 0, 1, 1),
      );
      if (!coveredLast) {
        poleXs.push(lastMx + poleOffset);
      }
    }
    const finalEndX = Math.max(endX, ...poleXs.map((p) => p + 1));
    return { machineXs, poleXs, substationXs: [], endX: finalEndX };
  }

  // Split row around 3-tile mid-row lane-flip jog [laneFlipX .. laneFlipX + 2]
  const leftCount = laneFlipAfterIdx + 1;
  const rightCount = machineCount - leftCount;
  const machineXs: number[] = [];
  const poleXs: number[] = [];
  if (needSmallStarter) {
    poleXs.push(startX);
  }

  for (let i = 0; i < leftCount; i++) {
    machineXs.push(leftMachineStartX + i * stride);
  }
  for (let i = 0; i < leftCount; i += step) {
    poleXs.push(machineXs[i] + poleOffset);
  }
  const lastLeftMx = machineXs[leftCount - 1];
  const lastLeftCovered = poleXs.some(
    (px) =>
      doesPoleSupplyEntity(px, 0, poleSpec, lastLeftMx, 0, 3, 1) &&
      doesPoleSupplyEntity(px, 0, poleSpec, lastLeftMx + (needsGap ? 2 : 1), 0, 1, 1),
  );
  if (!lastLeftCovered) {
    poleXs.push(lastLeftMx + poleOffset);
  }

  const laneFlipX = lastLeftMx + (needsGap ? 4 : 3);
  let rightStartX = laneFlipX + 3;
  if (needsGap && poleSpec.tier === 'small') {
    // Small pole at laneFlipX + 3 powers the first right machine's leftmost inserter slot & bridges the jog
    poleXs.push(laneFlipX + 3);
    rightStartX = laneFlipX + 4;
  }

  const firstRightPole = rightStartX + poleOffset;
  const lastLeftPole = poleXs[poleXs.length - 1];
  if (firstRightPole - lastLeftPole > poleSpec.wireReach - 0.1) {
    const bridgeLeft = lastLeftMx + poleOffset;
    if (bridgeLeft !== lastLeftPole) {
      poleXs.push(bridgeLeft);
    }
  }

  for (let j = 0; j < rightCount; j++) {
    machineXs.push(rightStartX + j * stride);
  }
  for (let j = 0; j < rightCount; j += step) {
    poleXs.push(machineXs[leftCount + j] + poleOffset);
  }
  const lastRightMx = machineXs[machineCount - 1];
  const lastRightCovered = poleXs.some(
    (px) =>
      doesPoleSupplyEntity(px, 0, poleSpec, lastRightMx, 0, 3, 1) &&
      doesPoleSupplyEntity(px, 0, poleSpec, lastRightMx + (needsGap ? 2 : 1), 0, 1, 1),
  );
  if (!lastRightCovered) {
    poleXs.push(lastRightMx + poleOffset);
  }

  const finalEndX = Math.max(
    lastRightMx + 3,
    ...poleXs.map((p) => p + 1),
  );
  return {
    machineXs,
    poleXs,
    substationXs: [],
    endX: finalEndX,
    laneFlipX,
  };
}

function populateStripEntities(
  entities: EntityInstance[],
  macroId: string,
  spec: RecipeMacroSpec,
  pdk: PdkConfig,
  rowIdx: number,
  xStart: number,
  yMachine: number,
  machineCount: number,
  northFarTrack: IngredientTrack | null,
  northNearTrack: IngredientTrack | null,
  southFarTrack: IngredientTrack | null,
  northFarIns: { kind: AllInserterKind; count: number } | null,
  northNearIns: { kind: AllInserterKind; count: number } | null,
  outIns: { kind: AllInserterKind; count: number },
  southFarIns: { kind: AllInserterKind; count: number } | null,
  geom: MachineRowGeometry,
  trackEndX: number,
): void {
  const hasNorthFar = northFarTrack !== null;
  const hasNorthNear = northNearTrack !== null;
  const hasSouthFar = southFarTrack !== null;
  const trackMeta = (t: IngredientTrack | null) =>
    t
      ? t.items.length === 2
        ? { laneItems: [t.items[0].item, t.items[1].item] as [string, string] }
        : { item: t.items[0]?.item }
      : {};
  const beltSpec = BELT_SPECS[spec.beltTier];
  const poleSpec = POLE_SPECS[pdk.defaultPoleTier];
  const yFarN = yMachine - 3;
  const yNearN = yMachine - 2;
  const yInsN = yMachine - 1;
  const yInsS = yMachine + 3;
  const yOut = yMachine + 4;
  const yFarS = yMachine + 5;

  let uid = 0;
  const eid = (tag: string) => `${macroId}:r${rowIdx}:${tag}:${uid++}`;

  // Machines & Substations
  for (const mx of geom.machineXs) {
    entities.push({
      id: eid('m'),
      name: spec.machineName,
      tx: mx,
      ty: yMachine,
      w: 3,
      h: 3,
      direction: Dir.NORTH,
      recipe: spec.recipeId,
      items: spec.modules.length > 0 ? [...spec.modules] : undefined,
      macroId,
      item: spec.outputItem,
      role: 'machine',
    });
  }

  for (const sx of geom.substationXs) {
    entities.push({
      id: eid('sub'),
      name: poleSpec.name,
      tx: sx,
      ty: yMachine,
      w: 2,
      h: 2,
      direction: Dir.NORTH,
      macroId,
      role: 'pole-macro',
    });
  }

  // Poles along North & South inserter strips
  const poleSet = new Set(geom.poleXs);
  for (const px of geom.poleXs) {
    entities.push({
      id: eid('pn'),
      name: poleSpec.name,
      tx: px,
      ty: yInsN,
      w: 1,
      h: 1,
      direction: Dir.NORTH,
      macroId,
      role: 'pole-macro',
    });
    entities.push({
      id: eid('ps'),
      name: poleSpec.name,
      tx: px,
      ty: yInsS,
      w: 1,
      h: 1,
      direction: Dir.NORTH,
      macroId,
      role: 'pole-macro',
    });
  }

  // Inserters per machine (avoiding pole slots), tracking rightmost input inserter X
  let maxNorthInX = xStart;
  let maxSouthInX = xStart;

  for (const mx of geom.machineXs) {
    const northFree = [mx, mx + 1, mx + 2].filter((x) => !poleSet.has(x));
    let nCursor = 0;
    if (northNearIns) {
      const nearLimit = northFarIns ? Math.max(1, northFree.length - 1) : northFree.length;
      for (let c = 0; c < northNearIns.count && nCursor < nearLimit; c++) {
        const ix = northFree[nCursor++];
        if (ix > maxNorthInX) maxNorthInX = ix;
        entities.push({
          id: eid('inn'),
          name: INSERTER_SPECS[northNearIns.kind].name,
          tx: ix,
          ty: yInsN,
          w: 1,
          h: 1,
          // North strip input inserter picks from North (0) and drops South into machine
          direction: Dir.NORTH,
          macroId,
          role: 'inserter-in',
        });
      }
    }
    if (northFarIns) {
      for (let c = 0; c < northFarIns.count && nCursor < northFree.length; c++) {
        const ix = northFree[nCursor++];
        if (ix > maxNorthInX) maxNorthInX = ix;
        entities.push({
          id: eid('inf'),
          name: INSERTER_SPECS[northFarIns.kind].name,
          tx: ix,
          ty: yInsN,
          w: 1,
          h: 1,
          direction: Dir.NORTH,
          macroId,
          role: 'inserter-in',
        });
      }
    }

    const southFree = [mx, mx + 1, mx + 2].filter((x) => !poleSet.has(x));
    let sCursor = 0;
    for (let c = 0; c < outIns.count && sCursor < southFree.length; c++) {
      entities.push({
        id: eid('out'),
        name: INSERTER_SPECS[outIns.kind].name,
        tx: southFree[sCursor++],
        ty: yInsS,
        w: 1,
        h: 1,
        // Output inserter picks from machine (North = 0) and drops South onto output belt
        direction: Dir.NORTH,
        macroId,
        role: 'inserter-out',
      });
    }
    if (southFarIns) {
      for (let c = 0; c < southFarIns.count && sCursor < southFree.length; c++) {
        const ix = southFree[sCursor++];
        if (ix > maxSouthInX) maxSouthInX = ix;
        entities.push({
          id: eid('isf'),
          name: INSERTER_SPECS[southFarIns.kind].name,
          tx: ix,
          ty: yInsS,
          w: 1,
          h: 1,
          // South far input inserter picks from South (8) and drops North into machine
          direction: Dir.SOUTH,
          macroId,
          role: 'inserter-in',
        });
      }
    }
  }

  // Belt tracks along machine strip (trim input tails right past last input inserter)
  const nfMeta = trackMeta(northFarTrack);
  const nnMeta = trackMeta(northNearTrack);
  const sfMeta = trackMeta(southFarTrack);
  const northInEndX = Math.min(trackEndX, maxNorthInX + 1);
  const southInEndX = Math.min(trackEndX, maxSouthInX + 1);

  for (let x = xStart; x < trackEndX; x++) {
    if (hasNorthFar && x < northInEndX) {
      entities.push({
        id: eid('bnf'),
        name: beltSpec.beltName,
        tx: x,
        ty: yFarN,
        w: 1,
        h: 1,
        direction: Dir.EAST,
        macroId,
        ...nfMeta,
        role: 'belt-macro',
      });
    }
    if (hasNorthNear && x < northInEndX) {
      entities.push({
        id: eid('bnn'),
        name: beltSpec.beltName,
        tx: x,
        ty: yNearN,
        w: 1,
        h: 1,
        direction: Dir.EAST,
        macroId,
        ...nnMeta,
        role: 'belt-macro',
      });
    }
    const gx = geom.laneFlipX;
    let outDir = Dir.EAST;
    let outSideLoad: boolean | undefined;
    if (gx !== undefined) {
      if (x === gx) outDir = Dir.NORTH;
      else if (x === gx + 2) outSideLoad = true;
    }
    entities.push({
      id: eid('bout'),
      name: beltSpec.beltName,
      tx: x,
      ty: yOut,
      w: 1,
      h: 1,
      direction: outDir,
      macroId,
      item: spec.outputItem,
      intentionalSideLoad: outSideLoad,
      role: 'belt-macro',
    });
    if (hasSouthFar && x < southInEndX) {
      entities.push({
        id: eid('bsf'),
        name: beltSpec.beltName,
        tx: x,
        ty: yFarS,
        w: 1,
        h: 1,
        direction: Dir.EAST,
        macroId,
        ...sfMeta,
        role: 'belt-macro',
      });
    }
  }

  if (geom.laneFlipX !== undefined) {
    const gx = geom.laneFlipX;
    entities.push({
      id: eid('lf0'),
      name: beltSpec.beltName,
      tx: gx,
      ty: yInsS,
      w: 1,
      h: 1,
      direction: Dir.EAST,
      macroId,
      item: spec.outputItem,
      role: 'belt-macro',
    });
    entities.push({
      id: eid('lf1'),
      name: beltSpec.beltName,
      tx: gx + 1,
      ty: yInsS,
      w: 1,
      h: 1,
      direction: Dir.EAST,
      macroId,
      item: spec.outputItem,
      role: 'belt-macro',
    });
    entities.push({
      id: eid('lf2'),
      name: beltSpec.beltName,
      tx: gx + 2,
      ty: yInsS,
      w: 1,
      h: 1,
      direction: Dir.SOUTH,
      macroId,
      item: spec.outputItem,
      role: 'belt-macro',
    });
  }
  void machineCount;
}

function buildSingleRowMacro(spec: RecipeMacroSpec, pdk: PdkConfig): CompiledMacro {
  const catalog = getCatalog();
  const recipe = catalog.recipesById[spec.recipeId];
  const beltSpec = BELT_SPECS[spec.beltTier];
  const { northFar, northNear, southFar } = assignTracks(spec);

  const hasDualNorth =
    (northFar?.isDualLane ?? false) || (northNear?.isDualLane ?? false);
  const hasDualSouth = southFar?.isDualLane ?? false;

  const headerW = hasDualNorth ? 5 : hasDualSouth ? 2 : 0;
  const topPad = hasDualNorth ? 1 : 0;
  const northTrackRows = (northFar ? 1 : 0) + (northNear ? 1 : 0);
  const yMachine = topPad + northTrackRows + 1; // +1 for North inserter strip
  const yFarN = yMachine - 3;
  const yNearN = yMachine - 2;
  const yOut = yMachine + 4;
  const yFarS = yMachine + 5;
  const bottomPad = hasDualSouth ? 1 : 0;
  const height = (southFar ? yFarS + 1 : yOut + 1) + bottomPad;

  const M = spec.machineCount;
  const northFarIns = northFar
    ? selectInserterKind(
        northFar.items.reduce((a, b) => a + b.ratePerSec, 0) / M,
        2,
        pdk,
      )
    : null;
  const northNearIns = northNear
    ? selectInserterKind(
        northNear.items.reduce((a, b) => a + b.ratePerSec, 0) / M,
        1,
        pdk,
      )
    : null;
  const outIns = selectInserterKind(spec.outputRatePerSec / M, 1, pdk);
  const southFarIns = southFar
    ? selectInserterKind(
        southFar.items.reduce((a, b) => a + b.ratePerSec, 0) / M,
        2,
        pdk,
      )
    : null;

  const nNeeded = (northFarIns?.count ?? 0) + (northNearIns?.count ?? 0);
  const sNeeded = outIns.count + (southFarIns?.count ?? 0);

  const needsLaneBalance =
    Boolean(spec.balanceOutputLanes) ||
    spec.outputRatePerSec > beltSpec.itemsPerSec * 0.49;
  const laneFlipAfterIdx =
    needsLaneBalance && M >= 2 ? Math.floor(M / 2) - 1 : undefined;
  const tailW = needsLaneBalance && M === 1 ? 2 : 0;

  const geom = layoutMachineRow(headerW, M, nNeeded, sNeeded, pdk, laneFlipAfterIdx);
  const width = geom.endX + tailW;

  const entities: EntityInstance[] = [];
  const pins: MacroPin[] = [];
  let hid = 0;
  const mkBelt = (
    tx: number,
    ty: number,
    direction: Dir,
    item?: string,
    intentionalSideLoad?: boolean,
    laneItems?: [string, string],
  ): EntityInstance => ({
    id: `${spec.id}:h:${hid++}`,
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

  if (hasDualNorth) {
    // North header occupies x=0..4, y=0..4 (topPad=1, yFarN=1, yNearN=2, yInsN=3, yMachine=4)
    if (northFar) {
      if (northFar.isDualLane) {
        const [a1, a2] = northFar.items;
        entities.push(mkBelt(0, 0, Dir.EAST, a1.item));
        addInPin(a1.item, a1.ratePerSec, 0, 0, Dir.EAST);
        entities.push(mkBelt(1, 0, Dir.SOUTH, a1.item));

        entities.push(mkBelt(0, 2, Dir.EAST, a2.item));
        addInPin(a2.item, a2.ratePerSec, 0, 2, Dir.EAST);
        entities.push(mkBelt(1, 2, Dir.NORTH, a2.item));

        entities.push(mkBelt(1, 1, Dir.EAST, undefined, true, [a1.item, a2.item]));
      } else {
        const [a1] = northFar.items;
        entities.push(mkBelt(0, 1, Dir.EAST, a1.item));
        addInPin(a1.item, a1.ratePerSec, 0, 1, Dir.EAST);
        entities.push(mkBelt(1, 1, Dir.EAST, a1.item));
      }
      entities.push({
        id: `${spec.id}:h:${hid++}`,
        name: beltSpec.undergroundName,
        tx: 2,
        ty: 1,
        w: 1,
        h: 1,
        direction: Dir.EAST,
        type: 'input',
        macroId: spec.id,
        role: 'ug-macro',
      });
      entities.push({
        id: `${spec.id}:h:${hid++}`,
        name: beltSpec.undergroundName,
        tx: 4,
        ty: 1,
        w: 1,
        h: 1,
        direction: Dir.EAST,
        type: 'output',
        macroId: spec.id,
        role: 'ug-macro',
      });
    }

    if (northNear) {
      if (northNear.isDualLane) {
        const [b1, b2] = northNear.items;
        entities.push(mkBelt(3, 0, Dir.SOUTH, b1.item));
        addInPin(b1.item, b1.ratePerSec, 3, 0, Dir.SOUTH);
        entities.push(mkBelt(3, 1, Dir.SOUTH, b1.item));

        entities.push(mkBelt(0, 4, Dir.EAST, b2.item));
        addInPin(b2.item, b2.ratePerSec, 0, 4, Dir.EAST);
        entities.push(mkBelt(1, 4, Dir.EAST, b2.item));
        entities.push(mkBelt(2, 4, Dir.EAST, b2.item));
        entities.push(mkBelt(3, 4, Dir.NORTH, b2.item));
        entities.push(mkBelt(3, 3, Dir.NORTH, b2.item));

        entities.push(mkBelt(3, 2, Dir.EAST, undefined, true, [b1.item, b2.item]));
        entities.push(mkBelt(4, 2, Dir.EAST, undefined, false, [b1.item, b2.item]));
      } else {
        const [b1] = northNear.items;
        entities.push(mkBelt(3, 0, Dir.SOUTH, b1.item));
        addInPin(b1.item, b1.ratePerSec, 3, 0, Dir.SOUTH);
        entities.push(mkBelt(3, 1, Dir.SOUTH, b1.item));
        entities.push(mkBelt(3, 2, Dir.EAST, b1.item));
        entities.push(mkBelt(4, 2, Dir.EAST, b1.item));
      }
    }
  } else {
    // Simple direct West-edge inputs (single-item tracks)
    if (northFar) {
      const [a1] = northFar.items;
      for (let x = 0; x < headerW; x++) {
        entities.push(mkBelt(x, yFarN, Dir.EAST, a1.item));
      }
      addInPin(a1.item, a1.ratePerSec, 0, yFarN, Dir.EAST);
    }
    if (northNear) {
      const [b1] = northNear.items;
      for (let x = 0; x < headerW; x++) {
        entities.push(mkBelt(x, yNearN, Dir.EAST, b1.item));
      }
      addInPin(b1.item, b1.ratePerSec, 0, yNearN, Dir.EAST);
    }
  }

  // South Far track header (if present)
  if (southFar) {
    if (southFar.isDualLane) {
      const [c1, c2] = southFar.items;
      entities.push(mkBelt(0, yOut, Dir.EAST, c1.item));
      addInPin(c1.item, c1.ratePerSec, 0, yOut, Dir.EAST);
      entities.push(mkBelt(1, yOut, Dir.SOUTH, c1.item));

      entities.push(mkBelt(0, yFarS + 1, Dir.EAST, c2.item));
      addInPin(c2.item, c2.ratePerSec, 0, yFarS + 1, Dir.EAST);
      entities.push(mkBelt(1, yFarS + 1, Dir.NORTH, c2.item));

      entities.push(mkBelt(1, yFarS, Dir.EAST, undefined, true, [c1.item, c2.item]));
      for (let x = 2; x < headerW; x++) {
        entities.push(mkBelt(x, yFarS, Dir.EAST, undefined, false, [c1.item, c2.item]));
      }
    } else {
      const [c1] = southFar.items;
      for (let x = 0; x < headerW; x++) {
        entities.push(mkBelt(x, yFarS, Dir.EAST, c1.item));
      }
      addInPin(c1.item, c1.ratePerSec, 0, yFarS, Dir.EAST);
    }
  }

  populateStripEntities(
    entities,
    spec.id,
    spec,
    pdk,
    0,
    headerW,
    yMachine,
    M,
    northFar,
    northNear,
    southFar,
    northFarIns,
    northNearIns,
    outIns,
    southFarIns,
    geom,
    geom.endX,
  );

  if (tailW === 2) {
    entities.push({
      id: `${spec.id}:tail:sp`,
      name: beltSpec.splitterName,
      tx: geom.endX,
      ty: yMachine + 3,
      w: 1,
      h: 2,
      direction: Dir.EAST,
      macroId: spec.id,
      role: 'splitter-macro',
    });
    entities.push(mkBelt(geom.endX + 1, yMachine + 3, Dir.SOUTH, spec.outputItem));
    entities.push(mkBelt(geom.endX + 1, yOut, Dir.EAST, spec.outputItem, true));
  }

  // Output pin on East edge
  const outPort = pinOutsideOffset(width - 1, yOut, Dir.EAST, 'output');
  pins.push({
    id: `out:${spec.outputItem}`,
    item: spec.outputItem,
    direction: Dir.EAST,
    kind: 'output',
    x: width - 1,
    y: yOut,
    portX: outPort.portX,
    portY: outPort.portY,
    ratePerSec: spec.outputRatePerSec,
    beltTier: spec.beltTier,
  });

  const powerTargets = entities
    .filter((e) => e.role === 'machine' || e.role === 'inserter-in' || e.role === 'inserter-out')
    .map((e) => ({ tx: e.tx, ty: e.ty, w: e.w, h: e.h }));

  const sublabel = `${spec.machineCount}× ${MACHINE_SPECS[spec.machineName].name === 'electric-furnace' ? 'Furnace' : `Asm${spec.machineName.slice(-1)}`}`;

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
}

/**
 * Compact back-to-back mirrored 2-row macro with shared center input bus(es).
 * Cuts height and internal belt length dramatically compared to duplicated 2-row layouts.
 */
function buildMirroredTwoRowMacro(spec: RecipeMacroSpec, pdk: PdkConfig): CompiledMacro | null {
  const { northFar, northNear, southFar } = assignTracks(spec);
  if (southFar !== null) return null;
  if (spec.machineCount < 4 || !northNear) return null;

  const M = spec.machineCount;
  const mTop = Math.ceil(M / 2);
  const mBot = Math.floor(M / 2);
  const hasTwoInputs = northFar !== null;
  const track1Dual = northNear.isDualLane;
  const track2Dual = northFar?.isDualLane ?? false;
  const hasDual = track1Dual || track2Dual;

  const r1PerMach = northNear.items.reduce((a, b) => a + b.ratePerSec, 0) / M;
  const r2PerMach = northFar
    ? northFar.items.reduce((a, b) => a + b.ratePerSec, 0) / M
    : 0;

  if (hasTwoInputs && northFar) {
    // Both tracks are reach-2 on one of the two opposing rows
    const longCap = INSERTER_SPECS.long.itemsPerSec;
    if (r1PerMach > longCap * 2 || r2PerMach > longCap * 2) return null;
    if (Math.ceil(r1PerMach / longCap) + Math.ceil(r2PerMach / longCap) > 3) return null;
  }

  const catalog = getCatalog();
  const recipe = catalog.recipesById[spec.recipeId];
  const beltSpec = BELT_SPECS[spec.beltTier];
  const poleSpec = POLE_SPECS[pdk.defaultPoleTier];

  // Vertical coordinates
  const yOutTop = 0;
  const yInsOutTop = 1;
  const yMachTop = 2; // 2..4
  const yInsInTop = 5;
  const yTrack1 = 6;
  const yTrack2 = hasTwoInputs ? 7 : -1;
  const yInsInBot = hasTwoInputs ? 8 : 7;
  const yMachBot = hasTwoInputs ? 9 : 8; // 9..11 or 8..10
  const yInsOutBot = hasTwoInputs ? 12 : 11;
  const yOutBot = hasTwoInputs ? 13 : 12;
  const height = yOutBot + 1;

  // Inserter requirements for top and bottom strips
  const topInsTrack1 = selectInserterKind(r1PerMach, 1, pdk);
  const topInsTrack2 =
    hasTwoInputs && northFar ? selectInserterKind(r2PerMach, 2, pdk) : null;

  const botInsTrack2 =
    hasTwoInputs && northFar ? selectInserterKind(r2PerMach, 1, pdk) : null;
  const botInsTrack1 = hasTwoInputs
    ? selectInserterKind(r1PerMach, 2, pdk)
    : selectInserterKind(r1PerMach, 1, pdk);

  const outIns = selectInserterKind(spec.outputRatePerSec / M, 1, pdk);

  const nNeeded = Math.max(
    topInsTrack1.count + (topInsTrack2?.count ?? 0),
    botInsTrack1.count + (botInsTrack2?.count ?? 0),
  );
  const sNeeded = outIns.count;

  const headerW = hasDual ? 5 : 0;
  const geomTop = layoutMachineRow(headerW, mTop, nNeeded, sNeeded, pdk);
  const geomBot = layoutMachineRow(headerW, mBot, nNeeded, sNeeded, pdk);
  const stripEndX = Math.max(geomTop.endX, geomBot.endX);

  const entities: EntityInstance[] = [];
  const pins: MacroPin[] = [];
  let uid = 0;
  const eid = (tag: string) => `${spec.id}:m2:${tag}:${uid++}`;

  const mkBelt = (
    tx: number,
    ty: number,
    direction: Dir,
    item?: string,
    intentionalSideLoad?: boolean,
    laneItems?: [string, string],
  ): EntityInstance => ({
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

  // Top & Bottom Machines + Substations
  for (const mx of geomTop.machineXs) {
    entities.push({
      id: eid('mt'),
      name: spec.machineName,
      tx: mx,
      ty: yMachTop,
      w: 3,
      h: 3,
      direction: Dir.NORTH,
      recipe: spec.recipeId,
      items: spec.modules.length > 0 ? [...spec.modules] : undefined,
      macroId: spec.id,
      item: spec.outputItem,
      role: 'machine',
    });
  }
  for (const mx of geomBot.machineXs) {
    entities.push({
      id: eid('mb'),
      name: spec.machineName,
      tx: mx,
      ty: yMachBot,
      w: 3,
      h: 3,
      direction: Dir.NORTH,
      macroId: spec.id,
      recipe: spec.recipeId,
      items: spec.modules.length > 0 ? [...spec.modules] : undefined,
      item: spec.outputItem,
      role: 'machine',
    });
  }

  for (const sx of geomTop.substationXs) {
    entities.push({
      id: eid('subt'),
      name: poleSpec.name,
      tx: sx,
      ty: yMachTop,
      w: 2,
      h: 2,
      direction: Dir.NORTH,
      macroId: spec.id,
      role: 'pole-macro',
    });
  }
  for (const sx of geomBot.substationXs) {
    entities.push({
      id: eid('subb'),
      name: poleSpec.name,
      tx: sx,
      ty: yMachBot,
      w: 2,
      h: 2,
      direction: Dir.NORTH,
      macroId: spec.id,
      role: 'pole-macro',
    });
  }

  // Poles along inserter strips for small/medium poles
  const topPoleSet = new Set(geomTop.poleXs);
  const botPoleSet = new Set(geomBot.poleXs);
  for (const px of geomTop.poleXs) {
    entities.push({
      id: eid('ptn'),
      name: poleSpec.name,
      tx: px,
      ty: yInsOutTop,
      w: 1,
      h: 1,
      direction: Dir.NORTH,
      macroId: spec.id,
      role: 'pole-macro',
    });
    entities.push({
      id: eid('ptc'),
      name: poleSpec.name,
      tx: px,
      ty: yInsInTop,
      w: 1,
      h: 1,
      direction: Dir.NORTH,
      macroId: spec.id,
      role: 'pole-macro',
    });
  }
  for (const px of geomBot.poleXs) {
    entities.push({
      id: eid('pbc'),
      name: poleSpec.name,
      tx: px,
      ty: yInsInBot,
      w: 1,
      h: 1,
      direction: Dir.NORTH,
      macroId: spec.id,
      role: 'pole-macro',
    });
    entities.push({
      id: eid('pbs'),
      name: poleSpec.name,
      tx: px,
      ty: yInsOutBot,
      w: 1,
      h: 1,
      direction: Dir.NORTH,
      macroId: spec.id,
      role: 'pole-macro',
    });
  }

  // Inserters for Top Row (faces SOUTH into center tracks, output faces SOUTH picking from machine)
  let maxInX = 0;
  for (const mx of geomTop.machineXs) {
    const inFree = [mx, mx + 1, mx + 2].filter((x) => !topPoleSet.has(x));
    let ic = 0;
    const t1Limit = topInsTrack2 ? Math.max(1, inFree.length - 1) : inFree.length;
    for (let c = 0; c < topInsTrack1.count && ic < t1Limit; c++) {
      const ix = inFree[ic++];
      if (ix > maxInX) maxInX = ix;
      entities.push({
        id: eid('int1'),
        name: INSERTER_SPECS[topInsTrack1.kind].name,
        tx: ix,
        ty: yInsInTop,
        w: 1,
        h: 1,
        direction: Dir.SOUTH,
        macroId: spec.id,
        role: 'inserter-in',
      });
    }
    if (topInsTrack2) {
      for (let c = 0; c < topInsTrack2.count && ic < inFree.length; c++) {
        const ix = inFree[ic++];
        if (ix > maxInX) maxInX = ix;
        entities.push({
          id: eid('int2'),
          name: INSERTER_SPECS[topInsTrack2.kind].name,
          tx: ix,
          ty: yInsInTop,
          w: 1,
          h: 1,
          direction: Dir.SOUTH,
          macroId: spec.id,
          role: 'inserter-in',
        });
      }
    }

    const outFree = [mx, mx + 1, mx + 2].filter((x) => !topPoleSet.has(x));
    for (let c = 0; c < outIns.count && c < outFree.length; c++) {
      entities.push({
        id: eid('outt'),
        name: INSERTER_SPECS[outIns.kind].name,
        tx: outFree[c],
        ty: yInsOutTop,
        w: 1,
        h: 1,
        // Picks from machine below (SOUTH), drops onto yOutTop above
        direction: Dir.SOUTH,
        macroId: spec.id,
        role: 'inserter-out',
      });
    }
  }

  // Inserters for Bottom Row (faces NORTH into center tracks, output faces NORTH picking from machine)
  for (const mx of geomBot.machineXs) {
    const inFree = [mx, mx + 1, mx + 2].filter((x) => !botPoleSet.has(x));
    let ic = 0;
    if (botInsTrack2) {
      const b2Limit = Math.max(1, inFree.length - 1);
      for (let c = 0; c < botInsTrack2.count && ic < b2Limit; c++) {
        const ix = inFree[ic++];
        if (ix > maxInX) maxInX = ix;
        entities.push({
          id: eid('inb2'),
          name: INSERTER_SPECS[botInsTrack2.kind].name,
          tx: ix,
          ty: yInsInBot,
          w: 1,
          h: 1,
          direction: Dir.NORTH,
          macroId: spec.id,
          role: 'inserter-in',
        });
      }
    }
    for (let c = 0; c < botInsTrack1.count && ic < inFree.length; c++) {
      const ix = inFree[ic++];
      if (ix > maxInX) maxInX = ix;
      entities.push({
        id: eid('inb1'),
        name: INSERTER_SPECS[botInsTrack1.kind].name,
        tx: ix,
        ty: yInsInBot,
        w: 1,
        h: 1,
        direction: Dir.NORTH,
        macroId: spec.id,
        role: 'inserter-in',
      });
    }

    const outFree = [mx, mx + 1, mx + 2].filter((x) => !botPoleSet.has(x));
    for (let c = 0; c < outIns.count && c < outFree.length; c++) {
      entities.push({
        id: eid('outb'),
        name: INSERTER_SPECS[outIns.kind].name,
        tx: outFree[c],
        ty: yInsOutBot,
        w: 1,
        h: 1,
        direction: Dir.NORTH,
        macroId: spec.id,
        role: 'inserter-out',
      });
    }
  }

  // Shared center input track(s): stop at min(stripEndX, maxInX + 1)
  const inBeltEnd = Math.min(stripEndX, maxInX + 1);
  // Keep at least 1 empty tile between input belt end and output drop column
  const dropX = Math.max(stripEndX, inBeltEnd + 1);
  const width = dropX + 3;

  const trackMeta = (t: typeof northNear) =>
    t.items.length === 2
      ? { laneItems: [t.items[0].item, t.items[1].item] as [string, string] }
      : { item: t.items[0].item };
  const t1Meta = trackMeta(northNear);
  const t2Meta = northFar ? trackMeta(northFar) : null;

  if (hasDual) {
    // 5-tile West header (x=0..4) merges dual-lane center tracks with 2-tile vertical pin spacing
    if (hasTwoInputs && northFar && t2Meta) {
      if (northFar.isDualLane) {
        const [b1, b2] = northFar.items;
        entities.push(mkBelt(0, 6, Dir.EAST, b1.item));
        addInPin(b1.item, b1.ratePerSec, 0, 6, Dir.EAST);
        entities.push(mkBelt(1, 6, Dir.SOUTH, b1.item));

        entities.push(mkBelt(0, 8, Dir.EAST, b2.item));
        addInPin(b2.item, b2.ratePerSec, 0, 8, Dir.EAST);
        entities.push(mkBelt(1, 8, Dir.NORTH, b2.item));

        entities.push(
          mkBelt(1, 7, Dir.EAST, undefined, true, [b1.item, b2.item]),
        );
      } else {
        const [b1] = northFar.items;
        entities.push(mkBelt(0, 7, Dir.EAST, b1.item));
        addInPin(b1.item, b1.ratePerSec, 0, 7, Dir.EAST);
        entities.push(mkBelt(1, 7, Dir.EAST, b1.item));
      }

      if (track1Dual) {
        entities.push({
          id: eid('ug2i'),
          name: beltSpec.undergroundName,
          tx: 2,
          ty: 7,
          w: 1,
          h: 1,
          direction: Dir.EAST,
          type: 'input',
          macroId: spec.id,
          role: 'ug-macro',
        });
        entities.push({
          id: eid('ug2o'),
          name: beltSpec.undergroundName,
          tx: 4,
          ty: 7,
          w: 1,
          h: 1,
          direction: Dir.EAST,
          type: 'output',
          macroId: spec.id,
          role: 'ug-macro',
        });
      } else {
        entities.push(mkBelt(2, 7, Dir.EAST, t2Meta.item, false, t2Meta.laneItems));
        entities.push(mkBelt(3, 7, Dir.EAST, t2Meta.item, false, t2Meta.laneItems));
        entities.push(mkBelt(4, 7, Dir.EAST, t2Meta.item, false, t2Meta.laneItems));
      }
    }

    if (track1Dual) {
      const [a1, a2] = northNear.items;
      entities.push(mkBelt(0, 4, Dir.EAST, a1.item));
      addInPin(a1.item, a1.ratePerSec, 0, 4, Dir.EAST);
      entities.push(mkBelt(1, 4, Dir.EAST, a1.item));
      entities.push(mkBelt(2, 4, Dir.EAST, a1.item));
      entities.push(mkBelt(3, 4, Dir.SOUTH, a1.item));
      entities.push(mkBelt(3, 5, Dir.SOUTH, a1.item));

      entities.push(mkBelt(0, 10, Dir.EAST, a2.item));
      addInPin(a2.item, a2.ratePerSec, 0, 10, Dir.EAST);
      entities.push(mkBelt(1, 10, Dir.EAST, a2.item));
      entities.push(mkBelt(2, 10, Dir.EAST, a2.item));
      entities.push(mkBelt(3, 10, Dir.NORTH, a2.item));
      entities.push(mkBelt(3, 9, Dir.NORTH, a2.item));
      entities.push(mkBelt(3, 8, Dir.NORTH, a2.item));
      entities.push(mkBelt(3, 7, Dir.NORTH, a2.item));

      entities.push(
        mkBelt(3, 6, Dir.EAST, undefined, true, [a1.item, a2.item]),
      );
      entities.push(
        mkBelt(4, 6, Dir.EAST, undefined, false, [a1.item, a2.item]),
      );
    } else {
      // Single high-rate item on Track 1 curves around (1,6) into (4,6) -> full 2-lane belt
      const [a1] = northNear.items;
      entities.push(mkBelt(0, 4, Dir.EAST, a1.item));
      addInPin(a1.item, a1.ratePerSec, 0, 4, Dir.EAST);
      entities.push(mkBelt(1, 4, Dir.EAST, a1.item));
      entities.push(mkBelt(2, 4, Dir.EAST, a1.item));
      entities.push(mkBelt(3, 4, Dir.EAST, a1.item));
      entities.push(mkBelt(4, 4, Dir.SOUTH, a1.item));
      entities.push(mkBelt(4, 5, Dir.SOUTH, a1.item));
      entities.push(mkBelt(4, 6, Dir.EAST, a1.item));
    }

    for (let x = headerW; x < inBeltEnd; x++) {
      entities.push(mkBelt(x, yTrack1, Dir.EAST, t1Meta.item, false, t1Meta.laneItems));
      if (hasTwoInputs && yTrack2 >= 0 && t2Meta) {
        entities.push(mkBelt(x, yTrack2, Dir.EAST, t2Meta.item, false, t2Meta.laneItems));
      }
    }
  } else {
    const ing1 = northNear.items[0];
    for (let x = 0; x < inBeltEnd; x++) {
      entities.push(mkBelt(x, yTrack1, Dir.EAST, ing1.item));
    }
    addInPin(ing1.item, ing1.ratePerSec, 0, yTrack1, Dir.EAST);

    if (hasTwoInputs && northFar && yTrack2 >= 0) {
      const ing2 = northFar.items[0];
      for (let x = 0; x < inBeltEnd; x++) {
        entities.push(mkBelt(x, yTrack2, Dir.EAST, ing2.item));
      }
      addInPin(ing2.item, ing2.ratePerSec, 0, yTrack2, Dir.EAST);
    }
  }

  // Top & Bottom Output belts merging into splitter at (dropX + 1, yOutBot - 1)
  for (let x = headerW; x < dropX; x++) {
    entities.push(mkBelt(x, yOutTop, Dir.EAST, spec.outputItem));
  }
  for (let y = yOutTop; y < yOutBot - 1; y++) {
    entities.push(mkBelt(dropX, y, Dir.SOUTH, spec.outputItem));
  }
  entities.push(mkBelt(dropX, yOutBot - 1, Dir.EAST, spec.outputItem));

  for (let x = headerW; x <= dropX; x++) {
    entities.push(mkBelt(x, yOutBot, Dir.EAST, spec.outputItem));
  }

  entities.push({
    id: eid('sp'),
    name: beltSpec.splitterName,
    tx: dropX + 1,
    ty: yOutBot - 1,
    w: 1,
    h: 2,
    direction: Dir.EAST,
    macroId: spec.id,
    role: 'splitter-macro',
  });
  entities.push(mkBelt(dropX + 2, yOutBot, Dir.EAST, spec.outputItem));

  const outPort = pinOutsideOffset(width - 1, yOutBot, Dir.EAST, 'output');
  pins.push({
    id: `out:${spec.outputItem}`,
    item: spec.outputItem,
    direction: Dir.EAST,
    kind: 'output',
    x: width - 1,
    y: yOutBot,
    portX: outPort.portX,
    portY: outPort.portY,
    ratePerSec: spec.outputRatePerSec,
    beltTier: spec.beltTier,
  });

  const powerTargets = entities
    .filter((e) => e.role === 'machine' || e.role === 'inserter-in' || e.role === 'inserter-out')
    .map((e) => ({ tx: e.tx, ty: e.ty, w: e.w, h: e.h }));

  const sublabel = `${spec.machineCount}× ${MACHINE_SPECS[spec.machineName].name === 'electric-furnace' ? 'Furnace' : `Asm${spec.machineName.slice(-1)}`}`;

  return {
    id: spec.id,
    kind: 'recipe-macro',
    label: recipe?.name ?? spec.outputItem,
    sublabel,
    recipeId: spec.recipeId,
    outputItem: spec.outputItem,
    rows: 2,
    width,
    height,
    rotation: 0,
    entities,
    pins,
    powerTargets,
  };
}

export function compileRecipeMacroVariants(
  spec: RecipeMacroSpec,
  pdk: PdkConfig,
  compactMacros = true,
): CompiledMacro[] {
  const single = buildSingleRowMacro(spec, pdk);
  const twoRow = buildMirroredTwoRowMacro(spec, pdk);
  if (spec.preferredRows === 2 && twoRow) {
    return [twoRow, single];
  }
  if (spec.preferredRows === 1 || !twoRow) {
    return [single];
  }
  if (compactMacros && spec.machineCount >= 6) {
    return [twoRow, single];
  }
  return [single, twoRow];
}
