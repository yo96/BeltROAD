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

function findConnectedComponents(poles: PoleNode[]): number[][] {
  const n = poles.length;
  const visited = new Uint8Array(n);
  const comps: number[][] = [];

  for (let i = 0; i < n; i++) {
    if (visited[i]) continue;
    const comp: number[] = [];
    const q = [i];
    visited[i] = 1;
    while (q.length > 0) {
      const u = q.shift()!;
      comp.push(u);
      for (let v = 0; v < n; v++) {
        if (!visited[v] && canConnectPoles(poles[u], poles[v])) {
          visited[v] = 1;
          q.push(v);
        }
      }
    }
    comps.push(comp);
  }
  return comps;
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

  const powered = entities.filter((e) => requiresPower(e.name));
  const covered = new Uint8Array(powered.length);
  for (let i = 0; i < powered.length; i++) {
    const pe = powered[i];
    if (
      poles.some((p) =>
        doesPoleSupplyEntity(p.tx, p.ty, p.spec, pe.tx, pe.ty, pe.w, pe.h),
      )
    ) {
      covered[i] = 1;
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
        for (let j = 0; j < powered.length; j++) {
          if (covered[j]) continue;
          const o = powered[j];
          if (doesPoleSupplyEntity(px, py, defaultPole, o.tx, o.ty, o.w, o.h)) {
            score++;
          }
        }

        const cx = px + defaultPole.size / 2;
        const cy = py + defaultPole.size / 2;
        let nearDist = Infinity;
        for (const p of poles) {
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
      poles.push(node);
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
      for (let j = 0; j < powered.length; j++) {
        if (!covered[j]) {
          const o = powered[j];
          if (doesPoleSupplyEntity(bestX, bestY, defaultPole, o.tx, o.ty, o.w, o.h)) {
            covered[j] = 1;
          }
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
