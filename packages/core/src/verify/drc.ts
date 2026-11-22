import {
  DrcReport,
  DrcViolation,
  EntityInstance,
  RouteResult,
} from '../types.js';
import {
  BELT_SPECS,
  INSERTER_BY_ENTITY_NAME,
  POLE_BY_ENTITY_NAME,
  beltTierFromEntityName,
  doesPoleSupplyEntity,
  isBeltLikeName,
  isMachineName,
  isSplitterName,
  isUndergroundName,
  requiresPower,
} from '../data/entities.js';
import { dirDelta, inserterReachTiles } from '../geometry.js';

export function runDrc(
  entities: EntityInstance[],
  width: number,
  height: number,
  routeResult?: RouteResult,
  allowOutOfBoundsMarkers = true,
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

  // 3. Inserter validation (valid pickup & drop targets)
  for (const e of entities) {
    const insSpec = INSERTER_BY_ENTITY_NAME[e.name];
    if (!insSpec) continue;
    const reach = inserterReachTiles(e.tx, e.ty, e.direction, insSpec.reach);
    const pickupEnts = tileOccupancy.get(`${reach.pickupX},${reach.pickupY}`) ?? [];
    const dropEnts = tileOccupancy.get(`${reach.dropX},${reach.dropY}`) ?? [];

    const hasValidTarget = (list: EntityInstance[]) =>
      list.some((t) => isMachineName(t.name) || isBeltLikeName(t.name));

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
