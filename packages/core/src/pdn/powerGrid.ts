import {
  EntityInstance,
  PdkConfig,
  PdnResult,
} from '../types.js';
import {
  POLE_BY_ENTITY_NAME,
  POLE_SPECS,
  PoleSpec,
  doesPoleSupplyEntity,
  requiresPower,
} from '../data/entities.js';

interface PoleNode {
  id: string;
  tx: number;
  ty: number;
  spec: PoleSpec;
  cx: number;
  cy: number;
}

function canConnectPoles(a: PoleNode, b: PoleNode): boolean {
  const reach = Math.min(a.spec.wireReach, b.spec.wireReach);
  const dx = a.cx - b.cx;
  const dy = a.cy - b.cy;
  return dx * dx + dy * dy <= reach * reach + 1e-6;
}

const PDN_POLE_CELL = 18;
const PDN_ENT_CELL = 16;

function buildSpatialIndex(
  items: ReadonlyArray<{ cx: number; cy: number }>,
  cellSize: number,
): Map<string, number[]> {
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < items.length; i++) {
    const kx = Math.floor(items[i].cx / cellSize);
    const ky = Math.floor(items[i].cy / cellSize);
    const key = `${kx},${ky}`;
    let b = buckets.get(key);
    if (!b) {
      b = [];
      buckets.set(key, b);
    }
    b.push(i);
  }
  return buckets;
}

function findConnectedComponents(poles: PoleNode[]): number[][] {
  const n = poles.length;
  const visited = new Uint8Array(n);
  const comps: number[][] = [];
  if (n === 0) return comps;

  const grid = buildSpatialIndex(poles, PDN_POLE_CELL);

  for (let i = 0; i < n; i++) {
    if (visited[i]) continue;
    const comp: number[] = [];
    const q = [i];
    visited[i] = 1;
    let head = 0;
    while (head < q.length) {
      const u = q[head++];
      comp.push(u);
      const pu = poles[u];
      const ux = Math.floor(pu.cx / PDN_POLE_CELL);
      const uy = Math.floor(pu.cy / PDN_POLE_CELL);
      for (let ky = uy - 1; ky <= uy + 1; ky++) {
        for (let kx = ux - 1; kx <= ux + 1; kx++) {
          const list = grid.get(`${kx},${ky}`);
          if (!list) continue;
          for (const v of list) {
            if (!visited[v] && canConnectPoles(pu, poles[v])) {
              visited[v] = 1;
              q.push(v);
            }
          }
        }
      }
    }
    comps.push(comp);
  }
  return comps;
}

function findNearestPairFast(
  poles: PoleNode[],
  comps: number[][],
): { bestA: number; bestB: number; bestDist2: number } {
  if (poles.length <= 160) {
    const mainSet = new Set(comps[0]);
    let bestA = -1;
    let bestB = -1;
    let bestDist2 = Infinity;
    for (const aIdx of comps[0]) {
      const pa = poles[aIdx];
      for (let bIdx = 0; bIdx < poles.length; bIdx++) {
        if (mainSet.has(bIdx)) continue;
        const pb = poles[bIdx];
        const dx = pa.cx - pb.cx;
        const dy = pa.cy - pb.cy;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestDist2) {
          bestDist2 = d2;
          bestA = aIdx;
          bestB = bIdx;
        }
      }
    }
    return { bestA, bestB, bestDist2 };
  }

  const cell = PDN_POLE_CELL;
  const mainGrid = new Map<string, number[]>();
  const inMain = new Uint8Array(poles.length);
  for (const aIdx of comps[0]) {
    inMain[aIdx] = 1;
    const p = poles[aIdx];
    const key = `${Math.floor(p.cx / cell)},${Math.floor(p.cy / cell)}`;
    let b = mainGrid.get(key);
    if (!b) {
      b = [];
      mainGrid.set(key, b);
    }
    b.push(aIdx);
  }

  let bestA = -1;
  let bestB = -1;
  let bestDist2 = Infinity;

  for (let cIdx = 1; cIdx < comps.length; cIdx++) {
    for (const bIdx of comps[cIdx]) {
      const pb = poles[bIdx];
      const bx = Math.floor(pb.cx / cell);
      const by = Math.floor(pb.cy / cell);

      // Probe expanding square cell rings around (bx, by)
      for (let ring = 0; ring <= 12; ring++) {
        const minPossible = ring <= 1 ? 0 : (ring - 1) * cell;
        if (minPossible * minPossible >= bestDist2) break;

        for (let ky = by - ring; ky <= by + ring; ky++) {
          for (let kx = bx - ring; kx <= bx + ring; kx++) {
            if (Math.abs(kx - bx) !== ring && Math.abs(ky - by) !== ring) continue;
            const list = mainGrid.get(`${kx},${ky}`);
            if (!list) continue;
            for (const aIdx of list) {
              const pa = poles[aIdx];
              const dx = pa.cx - pb.cx;
              const dy = pa.cy - pb.cy;
              const d2 = dx * dx + dy * dy;
              if (d2 < bestDist2) {
                bestDist2 = d2;
                bestA = aIdx;
                bestB = bIdx;
              }
            }
          }
        }
        if (bestA >= 0 && (ring + 1) * cell >= Math.sqrt(bestDist2)) {
          // Next ring's minimum distance could still be slightly closer, let loop condition handle it cleanly
        }
      }
    }
  }

  if (bestA < 0) {
    // Fallback if separated by > 12*18 = 216 tiles
    for (const aIdx of comps[0]) {
      const pa = poles[aIdx];
      for (let bIdx = 0; bIdx < poles.length; bIdx++) {
        if (inMain[bIdx]) continue;
        const pb = poles[bIdx];
        const dx = pa.cx - pb.cx;
        const dy = pa.cy - pb.cy;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestDist2) {
          bestDist2 = d2;
          bestA = aIdx;
          bestB = bIdx;
        }
      }
    }
  }

  return { bestA, bestB, bestDist2 };
}

function isBoxFree(
  occ: Uint8Array,
  W: number,
  H: number,
  tx: number,
  ty: number,
  size: number,
): boolean {
  if (tx < 0 || ty < 0 || tx + size > W || ty + size > H) return false;
  for (let dx = 0; dx < size; dx++) {
    for (let dy = 0; dy < size; dy++) {
      if (occ[(ty + dy) * W + (tx + dx)] !== 0) return false;
    }
  }
  return true;
}

function markBoxOcc(
  occ: Uint8Array,
  W: number,
  tx: number,
  ty: number,
  size: number,
): void {
  for (let dx = 0; dx < size; dx++) {
    for (let dy = 0; dy < size; dy++) {
      occ[(ty + dy) * W + (tx + dx)] = 1;
    }
  }
}

export function buildPowerGrid(
  entities: EntityInstance[],
  width: number,
  height: number,
  pdk: PdkConfig,
): PdnResult {
  const W = width;
  const H = height;
  const occ = new Uint8Array(W * H);

  for (const e of entities) {
    for (let dx = 0; dx < e.w; dx++) {
      for (let dy = 0; dy < e.h; dy++) {
        const x = e.tx + dx;
        const y = e.ty + dy;
        if (x >= 0 && x < W && y >= 0 && y < H) {
          occ[y * W + x] = 1;
        }
      }
    }
  }

  const poles: PoleNode[] = [];
  for (const e of entities) {
    const ps = POLE_BY_ENTITY_NAME[e.name];
    if (ps) {
      poles.push({
        id: e.id,
        tx: e.tx,
        ty: e.ty,
        spec: ps,
        cx: e.tx + ps.size / 2,
        cy: e.ty + ps.size / 2,
      });
    }
  }

  const poleSpatial = buildSpatialIndex(poles, PDN_POLE_CELL);
  const powered = entities.filter((e) => requiresPower(e.name));
  const poweredCenters = powered.map((pe) => ({
    cx: pe.tx + pe.w / 2,
    cy: pe.ty + pe.h / 2,
  }));
  const poweredSpatial = buildSpatialIndex(poweredCenters, PDN_ENT_CELL);
  const covered = new Uint8Array(powered.length);
  for (let i = 0; i < powered.length; i++) {
    const pe = powered[i];
    const minKx = Math.floor((pe.tx - 10) / PDN_POLE_CELL);
    const maxKx = Math.floor((pe.tx + pe.w + 10) / PDN_POLE_CELL);
    const minKy = Math.floor((pe.ty - 10) / PDN_POLE_CELL);
    const maxKy = Math.floor((pe.ty + pe.h + 10) / PDN_POLE_CELL);
    for (let ky = minKy; ky <= maxKy && !covered[i]; ky++) {
      for (let kx = minKx; kx <= maxKx && !covered[i]; kx++) {
        const list = poleSpatial.get(`${kx},${ky}`);
        if (!list) continue;
        for (const pIdx of list) {
          const p = poles[pIdx];
          if (doesPoleSupplyEntity(p.tx, p.ty, p.spec, pe.tx, pe.ty, pe.w, pe.h)) {
            covered[i] = 1;
            break;
          }
        }
      }
    }
  }

  const defaultPole = POLE_SPECS[pdk.defaultPoleTier];
  const addedEntities: EntityInstance[] = [];
  let pid = 0;

  // 1. Cover any remaining uncovered powered entities
  for (let i = 0; i < powered.length; i++) {
    if (covered[i]) continue;
    const target = powered[i];
    const r = Math.ceil(defaultPole.supplyRadius + Math.max(target.w, target.h));

    let bestScore = -1;
    let bestX = -1;
    let bestY = -1;
    let bestDistToPole = Infinity;

    const minX = Math.max(0, target.tx - r);
    const maxX = Math.min(W - defaultPole.size, target.tx + target.w + r);
    const minY = Math.max(0, target.ty - r);
    const maxY = Math.min(H - defaultPole.size, target.ty + target.h + r);

    const candEntIds: number[] = [];
    const eMinKx = Math.floor((minX - 12) / PDN_ENT_CELL);
    const eMaxKx = Math.floor((maxX + 12) / PDN_ENT_CELL);
    const eMinKy = Math.floor((minY - 12) / PDN_ENT_CELL);
    const eMaxKy = Math.floor((maxY + 12) / PDN_ENT_CELL);
    for (let ky = eMinKy; ky <= eMaxKy; ky++) {
      for (let kx = eMinKx; kx <= eMaxKx; kx++) {
        const list = poweredSpatial.get(`${kx},${ky}`);
        if (!list) continue;
        for (const j of list) {
          if (!covered[j]) candEntIds.push(j);
        }
      }
    }

    const nearbyPoles: PoleNode[] = [];
    const pKx = Math.floor((target.tx + target.w / 2) / PDN_POLE_CELL);
    const pKy = Math.floor((target.ty + target.h / 2) / PDN_POLE_CELL);
    for (let ky = pKy - 1; ky <= pKy + 1; ky++) {
      for (let kx = pKx - 1; kx <= pKx + 1; kx++) {
        const list = poleSpatial.get(`${kx},${ky}`);
        if (!list) continue;
        for (const pIdx of list) nearbyPoles.push(poles[pIdx]);
      }
    }

    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        if (!isBoxFree(occ, W, H, px, py, defaultPole.size)) continue;
        if (
          !doesPoleSupplyEntity(
            px,
            py,
            defaultPole,
            target.tx,
            target.ty,
            target.w,
            target.h,
          )
        ) {
          continue;
        }

        let score = 0;
        for (const j of candEntIds) {
          const o = powered[j];
          if (doesPoleSupplyEntity(px, py, defaultPole, o.tx, o.ty, o.w, o.h)) {
            score++;
          }
        }

        const cx = px + defaultPole.size / 2;
        const cy = py + defaultPole.size / 2;
        let nearDist = Infinity;
        for (const p of nearbyPoles) {
          const d = Math.hypot(cx - p.cx, cy - p.cy);
          if (d < nearDist) nearDist = d;
        }

        if (
          score > bestScore ||
          (score === bestScore && nearDist < bestDistToPole)
        ) {
          bestScore = score;
          bestX = px;
          bestY = py;
          bestDistToPole = nearDist;
        }
      }
    }

    if (bestX >= 0) {
      const id = `pdn:cov:${pid++}`;
      const node: PoleNode = {
        id,
        tx: bestX,
        ty: bestY,
        spec: defaultPole,
        cx: bestX + defaultPole.size / 2,
        cy: bestY + defaultPole.size / 2,
      };
      const newPoleIdx = poles.length;
      poles.push(node);
      const nk = `${Math.floor(node.cx / PDN_POLE_CELL)},${Math.floor(node.cy / PDN_POLE_CELL)}`;
      let nb = poleSpatial.get(nk);
      if (!nb) {
        nb = [];
        poleSpatial.set(nk, nb);
      }
      nb.push(newPoleIdx);

      markBoxOcc(occ, W, bestX, bestY, defaultPole.size);
      addedEntities.push({
        id,
        name: defaultPole.name,
        tx: bestX,
        ty: bestY,
        w: defaultPole.size,
        h: defaultPole.size,
        direction: 0,
        role: 'pole-pdn',
      });
      for (const j of candEntIds) {
        const o = powered[j];
        if (doesPoleSupplyEntity(bestX, bestY, defaultPole, o.tx, o.ty, o.w, o.h)) {
          covered[j] = 1;
        }
      }
    }
  }

  const compsInitial = findConnectedComponents(poles);
  const componentsBefore = compsInitial.length;

  // 2. Bridge disconnected pole islands into a single electrical network
  let comps = compsInitial;
  let guard = 0;
  while (comps.length > 1 && guard < 200) {
    guard++;
    const { bestA, bestB } = findNearestPairFast(poles, comps);

    if (bestA < 0 || bestB < 0) break;

    let cur = poles[bestA];
    const dest = poles[bestB];
    let stepGuard = 0;
    let bridged = false;

    while (!canConnectPoles(cur, dest) && stepGuard < 60) {
      stepGuard++;
      const reach = Math.min(cur.spec.wireReach, defaultPole.wireReach);
      const dx = dest.cx - cur.cx;
      const dy = dest.cy - cur.cy;
      const dist = Math.hypot(dx, dy);
      if (dist <= reach) break;

      // Target a point along the straight line near 85% of wire reach
      const idealStep = Math.min(reach * 0.85, dist - 1);
      const targetCx = cur.cx + (dx / dist) * idealStep;
      const targetCy = cur.cy + (dy / dist) * idealStep;

      // Search candidate free tiles within wireReach of cur, minimizing dist to dest
      let candX = -1;
      let candY = -1;
      let candScore = Infinity;

      const rSearch = Math.ceil(reach);
      const minX = Math.max(0, Math.floor(cur.cx - rSearch));
      const maxX = Math.min(W - defaultPole.size, Math.ceil(cur.cx + rSearch));
      const minY = Math.max(0, Math.floor(cur.cy - rSearch));
      const maxY = Math.min(H - defaultPole.size, Math.ceil(cur.cy + rSearch));

      for (let py = minY; py <= maxY; py++) {
        for (let px = minX; px <= maxX; px++) {
          if (!isBoxFree(occ, W, H, px, py, defaultPole.size)) continue;
          const cx = px + defaultPole.size / 2;
          const cy = py + defaultPole.size / 2;
          const dFromCur = Math.hypot(cx - cur.cx, cy - cur.cy);
          if (dFromCur > reach - 0.1 || dFromCur < 1.0) continue;

          const dToDest = Math.hypot(cx - dest.cx, cy - dest.cy);
          const dToIdeal = Math.hypot(cx - targetCx, cy - targetCy);
          const score = dToDest + dToIdeal * 0.15;
          if (score < candScore) {
            candScore = score;
            candX = px;
            candY = py;
          }
        }
      }

      if (candX < 0) break;

      const id = `pdn:br:${pid++}`;
      const newNode: PoleNode = {
        id,
        tx: candX,
        ty: candY,
        spec: defaultPole,
        cx: candX + defaultPole.size / 2,
        cy: candY + defaultPole.size / 2,
      };
      poles.push(newNode);
      markBoxOcc(occ, W, candX, candY, defaultPole.size);
      addedEntities.push({
        id,
        name: defaultPole.name,
        tx: candX,
        ty: candY,
        w: defaultPole.size,
        h: defaultPole.size,
        direction: 0,
        role: 'pole-pdn',
      });
      cur = newNode;
      bridged = true;
    }

    if (!bridged && !canConnectPoles(cur, dest)) break;
    comps = findConnectedComponents(poles);
  }

  return {
    entities: addedEntities,
    addedPoles: addedEntities.length,
    totalPoles: poles.length,
    componentsBefore,
    componentsAfter: comps.length,
  };
}
