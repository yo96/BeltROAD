import {
  DrcReport,
  DrcViolation,
  EntityInstance,
  FloorplanResult,
  RouteResult,
} from '../types.js';
import {
  BELT_SPECS,
  INSERTER_BY_ENTITY_NAME,
  PIPE_SPEC,
  POLE_BY_ENTITY_NAME,
  beltTierFromEntityName,
  doesPoleSupplyEntity,
  isBeltLikeName,
  isMachineName,
  isPipeName,
  isPipeUndergroundName,
  isSplitterName,
  isUndergroundName,
  requiresPower,
} from '../data/entities.js';
import { dirDelta, inserterReachTiles, oppositeDir } from '../geometry.js';

export function runDrc(
  entities: EntityInstance[],
  width: number,
  height: number,
  routeResult?: RouteResult,
  allowOutOfBoundsMarkers = true,
  floorplan?: FloorplanResult,
): DrcReport {
  const violations: DrcViolation[] = [];
  let vid = 0;
  const addV = (
    code: DrcViolation['code'],
    severity: 'error' | 'warning',
    message: string,
    tx: number,
    ty: number,
    entityIds: string[],
  ) => {
    violations.push({
      id: `drc:${vid++}`,
      code,
      severity,
      message,
      tx,
      ty,
      entityIds,
    });
  };

  // 0. Check unrouted nets if routeResult provided
  if (routeResult) {
    for (const rn of routeResult.routedNets) {
      if (!rn.routed) {
        addV(
          'UNROUTED_NET',
          'error',
          `Net "${rn.netId}" (${rn.item}) could not be routed.`,
          0,
          0,
          [],
        );
      }
    }
  }

  // 1. Bounds & Collision check
  const tileOccupancy = new Map<string, EntityInstance[]>();
  for (const e of entities) {
    if (e.role === 'port-marker' && allowOutOfBoundsMarkers) {
      continue;
    }
    if (e.tx < 0 || e.ty < 0 || e.tx + e.w > width || e.ty + e.h > height) {
      addV(
        'DIE_BOUNDS',
        'error',
        `Entity "${e.name}" at (${e.tx},${e.ty}) extends outside die bounds (${width}x${height}).`,
        e.tx,
        e.ty,
        [e.id],
      );
    }

    for (let dx = 0; dx < e.w; dx++) {
      for (let dy = 0; dy < e.h; dy++) {
        const key = `${e.tx + dx},${e.ty + dy}`;
        let list = tileOccupancy.get(key);
        if (!list) {
          list = [];
          tileOccupancy.set(key, list);
        }
        list.push(e);
      }
    }
  }

  for (const [key, list] of tileOccupancy.entries()) {
    if (list.length > 1) {
      const [xs, ys] = key.split(',').map(Number);
      addV(
        'COLLISION',
        'error',
        `Tile collision at (${xs},${ys}) between ${list.map((e) => e.name).join(' and ')}.`,
        xs,
        ys,
        list.map((e) => e.id),
      );
    }
  }

  // 2. Underground pairing & NO BELT WEAVING check
  const undergrounds = entities.filter((e) => isUndergroundName(e.name));
  const ugByTile = new Map<string, EntityInstance>();
  for (const u of undergrounds) {
    ugByTile.set(`${u.tx},${u.ty}`, u);
  }

  const horizSpans = new Map<string, EntityInstance[]>();
  const vertSpans = new Map<string, EntityInstance[]>();
  const pairedOutputs = new Set<string>();

  for (const u of undergrounds) {
    if (u.type !== 'input') continue;
    const tier = beltTierFromEntityName(u.name)!;
    const maxDist = BELT_SPECS[tier].maxUgDistance;
    const { dx, dy } = dirDelta(u.direction);
    const isHoriz = dx !== 0;

    let foundPartner: EntityInstance | null = null;
    let foundDist = 0;
    for (let step = 1; step <= maxDist; step++) {
      const cand = ugByTile.get(`${u.tx + dx * step},${u.ty + dy * step}`);
      if (!cand) continue;
      if (cand.direction === u.direction) {
        if (cand.type === 'output' && beltTierFromEntityName(cand.name) === tier) {
          foundPartner = cand;
          foundDist = step;
          break;
        }
        // An intervening same-direction input or different-tier output on the same axis terminates/breaks pairing
        break;
      }
    }

    if (!foundPartner) {
      addV(
        'UNDERGROUND_PAIR',
        'error',
        `Unpaired ${u.name} input at (${u.tx},${u.ty}).`,
        u.tx,
        u.ty,
        [u.id],
      );
      continue;
    }

    pairedOutputs.add(foundPartner.id);
    const spanMap = isHoriz ? horizSpans : vertSpans;
    for (let k = 0; k <= foundDist; k++) {
      const key = `${u.tx + dx * k},${u.ty + dy * k}`;
      let arr = spanMap.get(key);
      if (!arr) {
        arr = [];
        spanMap.set(key, arr);
      }
      arr.push(u);
    }
  }

  for (const u of undergrounds) {
    if (u.type === 'output' && !pairedOutputs.has(u.id)) {
      addV(
        'UNDERGROUND_PAIR',
        'error',
        `Unpaired ${u.name} output at (${u.tx},${u.ty}).`,
        u.tx,
        u.ty,
        [u.id],
      );
    }
  }

  for (const [spanName, spanMap] of [
    ['horizontal', horizSpans],
    ['vertical', vertSpans],
  ] as const) {
    for (const [key, list] of spanMap.entries()) {
      if (list.length > 1) {
        const [xs, ys] = key.split(',').map(Number);
        addV(
          'NO_BELT_WEAVING',
          'error',
          `Overlapping ${spanName} underground belts at (${xs},${ys}) (belt weaving forbidden).`,
          xs,
          ys,
          list.map((e) => e.id),
        );
      }
    }
  }

  // 2b. Underground pipe pairing & axis-span check
  const pipeUndergrounds = entities.filter((e) => isPipeUndergroundName(e.name));
  const pipeUgByTile = new Map<string, EntityInstance>();
  for (const pu of pipeUndergrounds) {
    pipeUgByTile.set(`${pu.tx},${pu.ty}`, pu);
  }
  const pipeHorizSpans = new Map<string, EntityInstance[]>();
  const pipeVertSpans = new Map<string, EntityInstance[]>();

  for (const u of pipeUndergrounds) {
    const oppDir = oppositeDir(u.direction);
    const { dx, dy } = dirDelta(oppDir);
    const isHoriz = dx !== 0;

    let partner: EntityInstance | null = null;
    let foundDist = 0;
    for (let step = 1; step <= PIPE_SPEC.maxUgDistance; step++) {
      const cand = pipeUgByTile.get(`${u.tx + dx * step},${u.ty + dy * step}`);
      if (!cand) continue;
      if (cand.direction === oppDir) {
        partner = cand;
        foundDist = step;
        break;
      }
      if (cand.direction === u.direction) {
        break;
      }
    }

    if (!partner) {
      addV(
        'PIPE_UG_PAIR',
        'error',
        `Unpaired pipe-to-ground at (${u.tx},${u.ty}).`,
        u.tx,
        u.ty,
        [u.id],
      );
      continue;
    }

    if (u.id < partner.id) {
      if (u.item && partner.item && u.item !== partner.item) {
        addV(
          'NO_FLUID_MIXING',
          'error',
          `Underground pipe fluid mixing (${u.item} vs ${partner.item}) between (${u.tx},${u.ty}) and (${partner.tx},${partner.ty}).`,
          u.tx,
          u.ty,
          [u.id, partner.id],
        );
      }
      const spanMap = isHoriz ? pipeHorizSpans : pipeVertSpans;
      for (let k = 0; k <= foundDist; k++) {
        const key = `${u.tx + dx * k},${u.ty + dy * k}`;
        let arr = spanMap.get(key);
        if (!arr) {
          arr = [];
          spanMap.set(key, arr);
        }
        arr.push(u);
      }
    }
  }

  for (const [spanName, spanMap] of [
    ['horizontal', pipeHorizSpans],
    ['vertical', pipeVertSpans],
  ] as const) {
    for (const [key, list] of spanMap.entries()) {
      if (list.length > 1) {
        const [xs, ys] = key.split(',').map(Number);
        addV(
          'PIPE_UG_PAIR',
          'error',
          `Overlapping ${spanName} underground pipes at (${xs},${ys}).`,
          xs,
          ys,
          list.map((e) => e.id),
        );
      }
    }
  }

  // 3. Inserter validation (valid pickup & drop targets)
  for (const e of entities) {
    const insSpec = INSERTER_BY_ENTITY_NAME[e.name];
    if (!insSpec) continue;
    const reach = inserterReachTiles(e.tx, e.ty, e.direction, insSpec.reach);
    const pickupEnts = tileOccupancy.get(`${reach.pickupX},${reach.pickupY}`) ?? [];
    const dropEnts = tileOccupancy.get(`${reach.dropX},${reach.dropY}`) ?? [];

    const hasValidTarget = (list: EntityInstance[]) =>
      list.some(
        (t) =>
          isMachineName(t.name) ||
          isBeltLikeName(t.name) ||
          t.name === 'steel-chest' ||
          t.name === 'straight-rail',
      );

    if (!hasValidTarget(pickupEnts) || !hasValidTarget(dropEnts)) {
      addV(
        'INSERTER_VALID',
        'error',
        `Inserter ${e.name} at (${e.tx},${e.ty}) has invalid pickup (${reach.pickupX},${reach.pickupY}) or drop (${reach.dropX},${reach.dropY}).`,
        e.tx,
        e.ty,
        [e.id],
      );
    }
  }

  // 4. Accidental side-loading check
  // Any surface belt or underground output pointing into a tile occupied by a DIFFERENT net
  // (excluding explicit intentionalSideLoad dual-lane T-merge points) is an error!
  for (const e of entities) {
    if (!isBeltLikeName(e.name) || isSplitterName(e.name)) continue;
    if (isUndergroundName(e.name) && e.type === 'input') continue;

    const { dx, dy } = dirDelta(e.direction);
    const nx = e.tx + dx;
    const ny = e.ty + dy;
    const targets = tileOccupancy.get(`${nx},${ny}`) ?? [];
    if (targets.length === 0) continue;

    const target = targets[0];
    if (!isBeltLikeName(target.name)) continue;

    // Splitters accept parallel feeds on their back; side-loading into the side of a splitter is invalid
    if (isSplitterName(target.name)) {
      if (e.direction !== target.direction) {
        addV(
          'NO_SIDE_LOAD_CONTAMINATION',
          'error',
          `Belt at (${e.tx},${e.ty}) enters side of splitter at (${nx},${ny}).`,
          nx,
          ny,
          [e.id, target.id],
        );
      }
      continue;
    }

    // Same macro / same net flow checks
    if (target.intentionalSideLoad && e.macroId && e.macroId === target.macroId) {
      continue;
    }

    // Determine whether e and target belong to different nets or macros
    const sameNet =
      (e.netId && target.netId && e.netId === target.netId) ||
      (e.macroId && target.macroId && e.macroId === target.macroId) ||
      // Router connecting into/out of a macro pin on the same item
      (e.netId && target.macroId && !target.intentionalSideLoad && e.item && target.item === e.item) ||
      (e.macroId && target.netId && target.item && (!e.item || e.item === target.item));

    if (!sameNet) {
      addV(
        'NO_SIDE_LOAD_CONTAMINATION',
        'error',
        `Potential belt contamination: (${e.tx},${e.ty}) feeds into (${nx},${ny}) belonging to a different net/macro.`,
        nx,
        ny,
        [e.id, target.id],
      );
    }
  }

  // 4b. Fluid mixing & non-adjacent distinct pipes check (NO_FLUID_MIXING, NO_ADJACENT_PIPES)
  const allowedMacroPipeContacts = new Set<string>();
  if (floorplan) {
    for (const pm of floorplan.macros) {
      for (const mp of pm.macro.pins) {
        if (!mp.isFluid) continue;
        const ix = pm.x + mp.x;
        const iy = pm.y + mp.y;
        const px = pm.x + mp.portX;
        const py = pm.y + mp.portY;
        allowedMacroPipeContacts.add(`${ix},${iy}|${px},${py}`);
        allowedMacroPipeContacts.add(`${px},${py}|${ix},${iy}`);
      }
    }
  }

  const pipeEntities = entities.filter((e) => isPipeName(e.name));
  if (pipeEntities.length > 0) {
    const pipeByTile = new Map<string, EntityInstance>();
    for (const p of pipeEntities) {
      pipeByTile.set(`${p.tx},${p.ty}`, p);
    }
    const pipeHasPort = (ent: EntityInstance, dx: number, dy: number): boolean => {
      if (!isPipeUndergroundName(ent.name)) return true;
      const d = dirDelta(ent.direction);
      return d.dx === dx && d.dy === dy;
    };
    for (const a of pipeEntities) {
      for (const [dx, dy] of [
        [1, 0],
        [0, 1],
      ] as const) {
        const b = pipeByTile.get(`${a.tx + dx},${a.ty + dy}`);
        if (!b) continue;
        if (!pipeHasPort(a, dx, dy) || !pipeHasPort(b, -dx, -dy)) continue;

        if (a.item && b.item && a.item !== b.item) {
          addV(
            'NO_FLUID_MIXING',
            'error',
            `Fluid mixing between "${a.item}" at (${a.tx},${a.ty}) and "${b.item}" at (${b.tx},${b.ty}).`,
            a.tx,
            a.ty,
            [a.id, b.id],
          );
          continue;
        }

        if (a.netId && b.netId && a.netId !== b.netId) {
          addV(
            'NO_ADJACENT_PIPES',
            'error',
            `Adjacent pipes from distinct nets ("${a.netId}" and "${b.netId}") at (${a.tx},${a.ty}) and (${b.tx},${b.ty}).`,
            a.tx,
            a.ty,
            [a.id, b.id],
          );
          continue;
        }

        if (a.macroId && b.macroId && a.macroId !== b.macroId) {
          addV(
            'NO_ADJACENT_PIPES',
            'error',
            `Adjacent pipes from distinct macros ("${a.macroId}" and "${b.macroId}") at (${a.tx},${a.ty}) and (${b.tx},${b.ty}).`,
            a.tx,
            a.ty,
            [a.id, b.id],
          );
          continue;
        }

        if (floorplan && ((a.netId && b.macroId) || (b.netId && a.macroId))) {
          if (!allowedMacroPipeContacts.has(`${a.tx},${a.ty}|${b.tx},${b.ty}`)) {
            addV(
              'NO_ADJACENT_PIPES',
              'error',
              `Routed pipe touches macro pipe away from fluid pin at (${a.tx},${a.ty}) and (${b.tx},${b.ty}).`,
              a.tx,
              a.ty,
              [a.id, b.id],
            );
          }
        }
      }

      // Check 2x2 surface pipe cluster on the same routed net
      if (!isPipeUndergroundName(a.name) && a.netId) {
        const b = pipeByTile.get(`${a.tx + 1},${a.ty}`);
        const c = pipeByTile.get(`${a.tx},${a.ty + 1}`);
        const d = pipeByTile.get(`${a.tx + 1},${a.ty + 1}`);
        if (
          b &&
          c &&
          d &&
          !isPipeUndergroundName(b.name) &&
          !isPipeUndergroundName(c.name) &&
          !isPipeUndergroundName(d.name) &&
          b.netId === a.netId &&
          c.netId === a.netId &&
          d.netId === a.netId
        ) {
          addV(
            'NO_ADJACENT_PIPES',
            'error',
            `Self-adjacent 2x2 pipe cluster on net "${a.netId}" at (${a.tx},${a.ty}).`,
            a.tx,
            a.ty,
            [a.id, b.id, c.id, d.id],
          );
        }
      }
    }
  }

  // 5. Power coverage & connectivity check (spatial-hashed O(E + P))
  const poles = entities
    .map((e) => ({ entity: e, spec: POLE_BY_ENTITY_NAME[e.name] }))
    .filter((p) => p.spec !== undefined);

  const POLE_CELL = 18;
  const poleBuckets = new Map<string, number[]>();
  const poleCenters = poles.map((p, idx) => {
    const cx = p.entity.tx + p.spec!.size / 2;
    const cy = p.entity.ty + p.spec!.size / 2;
    const kx = Math.floor(cx / POLE_CELL);
    const ky = Math.floor(cy / POLE_CELL);
    const key = `${kx},${ky}`;
    let b = poleBuckets.get(key);
    if (!b) {
      b = [];
      poleBuckets.set(key, b);
    }
    b.push(idx);
    return { cx, cy, kx, ky };
  });

  const poweredEntities = entities.filter((e) => requiresPower(e.name));
  for (const pe of poweredEntities) {
    const minKx = Math.floor((pe.tx - 10) / POLE_CELL);
    const maxKx = Math.floor((pe.tx + pe.w + 10) / POLE_CELL);
    const minKy = Math.floor((pe.ty - 10) / POLE_CELL);
    const maxKy = Math.floor((pe.ty + pe.h + 10) / POLE_CELL);
    let isSupplied = false;
    for (let ky = minKy; ky <= maxKy && !isSupplied; ky++) {
      for (let kx = minKx; kx <= maxKx && !isSupplied; kx++) {
        const list = poleBuckets.get(`${kx},${ky}`);
        if (!list) continue;
        for (const pIdx of list) {
          const p = poles[pIdx];
          if (doesPoleSupplyEntity(p.entity.tx, p.entity.ty, p.spec!, pe.tx, pe.ty, pe.w, pe.h)) {
            isSupplied = true;
            break;
          }
        }
      }
    }
    if (!isSupplied) {
      addV(
        'POWER_COVERAGE',
        'error',
        `Entity ${pe.name} at (${pe.tx},${pe.ty}) is unpowered.`,
        pe.tx,
        pe.ty,
        [pe.id],
      );
    }
  }

  if (poles.length > 1) {
    const visited = new Uint8Array(poles.length);
    const q = [0];
    visited[0] = 1;
    let head = 0;
    let count = 0;
    while (head < q.length) {
      const u = q[head++];
      count++;
      const pu = poles[u];
      const uc = poleCenters[u];
      for (let ky = uc.ky - 1; ky <= uc.ky + 1; ky++) {
        for (let kx = uc.kx - 1; kx <= uc.kx + 1; kx++) {
          const list = poleBuckets.get(`${kx},${ky}`);
          if (!list) continue;
          for (const v of list) {
            if (visited[v]) continue;
            const pv = poles[v];
            const vc = poleCenters[v];
            const reach = Math.min(pu.spec!.wireReach, pv.spec!.wireReach);
            const dx = uc.cx - vc.cx;
            const dy = uc.cy - vc.cy;
            if (dx * dx + dy * dy <= reach * reach + 1e-6) {
              visited[v] = 1;
              q.push(v);
            }
          }
        }
      }
    }
    if (count < poles.length) {
      const disconnected = poles.find((_, idx) => !visited[idx])!;
      addV(
        'POWER_CONNECTIVITY',
        'error',
        `Power grid is split into multiple islands (${count}/${poles.length} poles connected).`,
        disconnected.entity.tx,
        disconnected.entity.ty,
        [disconnected.entity.id],
      );
    }
  }

  const errorCount = violations.filter((v) => v.severity === 'error').length;
  const warningCount = violations.filter((v) => v.severity === 'warning').length;

  return {
    passed: errorCount === 0,
    errorCount,
    warningCount,
    violations,
  };
}
