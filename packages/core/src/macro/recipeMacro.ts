import {
  AllInserterKind,
  CompiledMacro,
  Dir,
  EntityInstance,
  InserterTier,
  MachineName,
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
  PoleSpec,
  QUALITY_SPECS,
  doesPoleSupplyEntity,
  effectiveBeltCapacity,
} from '../data/entities.js';
import { getCatalog } from '../data/catalog.js';
import { pinOutsideOffset } from './transform.js';

interface IngredientTrack {
  items: { item: string; ratePerSec: number }[];
  isDualLane: boolean;
}

function machineShortLabel(machineName: MachineName, quality?: QualityTier): string {
  const base =
    machineName === 'electric-furnace'
      ? 'Furnace'
      : machineName === 'foundry'
        ? 'Foundry'
        : machineName === 'electromagnetic-plant'
          ? 'EM Plant'
          : machineName === 'cryogenic-plant'
            ? 'Cryo Plant'
            : `Asm${machineName.slice(-1)}`;
  if (quality && quality !== 'normal') {
    return `${QUALITY_SPECS[quality].label} ${base}`;
  }
  return base;
}

function selectInserterKind(
  ratePerMachine: number,
  reach: 1 | 2,
  pdk: PdkConfig,
  maxSlots = 3,
  preferStack = false,
): { kind: AllInserterKind; count: number } {
  if (reach === 2) {
    const spec = INSERTER_SPECS.long;
    const count = Math.min(2, Math.max(1, Math.ceil(ratePerMachine / spec.itemsPerSec)));
    return { kind: 'long', count };
  }

  const tierOrder: InserterTier[] = ['yellow', 'fast', 'bulk', 'stack'];
  const allowed = tierOrder.filter((t) => pdk.allowedInserterTiers.includes(t));
  const pool: InserterTier[] = allowed.length > 0 ? allowed : [pdk.defaultInserterTier];
  if (preferStack && pool.includes('stack')) {
    const stackCount = Math.min(
      maxSlots,
      Math.max(1, Math.ceil(ratePerMachine / INSERTER_SPECS.stack.itemsPerSec)),
    );
    return { kind: 'stack', count: stackCount };
  }
  const defIdx = Math.max(0, pool.indexOf(pdk.defaultInserterTier));

  for (let i = defIdx; i < pool.length; i++) {
    const k = pool[i];
    if (INSERTER_SPECS[k].itemsPerSec + 1e-6 >= ratePerMachine) {
      return { kind: k, count: 1 };
    }
  }
  const fastest = pool[pool.length - 1];
  const count = Math.min(
    maxSlots,
    Math.max(1, Math.ceil(ratePerMachine / INSERTER_SPECS[fastest].itemsPerSec)),
  );
  return { kind: fastest, count };
}

function assignTracks(
  spec: RecipeMacroSpec,
  pdk: PdkConfig,
): {
  northFar: IngredientTrack | null;
  northNear: IngredientTrack | null;
  southFar: IngredientTrack | null;
} {
  // Sort highest throughput ingredients first so they sit on reach-1 (northNear) tracks
  const ings = [...spec.ingredientRates].sort((a, b) => b.ratePerSec - a.ratePerSec);
  const cap = effectiveBeltCapacity(spec.beltTier, pdk);

  if (
    (spec.beaconsPerMachine ?? 0) >= 8 &&
    ings.length === 2 &&
    ings.every((ing) => ing.ratePerSec <= 0.48 * cap)
  ) {
    return {
      northFar: null,
      northNear: {
        items: ings.map((ing) => ({ item: ing.item, ratePerSec: ing.ratePerSec })),
        isDualLane: true,
      },
      southFar: null,
    };
  }

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

function computeBeaconStripXs(
  machineXs: number[],
  ms: number,
  minStartX = 0,
): number[] {
  if (machineXs.length === 0) return [];
  const firstMx = machineXs[0];
  const lastMx = machineXs[machineXs.length - 1];
  const bx0 = Math.max(minStartX, firstMx - 4);
  const maxBx = lastMx + ms + 2;
  const xs: number[] = [];
  for (let bx = bx0; bx <= maxBx; bx += 3) {
    xs.push(bx);
  }
  return xs;
}

function ensureExtraBeaconPoles(
  beaconXs: number[],
  existingPoleXs: number[],
  existingSubXs: number[],
  yBeacon: number,
  yPoleStrip: number,
  ySubStrip: number,
  poleSpec: PoleSpec,
  blockedXs: Set<number>,
): { extraPoles: number[]; extraSubs: number[] } {
  const extraPoles: number[] = [];
  const extraSubs: number[] = [];
  if (beaconXs.length === 0) return { extraPoles, extraSubs };

  if (poleSpec.tier === 'substation') {
    const allSubs = [...existingSubXs];
    for (const bx of beaconXs) {
      const covered = allSubs.some((sx) =>
        doesPoleSupplyEntity(sx, ySubStrip, poleSpec, bx, yBeacon, 3, 3),
      );
      if (covered) continue;
      // Place substation in empty gap at ySubStrip avoiding blockedXs
      const candX = Math.max(0, bx);
      allSubs.push(candX);
      extraSubs.push(candX);
    }
    return { extraPoles, extraSubs };
  }

  const allPoles = [...existingPoleXs];
  for (const bx of beaconXs) {
    const covered = allPoles.some((px) =>
      doesPoleSupplyEntity(px, yPoleStrip, poleSpec, bx, yBeacon, 3, 3),
    );
    if (covered) continue;

    const cands = [bx + 2, bx + 1, bx, bx + 3, Math.max(0, bx - 1)];
    let chosen: number | undefined;
    for (const px of cands) {
      if (px < 0 || blockedXs.has(px) || allPoles.includes(px)) continue;
      if (doesPoleSupplyEntity(px, yPoleStrip, poleSpec, bx, yBeacon, 3, 3)) {
        chosen = px;
        break;
      }
    }
    if (chosen === undefined) continue;

    // Ensure horizontal wire connectivity back to nearest pole on this strip
    if (allPoles.length > 0) {
      let nearest = allPoles[0];
      for (const p of allPoles) {
        if (Math.abs(p - chosen) < Math.abs(nearest - chosen)) nearest = p;
      }
      const stepDir = nearest > chosen ? 1 : -1;
      let cur = chosen;
      while (Math.abs(nearest - cur) > poleSpec.wireReach - 0.1) {
        const ideal = cur + stepDir * Math.floor(poleSpec.wireReach - 1);
        let bridge: number | undefined;
        for (let off = 0; off <= 3; off++) {
          const cx = ideal - stepDir * off;
          if (cx >= 0 && !blockedXs.has(cx) && !allPoles.includes(cx) && Math.abs(cx - cur) <= poleSpec.wireReach - 0.1) {
            bridge = cx;
            break;
          }
        }
        if (bridge === undefined) break;
        allPoles.push(bridge);
        extraPoles.push(bridge);
        cur = bridge;
      }
    }

    allPoles.push(chosen);
    extraPoles.push(chosen);
  }

  return { extraPoles, extraSubs };
}

function layoutSegmentSubstations(
  startX: number,
  count: number,
  poleSpec: PoleSpec,
  existingLastSub: number | undefined,
  ms: number,
  beaconAligned = false,
  existingBeaconBaseX?: number,
): { machineXs: number[]; substationXs: number[]; endX: number } {
  const machineXs: number[] = [];
  const substationXs: number[] = [];
  let x = startX;
  let lastSub = existingLastSub;
  const firstSubIdx = beaconAligned
    ? Math.min(1, Math.floor(count / 2))
    : count <= 4
      ? Math.floor(count / 2)
      : 2;
  let bx0: number | undefined = existingBeaconBaseX;

  for (let i = 0; i < count; i++) {
    const needWireBridge =
      lastSub !== undefined && x + 1 - (lastSub + 1) > poleSpec.wireReach - 4;
    const needCover =
      lastSub === undefined ||
      !doesPoleSupplyEntity(lastSub, 0, poleSpec, x, 0, 1, 1) ||
      !doesPoleSupplyEntity(lastSub, 0, poleSpec, x + ms - 1, 0, 1, 1);

    const periodicSub =
      existingLastSub === undefined
        ? i === firstSubIdx || (i > firstSubIdx && (i - firstSubIdx) % 5 === 0)
        : i > 0 && i % 5 === 0;

    if (periodicSub || needCover || needWireBridge) {
      substationXs.push(x);
      lastSub = x;
      x += 2;
    }
    if (beaconAligned && ms === 3 && bx0 !== undefined && ((x - bx0) % 3 + 3) % 3 === 0) {
      x += 1;
    }
    machineXs.push(x);
    if (bx0 === undefined) bx0 = Math.max(0, x - 4);
    x += ms;
  }

  if (count > 0 && lastSub === undefined) {
    substationXs.push(x);
    lastSub = x;
    x += 2;
  } else if (count > 0 && lastSub !== undefined) {
    const lastMx = machineXs[count - 1];
    if (
      !doesPoleSupplyEntity(lastSub, 0, poleSpec, lastMx, 0, ms, 1) ||
      !doesPoleSupplyEntity(lastSub, 0, poleSpec, lastMx + ms - 1, 0, 1, 1) ||
      (beaconAligned && !doesPoleSupplyEntity(lastSub, 0, poleSpec, lastMx + ms, 0, 3, 1))
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
  ms: number,
  laneFlipAfterIdx?: number,
  beaconAligned = false,
): MachineRowGeometry {
  const poleSpec = POLE_SPECS[pdk.defaultPoleTier];
  const hasSplit =
    laneFlipAfterIdx !== undefined &&
    laneFlipAfterIdx >= 0 &&
    laneFlipAfterIdx < machineCount - 1;

  if (poleSpec.tier === 'substation') {
    if (!hasSplit) {
      const seg = layoutSegmentSubstations(
        startX,
        machineCount,
        poleSpec,
        undefined,
        ms,
        beaconAligned,
      );
      return {
        machineXs: seg.machineXs,
        poleXs: [],
        substationXs: seg.substationXs,
        endX: seg.endX,
      };
    }

    const leftCount = laneFlipAfterIdx + 1;
    const rightCount = machineCount - leftCount;
    const leftSeg = layoutSegmentSubstations(
      startX,
      leftCount,
      poleSpec,
      undefined,
      ms,
      beaconAligned,
    );
    const laneFlipX = leftSeg.endX;
    const lastLeftSub = leftSeg.substationXs[leftSeg.substationXs.length - 1];
    const leftBx0 =
      leftSeg.machineXs.length > 0 ? Math.max(0, leftSeg.machineXs[0] - 4) : undefined;
    const rightSeg = layoutSegmentSubstations(
      laneFlipX + 3,
      rightCount,
      poleSpec,
      lastLeftSub,
      ms,
      beaconAligned,
      leftBx0,
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
  // If any machine needs all `ms` slots for inserters on North or South, use stride `ms + 1` so poles sit cleanly in the 1-tile gap.
  const needsGap = northInsertersPerMachine >= ms || southInsertersPerMachine >= ms;
  const stride = needsGap ? ms + 1 : ms;
  const poleOffset = needsGap ? ms : Math.min(ms - 1, 2);
  const step = poleSpec.tier === 'small' || ms >= 4 ? 1 : 2;
  const needSmallStarter = needsGap && poleSpec.tier === 'small' && machineCount > 0;
  const leftMachineStartX = needSmallStarter ? startX + 1 : startX;
  const alignBx0 = Math.max(0, leftMachineStartX - 4);

  if (!hasSplit) {
    const machineXs: number[] = [];
    let curX = leftMachineStartX;
    for (let i = 0; i < machineCount; i++) {
      if (i > 0) {
        curX = machineXs[i - 1] + stride;
        if (beaconAligned && ms === 3 && ((curX - alignBx0) % 3 + 3) % 3 === 0) {
          curX += 1;
        }
      }
      machineXs.push(curX);
    }
    const endX =
      machineCount > 0 ? machineXs[machineCount - 1] + ms : leftMachineStartX;

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
          doesPoleSupplyEntity(px, 0, poleSpec, lastMx, 0, ms, 1) &&
          doesPoleSupplyEntity(px, 0, poleSpec, lastMx + (needsGap ? ms - 1 : 1), 0, 1, 1),
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

  let curLeftX = leftMachineStartX;
  for (let i = 0; i < leftCount; i++) {
    if (i > 0) {
      curLeftX = machineXs[i - 1] + stride;
      if (beaconAligned && ms === 3 && ((curLeftX - alignBx0) % 3 + 3) % 3 === 0) {
        curLeftX += 1;
      }
    }
    machineXs.push(curLeftX);
  }
  for (let i = 0; i < leftCount; i += step) {
    poleXs.push(machineXs[i] + poleOffset);
  }
  const lastLeftMx = machineXs[leftCount - 1];
  const lastLeftCovered = poleXs.some(
    (px) =>
      doesPoleSupplyEntity(px, 0, poleSpec, lastLeftMx, 0, ms, 1) &&
      doesPoleSupplyEntity(px, 0, poleSpec, lastLeftMx + (needsGap ? ms - 1 : 1), 0, 1, 1),
  );
  if (!lastLeftCovered) {
    poleXs.push(lastLeftMx + poleOffset);
  }

  const laneFlipX = lastLeftMx + (needsGap ? ms + 1 : ms);
  let rightStartX = laneFlipX + 3;
  if (needsGap && poleSpec.tier === 'small') {
    // Small pole at laneFlipX + 3 powers the first right machine's leftmost inserter slot & bridges the jog
    poleXs.push(laneFlipX + 3);
    rightStartX = laneFlipX + 4;
  }
  if (beaconAligned && ms === 3 && ((rightStartX - alignBx0) % 3 + 3) % 3 === 0) {
    rightStartX += 1;
  }

  const firstRightPole = rightStartX + poleOffset;
  const lastLeftPole = poleXs[poleXs.length - 1];
  if (firstRightPole - lastLeftPole > poleSpec.wireReach - 0.1) {
    const bridgeLeft = lastLeftMx + poleOffset;
    if (bridgeLeft !== lastLeftPole) {
      poleXs.push(bridgeLeft);
    }
  }

  let curRightX = rightStartX;
  for (let j = 0; j < rightCount; j++) {
    if (j > 0) {
      curRightX = machineXs[leftCount + j - 1] + stride;
      if (beaconAligned && ms === 3 && ((curRightX - alignBx0) % 3 + 3) % 3 === 0) {
        curRightX += 1;
      }
    }
    machineXs.push(curRightX);
  }
  for (let j = 0; j < rightCount; j += step) {
    poleXs.push(machineXs[leftCount + j] + poleOffset);
  }
  const lastRightMx = machineXs[machineCount - 1];
  const lastRightCovered = poleXs.some(
    (px) =>
      doesPoleSupplyEntity(px, 0, poleSpec, lastRightMx, 0, ms, 1) &&
      doesPoleSupplyEntity(px, 0, poleSpec, lastRightMx + (needsGap ? ms - 1 : 1), 0, 1, 1),
  );
  if (!lastRightCovered) {
    poleXs.push(lastRightMx + poleOffset);
  }

  const finalEndX = Math.max(
    lastRightMx + ms,
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
  const ms = MACHINE_SPECS[spec.machineName].size;
  const yFarN = yMachine - 3;
  const yNearN = yMachine - 2;
  const yInsN = yMachine - 1;
  const yInsS = yMachine + ms;
  const yOut = yMachine + ms + 1;
  const yFarS = yMachine + ms + 2;

  let uid = 0;
  const eid = (tag: string) => `${macroId}:r${rowIdx}:${tag}:${uid++}`;

  // Machines & Substations
  for (const mx of geom.machineXs) {
    entities.push({
      id: eid('m'),
      name: spec.machineName,
      tx: mx,
      ty: yMachine,
      w: ms,
      h: ms,
      direction: Dir.NORTH,
      recipe: spec.recipeId,
      quality: spec.quality,
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
    const slotXs = Array.from({ length: ms }, (_, k) => mx + k);
    const northFree = slotXs.filter((x) => !poleSet.has(x));
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

    const southFree = slotXs.filter((x) => !poleSet.has(x));
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
  const poleSpec = POLE_SPECS[pdk.defaultPoleTier];
  const beltCap = effectiveBeltCapacity(spec.beltTier, pdk);
  const ms = MACHINE_SPECS[spec.machineName].size;
  const preferStackOut = (pdk.beltStackSize ?? 1) > 1;
  const { northFar, northNear, southFar } = assignTracks(spec, pdk);

  const targetBeacons = spec.beaconsPerMachine ?? 0;
  const beaconMods = spec.beaconModules ?? [];
  const hasBeacons = targetBeacons > 0 && beaconMods.length > 0 && !southFar;
  const hasSouthBeacons = hasBeacons;
  const hasNorthBeacons = hasBeacons && targetBeacons >= 8 && !northFar;

  const isCompactDualNorthNear = hasNorthBeacons && (northNear?.isDualLane ?? false);
  const hasDualNorth =
    !isCompactDualNorthNear &&
    ((northFar?.isDualLane ?? false) || (northNear?.isDualLane ?? false));
  const hasDualSouth = southFar?.isDualLane ?? false;

  const headerW = isCompactDualNorthNear
    ? 2
    : hasDualNorth
      ? 5
      : hasDualSouth
        ? 2
        : 0;
  const xStart = hasBeacons ? Math.max(headerW, 4) : headerW;
  const beaconTopH = hasNorthBeacons ? 3 : 0;
  const topPad = hasDualNorth ? 1 : 0;
  const northTrackRows = (northFar ? 1 : 0) + (northNear ? 1 : 0);
  const yBeaconN = 0;
  const yMachine = beaconTopH + topPad + northTrackRows + 1; // +1 for North inserter strip
  const yFarN = yMachine - 3;
  const yNearN = yMachine - 2;
  const yInsN = yMachine - 1;
  const yInsS = yMachine + ms;
  const yOut = yMachine + ms + 1;
  const yFarS = yMachine + ms + 2;
  const yBeaconS = yOut + 1;
  const bottomPad = hasDualSouth ? 1 : 0;
  const height =
    (hasSouthBeacons
      ? yBeaconS + 3
      : southFar
        ? yFarS + 1
        : yOut + 1) + bottomPad;

  const M = spec.machineCount;
  const northFarIns = northFar
    ? selectInserterKind(
        northFar.items.reduce((a, b) => a + b.ratePerSec, 0) / M,
        2,
        pdk,
        ms,
      )
    : null;
  const northNearIns = northNear
    ? selectInserterKind(
        northNear.items.reduce((a, b) => a + b.ratePerSec, 0) / M,
        1,
        pdk,
        ms,
      )
    : null;
  const outIns = selectInserterKind(
    spec.outputRatePerSec / M,
    1,
    pdk,
    ms,
    preferStackOut,
  );
  const southFarIns = southFar
    ? selectInserterKind(
        southFar.items.reduce((a, b) => a + b.ratePerSec, 0) / M,
        2,
        pdk,
        ms,
      )
    : null;

  const nNeeded = (northFarIns?.count ?? 0) + (northNearIns?.count ?? 0);
  const sNeeded = outIns.count + (southFarIns?.count ?? 0);

  const needsLaneBalance =
    Boolean(spec.balanceOutputLanes) ||
    spec.outputRatePerSec > beltCap * 0.49;
  const laneFlipAfterIdx =
    needsLaneBalance && M >= 2 ? Math.floor(M / 2) - 1 : undefined;
  const tailW = needsLaneBalance && M === 1 ? 2 : 0;

  const geom = layoutMachineRow(
    xStart,
    M,
    nNeeded,
    sNeeded,
    pdk,
    ms,
    laneFlipAfterIdx,
    hasBeacons,
  );
  const beaconXs = hasBeacons ? computeBeaconStripXs(geom.machineXs, ms, 0) : [];
  const beaconEndX =
    beaconXs.length > 0 ? beaconXs[beaconXs.length - 1] + 3 : 0;
  const width = Math.max(geom.endX + tailW, beaconEndX);

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

  if (isCompactDualNorthNear && northNear) {
    // 2-tile compact merge header clear of yBeaconN (y=0..2) and aligned with yNearN
    const [a1, a2] = northNear.items;
    entities.push(mkBelt(0, yNearN, Dir.EAST, a1.item));
    addInPin(a1.item, a1.ratePerSec, 0, yNearN, Dir.EAST);
    entities.push(
      mkBelt(1, yNearN, Dir.EAST, undefined, true, [a1.item, a2.item]),
    );

    entities.push(mkBelt(0, yMachine, Dir.EAST, a2.item));
    addInPin(a2.item, a2.ratePerSec, 0, yMachine, Dir.EAST);
    entities.push(mkBelt(1, yMachine, Dir.NORTH, a2.item));
    entities.push(mkBelt(1, yInsN, Dir.NORTH, a2.item));

    for (let x = 2; x < xStart; x++) {
      entities.push(
        mkBelt(x, yNearN, Dir.EAST, undefined, false, [a1.item, a2.item]),
      );
    }
  } else if (hasDualNorth) {
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
      for (let x = 0; x < xStart; x++) {
        entities.push(mkBelt(x, yFarN, Dir.EAST, a1.item));
      }
      addInPin(a1.item, a1.ratePerSec, 0, yFarN, Dir.EAST);
    }
    if (northNear) {
      const [b1] = northNear.items;
      for (let x = 0; x < xStart; x++) {
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
      for (let x = 2; x < xStart; x++) {
        entities.push(mkBelt(x, yFarS, Dir.EAST, undefined, false, [c1.item, c2.item]));
      }
    } else {
      const [c1] = southFar.items;
      for (let x = 0; x < xStart; x++) {
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
    xStart,
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
      ty: yMachine + ms,
      w: 1,
      h: 2,
      direction: Dir.EAST,
      macroId: spec.id,
      role: 'splitter-macro',
    });
    entities.push(mkBelt(geom.endX + 1, yMachine + ms, Dir.SOUTH, spec.outputItem));
    entities.push(mkBelt(geom.endX + 1, yOut, Dir.EAST, spec.outputItem, true));
  }

  // Extend output belt East if rightmost beacon extends past geom.endX + tailW
  const curOutEnd = geom.endX + tailW;
  for (let x = curOutEnd; x < width; x++) {
    entities.push(mkBelt(x, yOut, Dir.EAST, spec.outputItem));
  }

  // Emit 3x3 beacons and overhang power poles
  if (hasNorthBeacons) {
    for (const bx of beaconXs) {
      entities.push({
        id: `${spec.id}:bn:${bx}`,
        name: 'beacon',
        tx: bx,
        ty: yBeaconN,
        w: 3,
        h: 3,
        direction: Dir.NORTH,
        items: [...beaconMods],
        quality: spec.quality,
        macroId: spec.id,
        role: 'beacon-macro',
      });
    }
    const blockedNorth = new Set<number>();
    if (isCompactDualNorthNear) blockedNorth.add(1);
    for (const e of entities) {
      if (e.ty === yInsN && (e.role === 'inserter-in' || e.role === 'pole-macro')) {
        blockedNorth.add(e.tx);
      }
    }
    const nExtra = ensureExtraBeaconPoles(
      beaconXs,
      geom.poleXs,
      geom.substationXs,
      yBeaconN,
      yInsN,
      yMachine,
      poleSpec,
      blockedNorth,
    );
    for (const px of nExtra.extraPoles) {
      entities.push({
        id: `${spec.id}:bpn:${px}`,
        name: poleSpec.name,
        tx: px,
        ty: yInsN,
        w: 1,
        h: 1,
        direction: Dir.NORTH,
        macroId: spec.id,
        role: 'pole-macro',
      });
    }
    for (const sx of nExtra.extraSubs) {
      entities.push({
        id: `${spec.id}:bsn:${sx}`,
        name: poleSpec.name,
        tx: sx,
        ty: yMachine,
        w: 2,
        h: 2,
        direction: Dir.NORTH,
        macroId: spec.id,
        role: 'pole-macro',
      });
    }
  }

  if (hasSouthBeacons) {
    for (const bx of beaconXs) {
      entities.push({
        id: `${spec.id}:bs:${bx}`,
        name: 'beacon',
        tx: bx,
        ty: yBeaconS,
        w: 3,
        h: 3,
        direction: Dir.NORTH,
        items: [...beaconMods],
        quality: spec.quality,
        macroId: spec.id,
        role: 'beacon-macro',
      });
    }
    const blockedSouth = new Set<number>();
    for (const e of entities) {
      if (e.ty === yInsS || (e.ty <= yInsS && e.ty + e.h > yInsS)) {
        for (let dx = 0; dx < e.w; dx++) blockedSouth.add(e.tx + dx);
      }
    }
    const sExtra = ensureExtraBeaconPoles(
      beaconXs,
      geom.poleXs,
      geom.substationXs,
      yBeaconS,
      yInsS,
      yMachine,
      poleSpec,
      blockedSouth,
    );
    for (const px of sExtra.extraPoles) {
      entities.push({
        id: `${spec.id}:bps:${px}`,
        name: poleSpec.name,
        tx: px,
        ty: yInsS,
        w: 1,
        h: 1,
        direction: Dir.NORTH,
        macroId: spec.id,
        role: 'pole-macro',
      });
    }
    for (const sx of sExtra.extraSubs) {
      entities.push({
        id: `${spec.id}:bss:${sx}`,
        name: poleSpec.name,
        tx: sx,
        ty: yMachine,
        w: 2,
        h: 2,
        direction: Dir.NORTH,
        macroId: spec.id,
        role: 'pole-macro',
      });
    }
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
    .filter(
      (e) =>
        e.role === 'machine' ||
        e.role === 'beacon-macro' ||
        e.role === 'inserter-in' ||
        e.role === 'inserter-out',
    )
    .map((e) => ({ tx: e.tx, ty: e.ty, w: e.w, h: e.h }));

  const actualBeaconsPerMach = hasNorthBeacons ? 8 : hasSouthBeacons ? 4 : 0;
  const beaconTag = actualBeaconsPerMach > 0 ? ` (${actualBeaconsPerMach}B)` : '';
  const sublabel = `${spec.machineCount}× ${machineShortLabel(spec.machineName, spec.quality)}${beaconTag}`;

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
  const targetBeacons = spec.beaconsPerMachine ?? 0;
  const beaconMods = spec.beaconModules ?? [];
  if (targetBeacons >= 8) return null;

  const { northFar, northNear, southFar } = assignTracks(spec, pdk);
  if (southFar !== null) return null;
  if (spec.machineCount < 4 || !northNear) return null;

  const hasRow4Beacons = targetBeacons === 4 && beaconMods.length > 0;
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
  const ms = MACHINE_SPECS[spec.machineName].size;
  const preferStackOut = (pdk.beltStackSize ?? 1) > 1;
  const beaconTopH = hasRow4Beacons ? 3 : 0;

  // Vertical coordinates (parameterized by ms x ms machine footprint + outer beacon rows)
  const yOutTop = beaconTopH + 0;
  const yInsOutTop = beaconTopH + 1;
  const yMachTop = beaconTopH + 2; // .. +ms-1
  const yInsInTop = beaconTopH + 2 + ms;
  const yTrack1 = beaconTopH + 3 + ms;
  const yTrack2 = hasTwoInputs ? beaconTopH + 4 + ms : -1;
  const yInsInBot = hasTwoInputs ? beaconTopH + 5 + ms : beaconTopH + 4 + ms;
  const yMachBot = hasTwoInputs ? beaconTopH + 6 + ms : beaconTopH + 5 + ms;
  const yInsOutBot = yMachBot + ms;
  const yOutBot = yMachBot + ms + 1;
  const yBeaconBot = yOutBot + 1;
  const height = hasRow4Beacons ? yBeaconBot + 3 : yOutBot + 1;
  const dy = yTrack1 - 6;

  // Inserter requirements for top and bottom strips
  const topInsTrack1 = selectInserterKind(r1PerMach, 1, pdk, ms);
  const topInsTrack2 =
    hasTwoInputs && northFar ? selectInserterKind(r2PerMach, 2, pdk, ms) : null;

  const botInsTrack2 =
    hasTwoInputs && northFar ? selectInserterKind(r2PerMach, 1, pdk, ms) : null;
  const botInsTrack1 = hasTwoInputs
    ? selectInserterKind(r1PerMach, 2, pdk, ms)
    : selectInserterKind(r1PerMach, 1, pdk, ms);

  const outIns = selectInserterKind(spec.outputRatePerSec / M, 1, pdk, ms, preferStackOut);

  const nNeeded = Math.max(
    topInsTrack1.count + (topInsTrack2?.count ?? 0),
    botInsTrack1.count + (botInsTrack2?.count ?? 0),
  );
  const sNeeded = outIns.count;

  const headerW = hasDual ? 5 : 0;
  const xStart = hasRow4Beacons ? Math.max(headerW, 4) : headerW;
  const geomTop = layoutMachineRow(xStart, mTop, nNeeded, sNeeded, pdk, ms, undefined, hasRow4Beacons);
  const geomBot = layoutMachineRow(xStart, mBot, nNeeded, sNeeded, pdk, ms, undefined, hasRow4Beacons);
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
      w: ms,
      h: ms,
      direction: Dir.NORTH,
      recipe: spec.recipeId,
      quality: spec.quality,
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
      w: ms,
      h: ms,
      direction: Dir.NORTH,
      macroId: spec.id,
      recipe: spec.recipeId,
      quality: spec.quality,
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
    const slotXs = Array.from({ length: ms }, (_, k) => mx + k);
    const inFree = slotXs.filter((x) => !topPoleSet.has(x));
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

    const outFree = slotXs.filter((x) => !topPoleSet.has(x));
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
    const slotXs = Array.from({ length: ms }, (_, k) => mx + k);
    const inFree = slotXs.filter((x) => !botPoleSet.has(x));
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

    const outFree = slotXs.filter((x) => !botPoleSet.has(x));
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
  const topBeaconXs = hasRow4Beacons ? computeBeaconStripXs(geomTop.machineXs, ms, 0) : [];
  const botBeaconXs = hasRow4Beacons ? computeBeaconStripXs(geomBot.machineXs, ms, 0) : [];
  const maxBeaconEnd = Math.max(
    0,
    ...topBeaconXs.map((bx) => bx + 3),
    ...botBeaconXs.map((bx) => bx + 3),
  );
  const width = Math.max(dropX + 3, maxBeaconEnd);

  const trackMeta = (t: typeof northNear) =>
    t.items.length === 2
      ? { laneItems: [t.items[0].item, t.items[1].item] as [string, string] }
      : { item: t.items[0].item };
  const t1Meta = trackMeta(northNear);
  const t2Meta = northFar ? trackMeta(northFar) : null;

  if (hasDual) {
    // 5-tile West header (x=0..4) merges dual-lane center tracks with 2-tile vertical pin spacing (shifted by dy = yTrack1 - 6)
    if (hasTwoInputs && northFar && t2Meta) {
      if (northFar.isDualLane) {
        const [b1, b2] = northFar.items;
        entities.push(mkBelt(0, 6 + dy, Dir.EAST, b1.item));
        addInPin(b1.item, b1.ratePerSec, 0, 6 + dy, Dir.EAST);
        entities.push(mkBelt(1, 6 + dy, Dir.SOUTH, b1.item));

        entities.push(mkBelt(0, 8 + dy, Dir.EAST, b2.item));
        addInPin(b2.item, b2.ratePerSec, 0, 8 + dy, Dir.EAST);
        entities.push(mkBelt(1, 8 + dy, Dir.NORTH, b2.item));

        entities.push(
          mkBelt(1, 7 + dy, Dir.EAST, undefined, true, [b1.item, b2.item]),
        );
      } else {
        const [b1] = northFar.items;
        entities.push(mkBelt(0, 7 + dy, Dir.EAST, b1.item));
        addInPin(b1.item, b1.ratePerSec, 0, 7 + dy, Dir.EAST);
        entities.push(mkBelt(1, 7 + dy, Dir.EAST, b1.item));
      }

      if (track1Dual) {
        entities.push({
          id: eid('ug2i'),
          name: beltSpec.undergroundName,
          tx: 2,
          ty: 7 + dy,
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
          ty: 7 + dy,
          w: 1,
          h: 1,
          direction: Dir.EAST,
          type: 'output',
          macroId: spec.id,
          role: 'ug-macro',
        });
      } else {
        entities.push(mkBelt(2, 7 + dy, Dir.EAST, t2Meta.item, false, t2Meta.laneItems));
        entities.push(mkBelt(3, 7 + dy, Dir.EAST, t2Meta.item, false, t2Meta.laneItems));
        entities.push(mkBelt(4, 7 + dy, Dir.EAST, t2Meta.item, false, t2Meta.laneItems));
      }
    }

    if (track1Dual) {
      const [a1, a2] = northNear.items;
      entities.push(mkBelt(0, 4 + dy, Dir.EAST, a1.item));
      addInPin(a1.item, a1.ratePerSec, 0, 4 + dy, Dir.EAST);
      entities.push(mkBelt(1, 4 + dy, Dir.EAST, a1.item));
      entities.push(mkBelt(2, 4 + dy, Dir.EAST, a1.item));
      entities.push(mkBelt(3, 4 + dy, Dir.SOUTH, a1.item));
      entities.push(mkBelt(3, 5 + dy, Dir.SOUTH, a1.item));

      entities.push(mkBelt(0, 10 + dy, Dir.EAST, a2.item));
      addInPin(a2.item, a2.ratePerSec, 0, 10 + dy, Dir.EAST);
      entities.push(mkBelt(1, 10 + dy, Dir.EAST, a2.item));
      entities.push(mkBelt(2, 10 + dy, Dir.EAST, a2.item));
      entities.push(mkBelt(3, 10 + dy, Dir.NORTH, a2.item));
      entities.push(mkBelt(3, 9 + dy, Dir.NORTH, a2.item));
      entities.push(mkBelt(3, 8 + dy, Dir.NORTH, a2.item));
      entities.push(mkBelt(3, 7 + dy, Dir.NORTH, a2.item));

      entities.push(
        mkBelt(3, 6 + dy, Dir.EAST, undefined, true, [a1.item, a2.item]),
      );
      entities.push(
        mkBelt(4, 6 + dy, Dir.EAST, undefined, false, [a1.item, a2.item]),
      );
    } else {
      // Single high-rate item on Track 1 curves around (1,6+dy) into (4,6+dy) -> full 2-lane belt
      const [a1] = northNear.items;
      entities.push(mkBelt(0, 4 + dy, Dir.EAST, a1.item));
      addInPin(a1.item, a1.ratePerSec, 0, 4 + dy, Dir.EAST);
      entities.push(mkBelt(1, 4 + dy, Dir.EAST, a1.item));
      entities.push(mkBelt(2, 4 + dy, Dir.EAST, a1.item));
      entities.push(mkBelt(3, 4 + dy, Dir.EAST, a1.item));
      entities.push(mkBelt(4, 4 + dy, Dir.SOUTH, a1.item));
      entities.push(mkBelt(4, 5 + dy, Dir.SOUTH, a1.item));
      entities.push(mkBelt(4, 6 + dy, Dir.EAST, a1.item));
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
  for (let x = xStart; x < dropX; x++) {
    entities.push(mkBelt(x, yOutTop, Dir.EAST, spec.outputItem));
  }
  for (let y = yOutTop; y < yOutBot - 1; y++) {
    entities.push(mkBelt(dropX, y, Dir.SOUTH, spec.outputItem));
  }
  entities.push(mkBelt(dropX, yOutBot - 1, Dir.EAST, spec.outputItem));

  for (let x = xStart; x <= dropX; x++) {
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
  for (let x = dropX + 3; x < width; x++) {
    entities.push(mkBelt(x, yOutBot, Dir.EAST, spec.outputItem));
  }

  if (hasRow4Beacons) {
    for (const bx of topBeaconXs) {
      entities.push({
        id: eid(`bt:${bx}`),
        name: 'beacon',
        tx: bx,
        ty: 0,
        w: 3,
        h: 3,
        direction: Dir.NORTH,
        items: [...beaconMods],
        quality: spec.quality,
        macroId: spec.id,
        role: 'beacon-macro',
      });
    }
    for (const bx of botBeaconXs) {
      entities.push({
        id: eid(`bb:${bx}`),
        name: 'beacon',
        tx: bx,
        ty: yBeaconBot,
        w: 3,
        h: 3,
        direction: Dir.NORTH,
        items: [...beaconMods],
        quality: spec.quality,
        macroId: spec.id,
        role: 'beacon-macro',
      });
    }

    const blockedTop = new Set<number>([dropX, dropX + 1]);
    for (const e of entities) {
      if (e.ty === yInsOutTop) blockedTop.add(e.tx);
    }
    const topExtra = ensureExtraBeaconPoles(
      topBeaconXs,
      geomTop.poleXs,
      geomTop.substationXs,
      0,
      yInsOutTop,
      yMachTop,
      poleSpec,
      blockedTop,
    );
    for (const px of topExtra.extraPoles) {
      entities.push({
        id: eid(`bpt:${px}`),
        name: poleSpec.name,
        tx: px,
        ty: yInsOutTop,
        w: 1,
        h: 1,
        direction: Dir.NORTH,
        macroId: spec.id,
        role: 'pole-macro',
      });
    }
    for (const sx of topExtra.extraSubs) {
      entities.push({
        id: eid(`bst:${sx}`),
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

    const blockedBot = new Set<number>([dropX, dropX + 1]);
    for (const e of entities) {
      if (e.ty === yInsOutBot) blockedBot.add(e.tx);
    }
    const botExtra = ensureExtraBeaconPoles(
      botBeaconXs,
      geomBot.poleXs,
      geomBot.substationXs,
      yBeaconBot,
      yInsOutBot,
      yMachBot,
      poleSpec,
      blockedBot,
    );
    for (const px of botExtra.extraPoles) {
      entities.push({
        id: eid(`bpb:${px}`),
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
    for (const sx of botExtra.extraSubs) {
      entities.push({
        id: eid(`bsb:${sx}`),
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
  }

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
    .filter(
      (e) =>
        e.role === 'machine' ||
        e.role === 'beacon-macro' ||
        e.role === 'inserter-in' ||
        e.role === 'inserter-out',
    )
    .map((e) => ({ tx: e.tx, ty: e.ty, w: e.w, h: e.h }));

  const sublabel = `${spec.machineCount}× ${machineShortLabel(spec.machineName, spec.quality)}${hasRow4Beacons ? ' (4B)' : ''}`;

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

function fluidPortOffset(
  machineName: MachineName,
  fluidIndex: number,
  dir: Dir,
): number {
  if (machineName === 'foundry') {
    return fluidIndex === 0 ? 1 : 3;
  }
  if (machineName === 'cryogenic-plant') {
    return fluidIndex === 0 ? 0 : 4;
  }
  if (machineName === 'electromagnetic-plant') {
    if (dir === Dir.SOUTH) return 2;
    return fluidIndex === 0 ? 2 : 1;
  }
  if (dir === Dir.SOUTH) {
    return machineName === 'chemical-plant' ? 2 : 1;
  }
  return fluidIndex === 0 ? 0 : 2;
}

function buildFluidRecipeMacro(spec: RecipeMacroSpec, pdk: PdkConfig): CompiledMacro {
  const catalog = getCatalog();
  const recipe = catalog.recipesById[spec.recipeId];
  const beltSpec = BELT_SPECS[spec.beltTier];
  const poleSpec = POLE_SPECS[pdk.defaultPoleTier];
  const beltCap = effectiveBeltCapacity(spec.beltTier, pdk);
  const ms = MACHINE_SPECS[spec.machineName].size;
  const preferStackOut = (pdk.beltStackSize ?? 1) > 1;
  const fluids = spec.fluidInputs ?? [];
  const isTwoFluid = fluids.length >= 2;
  const isSplitTwoFluid = isTwoFluid && spec.machineName === 'electromagnetic-plant';
  const hasSouthFluid = !isTwoFluid || isSplitTwoFluid;
  const M = spec.machineCount;

  const solidIngs = [...spec.ingredientRates].sort((a, b) => b.ratePerSec - a.ratePerSec);
  let northNearTrack: IngredientTrack | null = null;
  let northFarTrack: IngredientTrack | null = null;
  if (!isTwoFluid) {
    if (solidIngs.length >= 4) {
      northNearTrack = {
        items: [solidIngs[0], solidIngs[3]],
        isDualLane: true,
      };
      northFarTrack = {
        items: [solidIngs[1], solidIngs[2]],
        isDualLane: true,
      };
    } else if (solidIngs.length === 3) {
      northNearTrack = {
        items: [solidIngs[0]],
        isDualLane: false,
      };
      northFarTrack = {
        items: [solidIngs[1], solidIngs[2]],
        isDualLane: true,
      };
    } else {
      northNearTrack = solidIngs[0]
        ? { items: [solidIngs[0]], isDualLane: false }
        : null;
      northFarTrack = solidIngs[1]
        ? { items: [solidIngs[1]], isDualLane: false }
        : null;
    }
  } else if (isSplitTwoFluid) {
    if (solidIngs.length >= 2) {
      northNearTrack = {
        items: [solidIngs[0], solidIngs[1]],
        isDualLane: true,
      };
    } else if (solidIngs.length === 1) {
      northNearTrack = {
        items: [solidIngs[0]],
        isDualLane: false,
      };
    }
  }

  const northFarRate = northFarTrack
    ? northFarTrack.items.reduce((a, b) => a + b.ratePerSec, 0)
    : 0;
  const northNearRate = northNearTrack
    ? northNearTrack.items.reduce((a, b) => a + b.ratePerSec, 0)
    : 0;

  const northFarIns = northFarTrack
    ? selectInserterKind(northFarRate / M, 2, pdk, ms)
    : null;
  const northNearIns = northNearTrack
    ? selectInserterKind(northNearRate / M, 1, pdk, ms)
    : null;
  const outSlotsMax = hasSouthFluid ? Math.max(1, ms - 1) : ms;
  const outIns = selectInserterKind(
    spec.outputRatePerSec / M,
    1,
    pdk,
    outSlotsMax,
    preferStackOut,
  );

  const needsLaneBalance =
    Boolean(spec.balanceOutputLanes) || spec.outputRatePerSec > beltCap * 0.49;
  const laneFlipAfterIdx =
    needsLaneBalance && M >= 2 ? Math.floor(M / 2) - 1 : undefined;
  const tailW = needsLaneBalance && M === 1 ? 2 : 0;

  const hasDualNorth =
    !isTwoFluid &&
    Boolean(northFarTrack?.isDualLane || northNearTrack?.isDualLane);
  const isCompactDualNorthNear =
    isSplitTwoFluid && Boolean(northNearTrack?.isDualLane);

  const poleGap = poleSpec.name === 'substation' ? 2 : 1;
  const poleX0 = hasDualNorth ? 5 : isCompactDualNorthNear ? 2 : 0;
  const xStart = poleX0 + poleGap;
  const stride = ms + poleGap;
  const splitExtra = poleSpec.name === 'substation' ? 3 : 4;

  const machineXs: number[] = [];
  for (let i = 0; i < M; i++) {
    const gapSplit =
      laneFlipAfterIdx !== undefined && i > laneFlipAfterIdx ? splitExtra : 0;
    machineXs.push(xStart + i * stride + gapSplit);
  }
  const lastEndX =
    M > 0 ? machineXs[M - 1] + ms + poleGap : xStart + poleGap;
  const laneFlipX =
    laneFlipAfterIdx !== undefined && M >= 2
      ? machineXs[laneFlipAfterIdx] + ms + poleGap
      : undefined;
  const width = Math.max(lastEndX + tailW, xStart + 1);

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
    id: `${spec.id}:fh:${hid++}`,
    name: beltSpec.beltName,
    tx,
    ty,
    w: 1,
    h: 1,
    direction,
    macroId: spec.id,
    item,
    laneItems,
    role: 'belt-macro',
    intentionalSideLoad,
  });

  const mkPipe = (tx: number, ty: number, item: string) => {
    entities.push({
      id: `${spec.id}:fp:${hid++}`,
      name: 'pipe',
      tx,
      ty,
      w: 1,
      h: 1,
      direction: Dir.NORTH,
      macroId: spec.id,
      item,
      role: 'pipe-macro',
    });
  };

  const mkPipeUg = (tx: number, ty: number, direction: Dir, item: string) => {
    entities.push({
      id: `${spec.id}:fpu:${hid++}`,
      name: 'pipe-to-ground',
      tx,
      ty,
      w: 1,
      h: 1,
      direction,
      macroId: spec.id,
      item,
      role: 'pipe-ug-macro',
    });
  };

  const addInPin = (
    item: string,
    ratePerSec: number,
    x: number,
    y: number,
    dir: Dir,
    isFluid = false,
  ) => {
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
      isFluid: isFluid || undefined,
    });
  };

  const northTracks =
    !isTwoFluid && !hasDualNorth
      ? (northFarTrack ? 1 : 0) + (northNearTrack ? 1 : 0)
      : 0;
  const yFarN = isTwoFluid ? 0 : hasDualNorth ? 1 : 0;
  const yNearN = isSplitTwoFluid
    ? 2
    : isTwoFluid
      ? 0
      : hasDualNorth
        ? 2
        : northFarTrack
          ? 1
          : 0;
  const yInsN = isTwoFluid
    ? 3
    : hasDualNorth
      ? 3
      : northTracks > 0
        ? northTracks
        : 0;
  const yMachine = isTwoFluid
    ? 4
    : hasDualNorth
      ? 4
      : northTracks > 0
        ? northTracks + 1
        : 1;
  const yInsS = yMachine + ms;
  const yOut = yInsS + 1;
  const yFluidDrop = yOut + 1;
  const yFluidSouth = yOut + 2;
  const height = hasSouthFluid ? yFluidSouth + 1 : yOut + 1;

  const machDir = isSplitTwoFluid
    ? Dir.WEST
    : isTwoFluid
      ? spec.machineName === 'foundry' || spec.machineName === 'cryogenic-plant'
        ? Dir.SOUTH
        : Dir.NORTH
      : spec.machineName === 'foundry' || spec.machineName === 'cryogenic-plant'
        ? Dir.NORTH
        : spec.machineName === 'electromagnetic-plant'
          ? Dir.WEST
          : Dir.SOUTH;
  const fOff0 = isTwoFluid
    ? fluidPortOffset(spec.machineName, 0, Dir.NORTH)
    : fluidPortOffset(spec.machineName, 0, Dir.SOUTH);
  const fOff1 = isTwoFluid ? fluidPortOffset(spec.machineName, 1, Dir.NORTH) : 0;

  let maxNorthInX = 0;
  const placedPoles = new Set<string>();
  const mkPole = (px: number, py: number) => {
    const k = `${px},${py}`;
    if (placedPoles.has(k)) return;
    placedPoles.add(k);
    entities.push({
      id: `${spec.id}:fpole:${hid++}`,
      name: poleSpec.name,
      tx: px,
      ty: py,
      w: poleSpec.size,
      h: poleSpec.size,
      direction: Dir.NORTH,
      macroId: spec.id,
      role: 'pole-macro',
    });
  };

  // Initial poles before machine 0
  if (poleSpec.name === 'substation') {
    mkPole(poleX0, yMachine);
  } else {
    mkPole(poleX0, yInsN);
    mkPole(poleX0, yInsS);
  }

  for (let i = 0; i < M; i++) {
    const mx = machineXs[i];
    entities.push({
      id: `${spec.id}:fm:${i}`,
      name: spec.machineName,
      tx: mx,
      ty: yMachine,
      w: ms,
      h: ms,
      direction: machDir,
      hasFluidBox: true,
      recipe: spec.recipeId,
      quality: spec.quality,
      items: spec.modules.length > 0 ? [...spec.modules] : undefined,
      macroId: spec.id,
      item: spec.outputItem,
      role: 'machine',
    });

    // North solid inserters (when 1-fluid or split 2-fluid EM Plant)
    if ((!isTwoFluid || isSplitTwoFluid) && (northNearIns || northFarIns)) {
      const slotPool = Array.from({ length: ms }, (_, k) => mx + k)
        .filter((x) => !(isSplitTwoFluid && x === mx + fOff1))
        .filter((x) => !(ms === 5 && poleSpec.tier === 'small' && x === mx + 2));
      let cursor = 0;
      if (northNearIns && northNearTrack) {
        const nearLim = northFarIns ? Math.max(1, slotPool.length - 1) : slotPool.length;
        for (let c = 0; c < northNearIns.count && cursor < nearLim; c++) {
          const ix = slotPool[cursor++];
          if (ix > maxNorthInX) maxNorthInX = ix;
          entities.push({
            id: `${spec.id}:finn:${hid++}`,
            name: INSERTER_SPECS[northNearIns.kind].name,
            tx: ix,
            ty: yInsN,
            w: 1,
            h: 1,
            direction: Dir.NORTH,
            macroId: spec.id,
            role: 'inserter-in',
          });
        }
      }
      if (northFarIns && northFarTrack) {
        for (let c = 0; c < northFarIns.count && cursor < slotPool.length; c++) {
          const ix = slotPool[cursor++];
          if (ix > maxNorthInX) maxNorthInX = ix;
          entities.push({
            id: `${spec.id}:finf:${hid++}`,
            name: INSERTER_SPECS[northFarIns.kind].name,
            tx: ix,
            ty: yInsN,
            w: 1,
            h: 1,
            direction: Dir.NORTH,
            macroId: spec.id,
            role: 'inserter-in',
          });
        }
      }
    }

    // Fluid taps per machine
    if (isSplitTwoFluid) {
      mkPipeUg(mx + fOff0, yInsS, Dir.NORTH, fluids[0].item);
      mkPipeUg(mx + fOff0, yFluidDrop, Dir.SOUTH, fluids[0].item);
      mkPipeUg(mx + fOff1, 1, Dir.NORTH, fluids[1].item);
      mkPipeUg(mx + fOff1, yInsN, Dir.SOUTH, fluids[1].item);
    } else if (isTwoFluid) {
      mkPipe(mx + fOff0, yInsN, fluids[0].item);
      mkPipeUg(mx + fOff1, 1, Dir.NORTH, fluids[1].item);
      mkPipeUg(mx + fOff1, yInsN, Dir.SOUTH, fluids[1].item);
    } else if (fluids[0]) {
      mkPipeUg(mx + fOff0, yInsS, Dir.NORTH, fluids[0].item);
      mkPipeUg(mx + fOff0, yFluidDrop, Dir.SOUTH, fluids[0].item);
    }

    // Output inserters along yInsS avoiding fluid port slot if South fluid is present
    const outSlots = Array.from({ length: ms }, (_, k) => k)
      .filter((k) => (!hasSouthFluid ? true : k !== fOff0))
      .filter((k) => !(ms === 5 && poleSpec.tier === 'small' && k === 2));
    for (let c = 0; c < outIns.count && c < outSlots.length; c++) {
      entities.push({
        id: `${spec.id}:fout:${hid++}`,
        name: INSERTER_SPECS[outIns.kind].name,
        tx: mx + outSlots[c],
        ty: yInsS,
        w: 1,
        h: 1,
        direction: Dir.NORTH,
        macroId: spec.id,
        role: 'inserter-out',
      });
    }

    // Gap pole after each machine
    if (poleSpec.name === 'substation') {
      mkPole(mx + ms, yMachine);
    } else {
      mkPole(mx + ms, yInsN);
      mkPole(mx + ms, yInsS);
    }
  }

  if (laneFlipX !== undefined && poleSpec.name !== 'substation') {
    mkPole(laneFlipX + 3, yInsN);
    mkPole(laneFlipX + 3, yInsS);
  }

  // North solid belts & merge headers
  if ((!isTwoFluid || isSplitTwoFluid) && (northFarTrack || northNearTrack)) {
    const inEndX = M > 0 ? Math.min(lastEndX, maxNorthInX + 1) : xStart;
    const trackMeta = (t: IngredientTrack | null) =>
      t
        ? t.items.length === 2
          ? { laneItems: [t.items[0].item, t.items[1].item] as [string, string] }
          : { item: t.items[0]?.item }
        : {};

    if (hasDualNorth) {
      if (northFarTrack) {
        if (northFarTrack.isDualLane) {
          const [a1, a2] = northFarTrack.items;
          entities.push(mkBelt(0, 0, Dir.EAST, a1.item));
          addInPin(a1.item, a1.ratePerSec, 0, 0, Dir.EAST);
          entities.push(mkBelt(1, 0, Dir.SOUTH, a1.item));

          entities.push(mkBelt(0, 2, Dir.EAST, a2.item));
          addInPin(a2.item, a2.ratePerSec, 0, 2, Dir.EAST);
          entities.push(mkBelt(1, 2, Dir.NORTH, a2.item));

          entities.push(mkBelt(1, 1, Dir.EAST, undefined, true, [a1.item, a2.item]));
        } else {
          const [a1] = northFarTrack.items;
          entities.push(mkBelt(0, 1, Dir.EAST, a1.item));
          addInPin(a1.item, a1.ratePerSec, 0, 1, Dir.EAST);
          entities.push(mkBelt(1, 1, Dir.EAST, a1.item));
        }
        entities.push({
          id: `${spec.id}:fh:${hid++}`,
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
          id: `${spec.id}:fh:${hid++}`,
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
        const farMeta = trackMeta(northFarTrack);
        for (let x = 5; x < inEndX; x++) {
          entities.push(mkBelt(x, yFarN, Dir.EAST, farMeta.item, false, farMeta.laneItems));
        }
      }

      if (northNearTrack) {
        if (northNearTrack.isDualLane) {
          const [b1, b2] = northNearTrack.items;
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
          const [b1] = northNearTrack.items;
          entities.push(mkBelt(3, 0, Dir.SOUTH, b1.item));
          addInPin(b1.item, b1.ratePerSec, 3, 0, Dir.SOUTH);
          entities.push(mkBelt(3, 1, Dir.SOUTH, b1.item));
          entities.push(mkBelt(3, 2, Dir.EAST, b1.item));
          entities.push(mkBelt(4, 2, Dir.EAST, b1.item));
        }
        const nearMeta = trackMeta(northNearTrack);
        for (let x = 5; x < inEndX; x++) {
          entities.push(mkBelt(x, yNearN, Dir.EAST, nearMeta.item, false, nearMeta.laneItems));
        }
      }
    } else if (isCompactDualNorthNear && northNearTrack) {
      const [a1, a2] = northNearTrack.items;
      entities.push(mkBelt(0, yNearN, Dir.EAST, a1.item));
      addInPin(a1.item, a1.ratePerSec, 0, yNearN, Dir.EAST);
      entities.push(mkBelt(1, yNearN, Dir.EAST, undefined, true, [a1.item, a2.item]));

      entities.push(mkBelt(0, yMachine, Dir.EAST, a2.item));
      addInPin(a2.item, a2.ratePerSec, 0, yMachine, Dir.EAST);
      entities.push(mkBelt(1, yMachine, Dir.NORTH, a2.item));
      entities.push(mkBelt(1, yInsN, Dir.NORTH, a2.item));

      for (let x = 2; x < inEndX; x++) {
        entities.push(mkBelt(x, yNearN, Dir.EAST, undefined, false, [a1.item, a2.item]));
      }
    } else {
      if (northFarTrack) {
        const a1 = northFarTrack.items[0];
        for (let x = 0; x < inEndX; x++) {
          entities.push(mkBelt(x, yFarN, Dir.EAST, a1.item));
        }
        addInPin(a1.item, a1.ratePerSec, 0, yFarN, Dir.EAST);
      }
      if (northNearTrack) {
        const b1 = northNearTrack.items[0];
        for (let x = 0; x < inEndX; x++) {
          entities.push(mkBelt(x, yNearN, Dir.EAST, b1.item));
        }
        addInPin(b1.item, b1.ratePerSec, 0, yNearN, Dir.EAST);
      }
    }
  }

  // Horizontal fluid headers
  if (isSplitTwoFluid) {
    const f0End = M > 0 ? machineXs[M - 1] + fOff0 + 1 : xStart + 1;
    for (let x = 0; x < f0End; x++) {
      mkPipe(x, yFluidSouth, fluids[0].item);
    }
    addInPin(fluids[0].item, fluids[0].ratePerSec, 0, yFluidSouth, Dir.EAST, true);

    const f1End = M > 0 ? machineXs[M - 1] + fOff1 + 1 : xStart + 1;
    for (let x = 0; x < f1End; x++) {
      mkPipe(x, 0, fluids[1].item);
    }
    addInPin(fluids[1].item, fluids[1].ratePerSec, 0, 0, Dir.EAST, true);
  } else if (isTwoFluid) {
    const f0End = M > 0 ? machineXs[M - 1] + fOff0 + 1 : xStart + 1;
    for (let x = 0; x < f0End; x++) {
      mkPipe(x, 2, fluids[0].item);
    }
    addInPin(fluids[0].item, fluids[0].ratePerSec, 0, 2, Dir.EAST, true);

    const f1End = M > 0 ? machineXs[M - 1] + fOff1 + 1 : xStart + 1;
    for (let x = 0; x < f1End; x++) {
      mkPipe(x, 0, fluids[1].item);
    }
    addInPin(fluids[1].item, fluids[1].ratePerSec, 0, 0, Dir.EAST, true);
  } else if (fluids[0]) {
    const f0End = M > 0 ? machineXs[M - 1] + fOff0 + 1 : xStart + 1;
    for (let x = 0; x < f0End; x++) {
      mkPipe(x, yFluidSouth, fluids[0].item);
    }
    addInPin(fluids[0].item, fluids[0].ratePerSec, 0, yFluidSouth, Dir.EAST, true);
  }

  // Output belt + mid-row jog / tail splitter
  for (let x = xStart; x < lastEndX; x++) {
    if (laneFlipX !== undefined && x >= laneFlipX && x <= laneFlipX + 2) {
      if (x === laneFlipX) {
        entities.push(mkBelt(x, yOut, Dir.NORTH, spec.outputItem));
      } else if (x === laneFlipX + 2) {
        entities.push(mkBelt(x, yOut, Dir.EAST, spec.outputItem, true));
      }
      continue;
    }
    entities.push(mkBelt(x, yOut, Dir.EAST, spec.outputItem));
  }
  if (laneFlipX !== undefined) {
    entities.push(mkBelt(laneFlipX, yInsS, Dir.EAST, spec.outputItem));
    entities.push(mkBelt(laneFlipX + 1, yInsS, Dir.EAST, spec.outputItem));
    entities.push(mkBelt(laneFlipX + 2, yInsS, Dir.SOUTH, spec.outputItem));
  }
  if (tailW === 2) {
    entities.push({
      id: `${spec.id}:ftail:sp`,
      name: beltSpec.splitterName,
      tx: lastEndX,
      ty: yInsS,
      w: 1,
      h: 2,
      direction: Dir.EAST,
      macroId: spec.id,
      role: 'splitter-macro',
    });
    entities.push(mkBelt(lastEndX + 1, yInsS, Dir.SOUTH, spec.outputItem));
    entities.push(mkBelt(lastEndX + 1, yOut, Dir.EAST, spec.outputItem, true));
  }
  for (let x = lastEndX + tailW; x < width; x++) {
    entities.push(mkBelt(x, yOut, Dir.EAST, spec.outputItem));
  }

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
    .filter(
      (e) =>
        e.role === 'machine' ||
        e.role === 'inserter-in' ||
        e.role === 'inserter-out',
    )
    .map((e) => ({ tx: e.tx, ty: e.ty, w: e.w, h: e.h }));

  return {
    id: spec.id,
    kind: 'recipe-macro',
    label: recipe?.name ?? spec.outputItem,
    sublabel: `${spec.machineCount}× ${machineShortLabel(spec.machineName, spec.quality)}`,
    recipeId: spec.recipeId,
    outputItem: spec.outputItem,
    rows: 1,
    width,
    height,
    rotation: 0,
    noFlipY: true,
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
  if ((spec.fluidInputs?.length ?? 0) > 0) {
    return [buildFluidRecipeMacro(spec, pdk)];
  }
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
