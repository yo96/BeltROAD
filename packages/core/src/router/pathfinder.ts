import {
  BeltTier,
  Dir,
  EntityInstance,
  FloorplanResult,
  PerimeterPin,
  RoutedNetSegment,
  RouteResult,
  SynthesisResult,
} from '../types.js';
import {
  BELT_SPECS,
  PIPE_SPEC,
  isBeltLikeName,
  isPipeUndergroundName,
  isSplitterName,
  isUndergroundName,
} from '../data/entities.js';
import { dirDelta, oppositeDir } from '../geometry.js';
import {
  DX4,
  DY4,
  RouterBuffers,
  createRouterBuffers,
  dirToIdx4,
  heapPop,
  heapPush,
  idx4ToDir,
} from './gridBuffers.js';

export interface RouteNetSpec {
  netIdx: number;
  netId: string;
  item: string;
  beltTier: BeltTier;
  isFluid: boolean;
  fluidId: number;
  maxUgDist: number;
  sx: number;
  sy: number;
  srcDirIdx: number;
  tx: number;
  ty: number;
  dstDirIdx: number;
  /** Exact macro/perimeter tile fed out of (sx, sy) */
  sourcePipeTile: number;
  /** Exact macro/perimeter tile fed into from (tx, ty) */
  allowedTargetTile: number;
  /** Fixed perimeter stub (if source/sink is a perimeter pin) */
  fixedStartPin?: PerimeterPin;
  fixedEndPin?: PerimeterPin;
}

interface PlacedTileStep {
  tileIdx: number;
  dirIdx: number;
  kind: 1 | 2 | 3; // 1=belt, 2=ug-in, 3=ug-out
  jumpDist: number; // for ug-in: k (>=2)
}

export interface RouteProgressCallback {
  (info: { iteration: number; maxIterations: number; conflicts: number; elapsedMs: number }): void;
}

function buildRouteSpecs(
  synth: SynthesisResult,
  floorplan: FloorplanResult,
  fluidIdByItem: Map<string, number>,
): RouteNetSpec[] {
  const macroById = new Map(floorplan.macros.map((m) => [m.id, m]));
  const pinById = new Map(floorplan.pins.map((p) => [p.id, p]));

  const getFluidId = (item: string): number => {
    let fid = fluidIdByItem.get(item);
    if (!fid) {
      fid = fluidIdByItem.size + 1;
      fluidIdByItem.set(item, fid);
    }
    return fid;
  };

  const specs: RouteNetSpec[] = [];
  synth.nets.forEach((net, idx) => {
    let sx = 0;
    let sy = 0;
    let srcDir = Dir.EAST;
    let sourcePipeTile = -1;
    let fixedStartPin: PerimeterPin | undefined;

    if (net.source.nodeId.startsWith('in:')) {
      const p = pinById.get(net.source.nodeId);
      if (!p) return;
      const d = dirDelta(p.dir);
      sx = p.x + d.dx;
      sy = p.y + d.dy;
      srcDir = p.dir;
      fixedStartPin = p;
      sourcePipeTile = p.y * floorplan.width + p.x;
    } else {
      const pm = macroById.get(net.source.nodeId);
      const mp = pm?.macro.pins.find((p) => p.id === net.source.pinId);
      if (!pm || !mp) return;
      sx = pm.x + mp.portX;
      sy = pm.y + mp.portY;
      srcDir = mp.direction;
      sourcePipeTile = (pm.y + mp.y) * floorplan.width + (pm.x + mp.x);
    }

    let tx = 0;
    let ty = 0;
    let dstDir = Dir.EAST;
    let allowedTargetTile = -1;
    let fixedEndPin: PerimeterPin | undefined;

    if (net.sink.nodeId.startsWith('out:')) {
      const p = pinById.get(net.sink.nodeId);
      if (!p) return;
      const d = dirDelta(p.dir);
      tx = p.x - d.dx;
      ty = p.y - d.dy;
      dstDir = p.dir;
      fixedEndPin = p;
      allowedTargetTile = p.y * floorplan.width + p.x;
    } else {
      const pm = macroById.get(net.sink.nodeId);
      const mp = pm?.macro.pins.find((p) => p.id === net.sink.pinId);
      if (!pm || !mp) return;
      tx = pm.x + mp.portX;
      ty = pm.y + mp.portY;
      dstDir = mp.direction;
      allowedTargetTile = (pm.y + mp.y) * floorplan.width + (pm.x + mp.x);
    }

    const isFluid = Boolean(net.isFluid);
    const fluidId = isFluid ? getFluidId(net.item) : 0;

    specs.push({
      netIdx: idx,
      netId: net.id,
      item: net.item,
      beltTier: net.beltTier,
      isFluid,
      fluidId,
      maxUgDist: isFluid ? PIPE_SPEC.maxUgDistance : BELT_SPECS[net.beltTier].maxUgDistance,
      sx,
      sy,
      srcDirIdx: dirToIdx4(srcDir),
      tx,
      ty,
      dstDirIdx: dirToIdx4(dstDir),
      sourcePipeTile,
      allowedTargetTile,
      fixedStartPin,
      fixedEndPin,
    });
  });

  return specs;
}

function initStaticGrid(
  buf: RouterBuffers,
  floorplan: FloorplanResult,
  specs: RouteNetSpec[],
  fluidIdByItem: Map<string, number>,
): void {
  const W = buf.width;
  const H = buf.height;

  const getOrAssignFluidId = (item: string): number => {
    let fid = fluidIdByItem.get(item);
    if (!fid) {
      fid = fluidIdByItem.size + 1;
      fluidIdByItem.set(item, fid);
    }
    return fid;
  };

  // Block all macro entities & register macro internal underground spans
  const macroUgs: Array<{
    tx: number;
    ty: number;
    dir: Dir;
    type: 'input' | 'output';
  }> = [];
  const macroPipeUgs: Array<{
    tx: number;
    ty: number;
    dir: Dir;
  }> = [];

  const outputPortTiles = new Set<number>();
  const macroEntityTiles = new Set<number>();

  for (const pm of floorplan.macros) {
    for (const pin of pm.macro.pins) {
      if (pin.kind === 'output') {
        const px = pm.x + pin.portX;
        const py = pm.y + pin.portY;
        if (px >= 0 && px < W && py >= 0 && py < H) {
          outputPortTiles.add(py * W + px);
        }
      }
    }
    for (const ent of pm.macro.entities) {
      const gx = pm.x + ent.tx;
      const gy = pm.y + ent.ty;
      for (let dx = 0; dx < ent.w; dx++) {
        for (let dy = 0; dy < ent.h; dy++) {
          const x = gx + dx;
          const y = gy + dy;
          if (x >= 0 && x < W && y >= 0 && y < H) {
            const idx = y * W + x;
            buf.staticBlock[idx] = 1;
            buf.macroObstacle[idx] = 1;
            macroEntityTiles.add(idx);
            if (ent.name === 'pipe' && ent.item) {
              buf.staticFluidId[idx] = getOrAssignFluidId(ent.item);
            } else if (isPipeUndergroundName(ent.name) && ent.item) {
              buf.staticPipeUgFluid[idx] = getOrAssignFluidId(ent.item);
              buf.staticPipeUgDir[idx] = dirToIdx4(ent.direction);
            }
          }
        }
      }
      if (isUndergroundName(ent.name) && ent.type) {
        macroUgs.push({
          tx: gx,
          ty: gy,
          dir: ent.direction,
          type: ent.type,
        });
      } else if (isPipeUndergroundName(ent.name) && ent.item) {
        macroPipeUgs.push({
          tx: gx,
          ty: gy,
          dir: ent.direction,
        });
      }
    }
  }

  // Block 1-tile discharge clearance in front of macro non-output belt tails & splitters
  // so no routed belt can ever sit where a macro belt dead-end would dump onto it.
  for (const pm of floorplan.macros) {
    for (const ent of pm.macro.entities) {
      if (!isBeltLikeName(ent.name)) continue;
      if (isUndergroundName(ent.name) && ent.type === 'input') continue;
      const { dx, dy } = dirDelta(ent.direction);
      for (let ox = 0; ox < ent.w; ox++) {
        for (let oy = 0; oy < ent.h; oy++) {
          const fx = pm.x + ent.tx + ox + dx;
          const fy = pm.y + ent.ty + oy + dy;
          if (fx < 0 || fx >= W || fy < 0 || fy >= H) continue;
          const fIdx = fy * W + fx;
          if (!macroEntityTiles.has(fIdx) && !outputPortTiles.has(fIdx)) {
            buf.staticBlock[fIdx] = 1;
          }
        }
      }
      void isSplitterName;
    }
  }

  // Mark macro internal underground spans so router never weaves with them
  for (const u of macroUgs) {
    if (u.type !== 'input') continue;
    const dIdx = dirToIdx4(u.dir);
    const dx = DX4[dIdx];
    const dy = DY4[dIdx];
    const isHoriz = dx !== 0;
    for (let step = 1; step <= 10; step++) {
      const px = u.tx + dx * step;
      const py = u.ty + dy * step;
      if (px < 0 || px >= W || py < 0 || py >= H) break;
      const partner = macroUgs.find(
        (o) => o.tx === px && o.ty === py && o.dir === u.dir && o.type === 'output',
      );
      if (partner) {
        for (let k = 0; k <= step; k++) {
          const tidx = (u.ty + dy * k) * W + (u.tx + dx * k);
          if (isHoriz) buf.ugHorizOcc[tidx]++;
          else buf.ugVertOcc[tidx]++;
        }
        break;
      }
    }
  }

  // Mark macro internal underground pipe spans so router never weaves with them
  const macroPipeUgMap = new Map(macroPipeUgs.map((u) => [`${u.tx},${u.ty}`, u]));
  for (const u of macroPipeUgs) {
    const oppDir = oppositeDir(u.dir);
    const oppIdx = dirToIdx4(oppDir);
    if (oppIdx !== 1 && oppIdx !== 2) continue; // scan each pair once along EAST or SOUTH
    const dx = DX4[oppIdx];
    const dy = DY4[oppIdx];
    const isHoriz = dx !== 0;
    for (let step = 1; step <= PIPE_SPEC.maxUgDistance; step++) {
      const cand = macroPipeUgMap.get(`${u.tx + dx * step},${u.ty + dy * step}`);
      if (!cand) continue;
      if (cand.dir === oppDir) {
        for (let k = 0; k <= step; k++) {
          const tidx = (u.ty + dy * k) * W + (u.tx + dx * k);
          if (isHoriz) buf.ugHorizOcc[tidx]++;
          else buf.ugVertOcc[tidx]++;
        }
        break;
      }
      if (cand.dir === u.dir) break;
    }
  }

  // Block perimeter pins on edge AND reserve 1-tile port stubs for each net
  for (const pin of floorplan.pins) {
    if (pin.x >= 0 && pin.x < W && pin.y >= 0 && pin.y < H) {
      const idx = pin.y * W + pin.x;
      buf.staticBlock[idx] = 1;
      buf.macroObstacle[idx] = 1;
      if (pin.isFluid) {
        buf.staticFluidId[idx] = getOrAssignFluidId(pin.item);
      }
    }
  }

  for (const s of specs) {
    if (s.sx >= 0 && s.sx < W && s.sy >= 0 && s.sy < H) {
      const idx = s.sy * W + s.sx;
      if (buf.pinReserved[idx] === -1) buf.pinReserved[idx] = s.netIdx;
    }
    if (s.tx >= 0 && s.tx < W && s.ty >= 0 && s.ty < H) {
      const idx = s.ty * W + s.tx;
      if (buf.pinReserved[idx] === -1) buf.pinReserved[idx] = s.netIdx;
    }
  }
}

function tileSurfaceCost(
  buf: RouterBuffers,
  tileIdx: number,
  netIdx: number,
  allowCongestion: boolean,
): number {
  if (buf.staticBlock[tileIdx] !== 0) return Infinity;
  const res = buf.pinReserved[tileIdx];
  if (res >= 0 && res !== netIdx) return Infinity;

  const occ = buf.surfaceCount[tileIdx];
  const owner = buf.surfaceOwner[tileIdx];
  if (occ === 0 || (occ === 1 && owner === netIdx)) {
    return 1.0 + buf.histCost[tileIdx] * 0.2;
  }
  if (!allowCongestion) return Infinity;
  return 1.0 + (buf.histCost[tileIdx] + 1.0) * buf.presFactor * (occ + 1);
}

function hasSurfaceFluidPort(kind: number, dirIdx: number, towardDirIdx: number): boolean {
  if (kind === 1) return true; // Regular pipe connects on all 4 surface faces
  if (kind === 2) return towardDirIdx === ((dirIdx + 2) & 3); // ug-in surface port faces opposite travel dir
  if (kind === 3) return towardDirIdx === dirIdx; // ug-out surface port faces travel dir
  return false;
}

function fluidMixingPenalty(
  buf: RouterBuffers,
  x: number,
  y: number,
  myKind: number,
  myDirIdx: number,
  spec: RouteNetSpec,
  allowCongestion: boolean,
): { penalty: number; conflictNet: number } {
  const W = buf.width;
  const H = buf.height;
  const myFluidId = spec.fluidId;
  const isStartTile = x === spec.sx && y === spec.sy;
  const isGoalTile = x === spec.tx && y === spec.ty;
  for (let k = 0; k < 4; k++) {
    if (!hasSurfaceFluidPort(myKind, myDirIdx, k)) continue;
    const nx = x + DX4[k];
    const ny = y + DY4[k];
    if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
    const nIdx = ny * W + nx;
    const opp = (k + 2) & 3;
    const isEndpointStaticPin =
      (isStartTile && nIdx === spec.sourcePipeTile) ||
      (isGoalTile && nIdx === spec.allowedTargetTile);

    const sf = buf.staticFluidId[nIdx];
    if (sf > 0 && (sf !== myFluidId || !isEndpointStaticPin)) {
      return { penalty: Infinity, conflictNet: -1 };
    }
    const suf = buf.staticPipeUgFluid[nIdx];
    if (suf > 0 && buf.staticPipeUgDir[nIdx] === opp && (suf !== myFluidId || !isEndpointStaticPin)) {
      return { penalty: Infinity, conflictNet: -1 };
    }
    const rf = buf.routedFluidId[nIdx];
    const owner = buf.surfaceOwner[nIdx];
    if (
      rf > 0 &&
      owner !== spec.netIdx &&
      buf.surfaceCount[nIdx] > 0 &&
      hasSurfaceFluidPort(buf.surfaceKind[nIdx], buf.surfaceDir[nIdx], opp)
    ) {
      if (!allowCongestion) {
        return { penalty: Infinity, conflictNet: owner };
      }
      return { penalty: buf.presFactor * 32.0, conflictNet: owner };
    }
  }
  return { penalty: 0, conflictNet: -1 };
}

/**
 * Checks if placing a surface belt or ug-out at (x, y) pointing in `dirIdx`
 * would side-load into an adjacent foreign belt or macro obstacle.
 */
function sideLoadPenalty(
  buf: RouterBuffers,
  x: number,
  y: number,
  dirIdx: number,
  spec: RouteNetSpec,
  allowCongestion: boolean,
): number {
  if (spec.isFluid) return 0; // Pipes use fluidMixingPenalty rather than belt side-load rules

  const nx = x + DX4[dirIdx];
  const ny = y + DY4[dirIdx];
  const W = buf.width;
  const H = buf.height;
  if (nx < 0 || nx >= W || ny < 0 || ny >= H) return Infinity;
  const nIdx = ny * W + nx;

  // Target is our own macro pin or perimeter output pin -> explicitly valid!
  if (nIdx === spec.allowedTargetTile) return 0;

  if (buf.macroObstacle[nIdx] !== 0) {
    return Infinity; // Never point a belt into a non-target macro/edge obstacle
  }

  // Belts ending adjacent to a routed pipe do not side-load onto pipes
  if (buf.routedFluidId[nIdx] > 0) return 0;

  const nOcc = buf.surfaceCount[nIdx];
  if (nOcc > 0 && buf.surfaceOwner[nIdx] !== spec.netIdx) {
    if (!allowCongestion) return Infinity;
    return buf.presFactor * 12.0;
  }
  return 0;
}

function buildCoarseCorridor(
  buf: RouterBuffers,
  spec: RouteNetSpec,
  pad = 12,
): boolean {
  const W = buf.width;
  const H = buf.height;
  buf.corridorMask.fill(0);

  // Simple fast 4x4 coarse BFS/A* or bounding L-corridor + margin
  const minX = Math.max(1, Math.min(spec.sx, spec.tx) - pad);
  const maxX = Math.min(W - 2, Math.max(spec.sx, spec.tx) + pad);
  const minY = Math.max(1, Math.min(spec.sy, spec.ty) - pad);
  const maxY = Math.min(H - 2, Math.max(spec.sy, spec.ty) + pad);

  for (let y = minY; y <= maxY; y++) {
    const row = y * W;
    for (let x = minX; x <= maxX; x++) {
      buf.corridorMask[row + x] = 1;
    }
  }
  buf.corridorMask[spec.sy * W + spec.sx] = 1;
  buf.corridorMask[spec.ty * W + spec.tx] = 1;
  return true;
}

function commitNetPath(
  buf: RouterBuffers,
  spec: RouteNetSpec,
  steps: PlacedTileStep[],
): void {
  const W = buf.width;
  for (const st of steps) {
    buf.surfaceCount[st.tileIdx]++;
    buf.surfaceOwner[st.tileIdx] = spec.netIdx;
    buf.surfaceDir[st.tileIdx] = st.dirIdx;
    buf.surfaceKind[st.tileIdx] = st.kind;
    if (spec.isFluid) {
      buf.routedFluidId[st.tileIdx] = spec.fluidId;
    }

    if (st.kind === 2 && st.jumpDist >= 2) {
      const sx = st.tileIdx % W;
      const sy = (st.tileIdx - sx) / W;
      const dx = DX4[st.dirIdx];
      const dy = DY4[st.dirIdx];
      const isHoriz = dx !== 0;
      for (let k = 0; k <= st.jumpDist; k++) {
        const idx = (sy + dy * k) * W + (sx + dx * k);
        if (isHoriz) buf.ugHorizOcc[idx]++;
        else buf.ugVertOcc[idx]++;
      }
    }
  }
}

function ripUpNetPath(
  buf: RouterBuffers,
  steps: PlacedTileStep[],
): void {
  const W = buf.width;
  for (const st of steps) {
    if (buf.surfaceCount[st.tileIdx] > 0) {
      buf.surfaceCount[st.tileIdx]--;
    }
    if (buf.surfaceCount[st.tileIdx] === 0) {
      buf.surfaceOwner[st.tileIdx] = -1;
      buf.surfaceKind[st.tileIdx] = 0;
      buf.routedFluidId[st.tileIdx] = 0;
    }
    if (st.kind === 2 && st.jumpDist >= 2) {
      const sx = st.tileIdx % W;
      const sy = (st.tileIdx - sx) / W;
      const dx = DX4[st.dirIdx];
      const dy = DY4[st.dirIdx];
      const isHoriz = dx !== 0;
      for (let k = 0; k <= st.jumpDist; k++) {
        const idx = (sy + dy * k) * W + (sx + dx * k);
        if (isHoriz) {
          if (buf.ugHorizOcc[idx] > 0) buf.ugHorizOcc[idx]--;
        } else {
          if (buf.ugVertOcc[idx] > 0) buf.ugVertOcc[idx]--;
        }
      }
    }
  }
}

/** Prevents a single net from stepping or landing onto tiles already used in its own ancestor chain (including skipped ug-out tiles). */
function isAncestorTileUsed(
  buf: RouterBuffers,
  state: number,
  activeStamp: number,
  targetTile: number,
  tx: number,
  ty: number,
): boolean {
  const cs = buf.closedStamp;
  const pj = buf.parentJump;
  const base = targetTile << 2;
  let mightCollide =
    cs[base] === activeStamp ||
    cs[base | 1] === activeStamp ||
    cs[base | 2] === activeStamp ||
    cs[base | 3] === activeStamp;

  const W = buf.width;
  const H = buf.height;
  if (!mightCollide) {
    for (let d = 0; d < 4; d++) {
      const nx = tx + DX4[d];
      const ny = ty + DY4[d];
      if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
      const aState = ((ny * W + nx) << 2) | d;
      if (cs[aState] === activeStamp && (pj[aState] & 0x7f) >= 2 && (pj[aState] & 0x80) === 0) {
        mightCollide = true;
        break;
      }
    }
  }
  if (!mightCollide) return false;

  const ps = buf.parentState;
  let cur = state;
  while (cur >= 0) {
    if ((cur >> 2) === targetTile) return true;
    const j = pj[cur];
    const jLen = j & 0x7f;
    const p = ps[cur];
    if (jLen >= 2 && (j & 0x80) === 0 && p >= 0) {
      const pTile = p >> 2;
      const pDir = p & 3;
      const px = pTile % W;
      const py = (pTile - px) / W;
      const ex = px + DX4[pDir] * jLen;
      const ey = py + DY4[pDir] * jLen;
      if (ey * W + ex === targetTile) return true;
    }
    cur = p;
  }
  return false;
}

/** Prevents a single fluid pipe net from folding orthogonally adjacent to its own earlier surface pipes. */
function hasAdjacentAncestorSurfacePipe(
  buf: RouterBuffers,
  state: number,
  activeStamp: number,
  nx: number,
  ny: number,
  directPrevTile: number,
): boolean {
  const W = buf.width;
  const H = buf.height;
  const cs = buf.closedStamp;
  let mightCollide = false;
  for (let d = 0; d < 4; d++) {
    const ax = nx + DX4[d];
    const ay = ny + DY4[d];
    if (ax < 0 || ax >= W || ay < 0 || ay >= H) continue;
    const aTile = ay * W + ax;
    if (aTile === directPrevTile) continue;
    const base = aTile << 2;
    if (
      cs[base] === activeStamp ||
      cs[base | 1] === activeStamp ||
      cs[base | 2] === activeStamp ||
      cs[base | 3] === activeStamp
    ) {
      mightCollide = true;
      break;
    }
  }
  if (!mightCollide) return false;

  const ps = buf.parentState;
  const pj = buf.parentJump;
  let child = state;
  let cur = ps[state];
  while (cur >= 0) {
    const cTile = cur >> 2;
    const cDir = cur & 3;
    const jLen = pj[child] & 0x7f;
    const cx = cTile % W;
    const cy = (cTile - cx) / W;

    if (jLen >= 2) {
      // `cur` is ug-in whose only open surface port faces opposite `cDir`
      const opp = (cDir + 2) & 3;
      if (cx + DX4[opp] === nx && cy + DY4[opp] === ny) return true;
    } else if (cTile !== directPrevTile) {
      if (Math.abs(cx - nx) + Math.abs(cy - ny) === 1) return true;
    }
    child = cur;
    cur = ps[cur];
  }
  return false;
}

function routeSingleNet(
  buf: RouterBuffers,
  spec: RouteNetSpec,
  allowCongestion: boolean,
  useCorridor: boolean,
  turnPenalty = 0.65,
  ugBasePenalty = 3.8,
  hWeight = 1.0,
  corridorPad = 14,
  preventSelfLoop = false,
): PlacedTileStep[] | null {
  const W = buf.width;
  const H = buf.height;
  const { sx, sy, srcDirIdx, tx, ty, dstDirIdx, maxUgDist } = spec;

  if (sx < 0 || sx >= W || sy < 0 || sy >= H) return null;
  if (tx < 0 || tx >= W || ty < 0 || ty >= H) return null;

  const startTile = sy * W + sx;
  const goalTile = ty * W + tx;

  // Validate start & goal tiles aren't hard-blocked
  if (buf.staticBlock[startTile] !== 0 || buf.staticBlock[goalTile] !== 0) {
    return null;
  }

  if (useCorridor) {
    buildCoarseCorridor(buf, spec, corridorPad);
  }

  const stamp = ++buf.currentStamp;
  if (stamp >= 0x7ffffff0) {
    buf.closedStamp.fill(0);
    buf.openStamp.fill(0);
    buf.currentStamp = 1;
  }
  const activeStamp = buf.currentStamp;
  buf.heapSize = 0;

  // Goal encoding: virtual terminal state `numGridStates` or stop directly when popping goalTile
  const startState = (startTile << 2) | srcDirIdx;
  buf.gScore[startState] = 0;
  buf.parentState[startState] = -1;
  buf.parentJump[startState] = 0;
  buf.openStamp[startState] = activeStamp;
  heapPush(buf, startState, (Math.abs(tx - sx) + Math.abs(ty - sy)) * hWeight);

  const gScore = buf.gScore;
  const parentState = buf.parentState;
  const parentJump = buf.parentJump;
  const closedStamp = buf.closedStamp;
  const openStamp = buf.openStamp;
  const corridor = buf.corridorMask;
  const ugH = buf.ugHorizOcc;
  const ugV = buf.ugVertOcc;

  let reachedGoalState = -1;
  let goalArrivedViaUg = false;

  while (buf.heapSize > 0) {
    const state = heapPop(buf);
    if (closedStamp[state] === activeStamp) continue;
    closedStamp[state] = activeStamp;

    const tile = state >> 2;
    const dIdx = state & 3;
    const x = tile % W;
    const y = (tile - x) / W;

    if (tile === goalTile) {
      // Can exit in dstDirIdx unless arrived from exact opposite (which requires 180° U-turn)
      if (((dIdx + 2) & 3) !== dstDirIdx) {
        // Verify exiting tile `goalTile` in `dstDirIdx` is legal
        const slPen = sideLoadPenalty(buf, x, y, dstDirIdx, spec, allowCongestion);
        if (slPen < Infinity) {
          reachedGoalState = state;
          goalArrivedViaUg = (parentJump[state] & 0x80) !== 0;
          break;
        }
      }
    }

    const curG = gScore[state];

    // 1. Surface step: straight (dIdx) or 90-degree turn (left/right)
    const dirsToTry = [dIdx, (dIdx + 1) & 3, (dIdx + 3) & 3];
    for (let t = 0; t < 3; t++) {
      const nd = dirsToTry[t];
      const nx = x + DX4[nd];
      const ny = y + DY4[nd];
      if (nx < 1 || nx >= W - 1 || ny < 1 || ny >= H - 1) {
        // Only allow perimeter boundary tile if it IS goalTile
        if (!(nx === tx && ny === ty)) continue;
      }
      if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;

      const nTile = ny * W + nx;
      if (useCorridor && corridor[nTile] === 0) continue;

      const nextBaseCost = tileSurfaceCost(buf, nTile, spec.netIdx, allowCongestion);
      if (nextBaseCost === Infinity) continue;

      if ((preventSelfLoop || spec.isFluid) && isAncestorTileUsed(buf, state, activeStamp, nTile, nx, ny)) {
        continue;
      }
      if (spec.isFluid && hasAdjacentAncestorSurfacePipe(buf, state, activeStamp, nx, ny, tile)) {
        continue;
      }

      const slPen = sideLoadPenalty(buf, x, y, nd, spec, allowCongestion);
      if (slPen === Infinity) continue;

      let fluidPen = 0;
      if (spec.isFluid) {
        const mxStart =
          tile === startTile
            ? fluidMixingPenalty(buf, x, y, 1, dIdx, spec, allowCongestion).penalty
            : 0;
        const mxNext = fluidMixingPenalty(
          buf,
          nx,
          ny,
          1,
          nd,
          spec,
          allowCongestion,
        ).penalty;
        fluidPen = mxStart + mxNext;
        if (fluidPen === Infinity) continue;
      }

      const turnCost = nd === dIdx ? 0 : turnPenalty;
      const p1d = (nd + 1) & 3;
      const p2d = (nd + 3) & 3;
      const isAlignedSide = (sxN: number, syN: number): boolean => {
        if (sxN < 0 || sxN >= W || syN < 0 || syN >= H) return true;
        const sIdx = syN * W + sxN;
        if (buf.staticBlock[sIdx] !== 0) return true;
        return (
          buf.surfaceCount[sIdx] > 0 &&
          buf.surfaceOwner[sIdx] !== spec.netIdx &&
          (buf.surfaceDir[sIdx] & 1) === (nd & 1)
        );
      };
      const aligned =
        isAlignedSide(nx + DX4[p1d], ny + DY4[p1d]) ||
        isAlignedSide(nx + DX4[p2d], ny + DY4[p2d]);
      const busBias = spec.isFluid ? 0 : aligned ? 0 : 0.06;
      const candG = curG + nextBaseCost + slPen + fluidPen + turnCost + busBias;
      const nState = (nTile << 2) | nd;

      if (closedStamp[nState] === activeStamp) continue;
      if (openStamp[nState] !== activeStamp || candG < gScore[nState]) {
        gScore[nState] = candG;
        parentState[nState] = state;
        parentJump[nState] = 0; // surface belt
        openStamp[nState] = activeStamp;
        const h = Math.abs(tx - nx) + Math.abs(ty - ny);
        heapPush(buf, nState, candG + h * hWeight);
      }
    }

    // 2. Underground jump straight along dIdx (k = 2 .. maxUgDist)
    const dx = DX4[dIdx];
    const dy = DY4[dIdx];
    const isHoriz = dx !== 0;

    // Check entry tile (x, y) itself doesn't clash with existing underground along same axis
    const entryUgOcc = isHoriz ? ugH[tile] : ugV[tile];
    if (entryUgOcc > 0 && !allowCongestion) continue;

    let entryFluidPen = 0;
    if (spec.isFluid) {
      entryFluidPen = fluidMixingPenalty(
        buf,
        x,
        y,
        2,
        dIdx,
        spec,
        allowCongestion,
      ).penalty;
      if (entryFluidPen === Infinity) continue;
    }

    // Check surface tile (x, y) isn't already congested if we jump from here
    let ugBlocked = false;
    for (let k = 1; k <= maxUgDist; k++) {
      const ex = x + dx * k;
      const ey = y + dy * k;
      if (ex < 0 || ex >= W || ey < 0 || ey >= H) break;
      const eTile = ey * W + ex;

      const sameAxisOcc = isHoriz ? ugH[eTile] : ugV[eTile];
      if (sameAxisOcc > 0) {
        if (!allowCongestion) {
          ugBlocked = true;
          break;
        }
      }

      if (k < 2) continue;

      // Skip intermediate tiles inside static blocks, only land ug-out on valid surface tile
      if (ex < 1 || ex >= W - 1 || ey < 1 || ey >= H - 1) {
        if (!(ex === tx && ey === ty)) continue;
      }
      if (useCorridor && corridor[eTile] === 0) continue;

      const outCost = tileSurfaceCost(buf, eTile, spec.netIdx, allowCongestion);
      if (outCost === Infinity) continue;

      // Case A: landing directly on goalTile heading dstDirIdx
      if (eTile === goalTile && dIdx === dstDirIdx) {
        if ((preventSelfLoop || spec.isFluid) && isAncestorTileUsed(buf, state, activeStamp, eTile, ex, ey)) continue;
        const slPen = sideLoadPenalty(buf, ex, ey, dIdx, spec, allowCongestion);
        const exitFluidPenA = spec.isFluid
          ? fluidMixingPenalty(buf, ex, ey, 3, dIdx, spec, allowCongestion).penalty
          : 0;
        if (slPen < Infinity && exitFluidPenA < Infinity) {
          let spanPenaltyA = 0;
          if (allowCongestion) {
            for (let m = 0; m <= k; m++) {
              const mIdx = (y + dy * m) * W + (x + dx * m);
              const occ = isHoriz ? ugH[mIdx] : ugV[mIdx];
              if (occ > 0) spanPenaltyA += buf.presFactor * 8 * occ;
            }
          }
          const jumpCost =
            ugBasePenalty + k * 1.02 + slPen + outCost + entryFluidPen + exitFluidPenA + spanPenaltyA;
          const candG = curG + jumpCost;
          const nState = (eTile << 2) | dIdx;
          if (closedStamp[nState] !== activeStamp && (openStamp[nState] !== activeStamp || candG < gScore[nState])) {
            gScore[nState] = candG;
            parentState[nState] = state;
            parentJump[nState] = k | 0x80;
            openStamp[nState] = activeStamp;
            heapPush(buf, nState, candG);
          }
        }
        continue;
      }

      // Case B: standard underground exit at (ex, ey) followed immediately by 1 step to (ax, ay)
      const ax = ex + dx;
      const ay = ey + dy;
      if (ax < 1 || ax >= W - 1 || ay < 1 || ay >= H - 1) {
        if (!(ax === tx && ay === ty)) continue;
      }
      if (ax < 0 || ax >= W || ay < 0 || ay >= H) continue;
      const aTile = ay * W + ax;
      if (useCorridor && corridor[aTile] === 0) continue;

      const aCost = tileSurfaceCost(buf, aTile, spec.netIdx, allowCongestion);
      if (aCost === Infinity) continue;

      if (
        (preventSelfLoop || spec.isFluid) &&
        (isAncestorTileUsed(buf, state, activeStamp, eTile, ex, ey) ||
          isAncestorTileUsed(buf, state, activeStamp, aTile, ax, ay))
      ) {
        continue;
      }
      if (spec.isFluid && hasAdjacentAncestorSurfacePipe(buf, state, activeStamp, ax, ay, tile)) {
        continue;
      }

      const slExit = sideLoadPenalty(buf, ex, ey, dIdx, spec, allowCongestion);
      if (slExit === Infinity) continue;

      let exitFluidPen = 0;
      if (spec.isFluid) {
        exitFluidPen =
          fluidMixingPenalty(buf, ex, ey, 3, dIdx, spec, allowCongestion).penalty +
          fluidMixingPenalty(buf, ax, ay, 1, dIdx, spec, allowCongestion).penalty;
        if (exitFluidPen === Infinity) continue;
      }

      let spanPenalty = 0;
      if (allowCongestion) {
        for (let m = 0; m <= k; m++) {
          const mIdx = (y + dy * m) * W + (x + dx * m);
          const occ = isHoriz ? ugH[mIdx] : ugV[mIdx];
          if (occ > 0) spanPenalty += buf.presFactor * 8 * occ;
        }
      }

      const candG =
        curG +
        ugBasePenalty +
        k * 1.02 +
        outCost +
        aCost +
        slExit +
        entryFluidPen +
        exitFluidPen +
        spanPenalty;
      const nState = (aTile << 2) | dIdx;
      if (closedStamp[nState] === activeStamp) continue;
      if (openStamp[nState] !== activeStamp || candG < gScore[nState]) {
        gScore[nState] = candG;
        parentState[nState] = state;
        parentJump[nState] = k;
        openStamp[nState] = activeStamp;
        const h = Math.abs(tx - ax) + Math.abs(ty - ay);
        heapPush(buf, nState, candG + h * hWeight);
      }
    }
    void ugBlocked;
  }

  if (reachedGoalState < 0) return null;

  // Reconstruct tile sequence backwards
  const chain: Array<{ state: number; jump: number }> = [];
  let cur = reachedGoalState;
  while (cur >= 0) {
    chain.push({ state: cur, jump: parentJump[cur] });
    cur = parentState[cur];
  }
  chain.reverse();

  const steps: PlacedTileStep[] = [];
  for (let i = 0; i < chain.length; i++) {
    const node = chain[i];
    const tile = node.state >> 2;
    const dIdx = node.state & 3;

    if (i === chain.length - 1) {
      const jumpLen = node.jump & 0x7f;
      if (goalArrivedViaUg && jumpLen >= 2) {
        // The last chain item IS the ug-out directly on goalTile
        const prevTile = chain[i - 1].state >> 2;
        const prevDir = chain[i - 1].state & 3;
        steps.push({ tileIdx: prevTile, dirIdx: prevDir, kind: 2, jumpDist: jumpLen });
        steps.push({ tileIdx: tile, dirIdx: dIdx, kind: 3, jumpDist: 0 });
      } else {
        // Normal final belt pointing out toward dstDirIdx
        steps.push({ tileIdx: tile, dirIdx: dstDirIdx, kind: 1, jumpDist: 0 });
      }
      break;
    }

    const next = chain[i + 1];
    const nextJumpLen = next.jump & 0x7f;
    const nextIsDirectUg = (next.jump & 0x80) !== 0;
    if (nextJumpLen >= 2) {
      // Edge from `node` to `next` was an underground jump of length `nextJumpLen`!
      const x = tile % W;
      const y = (tile - x) / W;
      const dx = DX4[dIdx];
      const dy = DY4[dIdx];
      const ex = x + dx * nextJumpLen;
      const ey = y + dy * nextJumpLen;
      const eTile = ey * W + ex;

      if (nextIsDirectUg) {
        // Direct jump to goalTile handled when i+1 is reached above
        continue;
      }

      steps.push({ tileIdx: tile, dirIdx: dIdx, kind: 2, jumpDist: nextJumpLen });
      steps.push({ tileIdx: eTile, dirIdx: dIdx, kind: 3, jumpDist: 0 });
    } else {
      // Surface step: tile's belt faces the direction we moved to reach next
      const nextDir = next.state & 3;
      steps.push({ tileIdx: tile, dirIdx: nextDir, kind: 1, jumpDist: 0 });
    }
  }

  if (!preventSelfLoop && steps.length > 1) {
    let dupCheckStamp = ++buf.currentStamp;
    if (dupCheckStamp >= 0x7ffffff0) {
      buf.closedStamp.fill(0);
      buf.openStamp.fill(0);
      buf.currentStamp = 1;
      dupCheckStamp = 1;
    }
    let hasSelfLoop = false;
    for (let i = 0; i < steps.length; i++) {
      const slot = steps[i].tileIdx << 2;
      if (buf.openStamp[slot] === dupCheckStamp) {
        hasSelfLoop = true;
        break;
      }
      buf.openStamp[slot] = dupCheckStamp;
    }
    if (hasSelfLoop) {
      return routeSingleNet(
        buf,
        spec,
        allowCongestion,
        useCorridor,
        turnPenalty,
        ugBasePenalty,
        hWeight,
        corridorPad,
        true,
      );
    }
  }

  return steps;
}

function findConflicts(
  buf: RouterBuffers,
  specs: RouteNetSpec[],
  netSteps: Array<PlacedTileStep[] | null>,
): { conflictTiles: Set<number>; conflictingNets: Set<number>; totalConflicts: number } {
  const W = buf.width;
  const H = buf.height;
  const conflictTiles = new Set<number>();
  const conflictingNets = new Set<number>();
  let totalConflicts = 0;

  for (let i = 0; i < specs.length; i++) {
    const steps = netSteps[i];
    if (!steps) {
      conflictingNets.add(i);
      totalConflicts += 10;
      continue;
    }

    let netHasConflict = false;
    for (const st of steps) {
      if (buf.surfaceCount[st.tileIdx] > 1) {
        conflictTiles.add(st.tileIdx);
        netHasConflict = true;
        totalConflicts++;
      }

      // Check underground span conflicts
      if (st.kind === 2 && st.jumpDist >= 2) {
        const sx = st.tileIdx % W;
        const sy = (st.tileIdx - sx) / W;
        const dx = DX4[st.dirIdx];
        const dy = DY4[st.dirIdx];
        const isHoriz = dx !== 0;
        for (let k = 0; k <= st.jumpDist; k++) {
          const tidx = (sy + dy * k) * W + (sx + dx * k);
          const occ = isHoriz ? buf.ugHorizOcc[tidx] : buf.ugVertOcc[tidx];
          if (occ > 1) {
            conflictTiles.add(tidx);
            netHasConflict = true;
            totalConflicts++;
          }
        }
      }

      // Check accidental side-loading: belt or ug-out pointing into another net's tile
      if (!specs[i].isFluid && (st.kind === 1 || st.kind === 3)) {
        const x = st.tileIdx % W;
        const y = (st.tileIdx - x) / W;
        const nx = x + DX4[st.dirIdx];
        const ny = y + DY4[st.dirIdx];
        if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
          const nIdx = ny * W + nx;
          if (
            nIdx !== specs[i].allowedTargetTile &&
            buf.routedFluidId[nIdx] === 0 &&
            buf.surfaceCount[nIdx] > 0 &&
            buf.surfaceOwner[nIdx] !== specs[i].netIdx
          ) {
            conflictTiles.add(nIdx);
            netHasConflict = true;
            totalConflicts++;
          }
        }
      }

      // Check fluid mixing / adjacent distinct pipe conflict on surface pipe connections
      if (specs[i].isFluid) {
        const x = st.tileIdx % W;
        const y = (st.tileIdx - x) / W;
        const mx = fluidMixingPenalty(buf, x, y, st.kind, st.dirIdx, specs[i], false);
        if (mx.penalty === Infinity) {
          conflictTiles.add(st.tileIdx);
          netHasConflict = true;
          totalConflicts++;
          if (mx.conflictNet >= 0) {
            conflictingNets.add(mx.conflictNet);
          }
        }
      }
    }

    if (netHasConflict) {
      conflictingNets.add(i);
    }
  }

  return { conflictTiles, conflictingNets, totalConflicts };
}

function scoreNetSteps(steps: PlacedTileStep[]): number {
  let bends = 0;
  let ugPairs = 0;
  let span = 0;
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i];
    if (st.kind === 2) {
      ugPairs++;
      span += Math.max(1, st.jumpDist);
    } else {
      span += 1;
    }
    if (i > 0 && st.dirIdx !== steps[i - 1].dirIdx) bends++;
  }
  return span + bends * 0.9 + ugPairs * 4.5;
}

function optimizeRoutedNets(
  buf: RouterBuffers,
  specs: RouteNetSpec[],
  netSteps: Array<PlacedTileStep[] | null>,
  maxPasses = 4,
  shouldCancel?: () => boolean,
  skipPairs = false,
): void {
  const W = buf.width;

  // Phase A: Single-net conflict-free rip-up & straightening
  for (let pass = 0; pass < maxPasses; pass++) {
    if (shouldCancel?.()) break;
    const candidates = specs
      .map((s, idx) => {
        const steps = netSteps[idx];
        if (!steps) return null;
        const manhattan = Math.abs(s.tx - s.sx) + Math.abs(s.ty - s.sy) + 1;
        const sc = scoreNetSteps(steps);
        const excess = sc - manhattan;
        return excess > 1.0 ? { idx, excess } : null;
      })
      .filter((c): c is { idx: number; excess: number } => c !== null)
      .sort((a, b) => b.excess - a.excess);

    let improvedAny = false;
    for (const c of candidates) {
      if (shouldCancel?.()) break;
      const oldSteps = netSteps[c.idx];
      if (!oldSteps) continue;
      const oldScore = scoreNetSteps(oldSteps);

      ripUpNetPath(buf, oldSteps);
      const cand = routeSingleNet(buf, specs[c.idx], false, false, 0.8, 4.5);
      if (cand && scoreNetSteps(cand) < oldScore - 1e-4) {
        netSteps[c.idx] = cand;
        commitNetPath(buf, specs[c.idx], cand);
        improvedAny = true;
      } else {
        commitNetPath(buf, specs[c.idx], oldSteps);
      }
    }
    if (!improvedAny) break;
  }

  // Phase B: Pairwise rip-up & swap net priority between nearby detoured nets
  if (skipPairs || shouldCancel?.()) return;
  const worstNets = specs
    .map((s, idx) => {
      const steps = netSteps[idx];
      if (!steps) return null;
      const manhattan = Math.abs(s.tx - s.sx) + Math.abs(s.ty - s.sy) + 1;
      const excess = scoreNetSteps(steps) - manhattan;
      return excess > 2.5 ? { idx, excess } : null;
    })
    .filter((c): c is { idx: number; excess: number } => c !== null)
    .sort((a, b) => b.excess - a.excess)
    .slice(0, 12)
    .map((c) => c.idx);

  const netBbox = (steps: PlacedTileStep[]) => {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const st of steps) {
      const tx = st.tileIdx % W;
      const ty = (st.tileIdx - tx) / W;
      if (tx < minX) minX = tx;
      if (tx > maxX) maxX = tx;
      if (ty < minY) minY = ty;
      if (ty > maxY) maxY = ty;
    }
    return { minX: minX - 2, maxX: maxX + 2, minY: minY - 2, maxY: maxY + 2 };
  };

  let pairsTried = 0;
  for (let a = 0; a < worstNets.length && pairsTried < 24; a++) {
    const i = worstNets[a];
    for (let b = a + 1; b < worstNets.length && pairsTried < 24; b++) {
      if (shouldCancel?.()) return;
      const j = worstNets[b];
      const si = netSteps[i];
      const sj = netSteps[j];
      if (!si || !sj) continue;

      const bi = netBbox(si);
      const bj = netBbox(sj);
      if (bi.maxX < bj.minX || bj.maxX < bi.minX || bi.maxY < bj.minY || bj.maxY < bi.minY) {
        continue;
      }

      pairsTried++;
      const origScore = scoreNetSteps(si) + scoreNetSteps(sj);
      ripUpNetPath(buf, si);
      ripUpNetPath(buf, sj);

      let bestSteps: [PlacedTileStep[], PlacedTileStep[]] | null = null;
      let bestScore = origScore - 0.5;

      // Order (i then j)
      const ci1 = routeSingleNet(buf, specs[i], false, false, 0.8, 4.5);
      if (ci1) {
        commitNetPath(buf, specs[i], ci1);
        const cj1 = routeSingleNet(buf, specs[j], false, false, 0.8, 4.5);
        if (cj1) {
          const sc = scoreNetSteps(ci1) + scoreNetSteps(cj1);
          if (sc < bestScore) {
            bestScore = sc;
            bestSteps = [ci1, cj1];
          }
        }
        ripUpNetPath(buf, ci1);
      }

      // Order (j then i)
      const cj2 = routeSingleNet(buf, specs[j], false, false, 0.8, 4.5);
      if (cj2) {
        commitNetPath(buf, specs[j], cj2);
        const ci2 = routeSingleNet(buf, specs[i], false, false, 0.8, 4.5);
        if (ci2) {
          const sc = scoreNetSteps(ci2) + scoreNetSteps(cj2);
          if (sc < bestScore) {
            bestScore = sc;
            bestSteps = [ci2, cj2];
          }
        }
        ripUpNetPath(buf, cj2);
      }

      if (bestSteps) {
        netSteps[i] = bestSteps[0];
        netSteps[j] = bestSteps[1];
        commitNetPath(buf, specs[i], bestSteps[0]);
        commitNetPath(buf, specs[j], bestSteps[1]);
      } else {
        commitNetPath(buf, specs[i], si);
        commitNetPath(buf, specs[j], sj);
      }
    }
  }
}

interface RoutingAttemptResult {
  netSteps: Array<PlacedTileStep[] | null>;
  iterations: number;
  conflictsRemaining: number;
  totalScore: number;
}

function runRoutingAttempt(
  floorplan: FloorplanResult,
  specs: RouteNetSpec[],
  fluidIdByItem: Map<string, number>,
  order: number[],
  optimizeRoutes: boolean,
  startTime: number,
  onProgress?: RouteProgressCallback,
  shouldCancel?: () => boolean,
): RoutingAttemptResult {
  const W = floorplan.width;
  const H = floorplan.height;
  const buf = createRouterBuffers(W, H);
  initStaticGrid(buf, floorplan, specs, fluidIdByItem);

  const netSteps: Array<PlacedTileStep[] | null> = new Array(specs.length).fill(null);
  const useCorridor = W * H > 80 * 80;
  const largeGrid = W * H > 5000;
  const hWeight = W * H > 10000 ? 1.12 : 1.0;
  const attemptStart = Date.now();
  const maxRouteMs = W * H > 25000 ? 4500 : 8000;
  const timedOut = () =>
    Boolean(shouldCancel?.()) || Date.now() - attemptStart > maxRouteMs;

  // Pass 0: greedy conflict-free routing where possible, falling back to congestion-aware
  for (const idx of order) {
    if (timedOut()) break;
    const spec = specs[idx];
    let steps = routeSingleNet(buf, spec, false, useCorridor, 0.65, 3.8, hWeight, 14);
    if (!steps && useCorridor) {
      steps = routeSingleNet(buf, spec, false, false, 0.65, 3.8, hWeight, 14);
    }
    if (!steps) {
      steps = routeSingleNet(buf, spec, true, false, 0.65, 3.8, hWeight, 14);
    }
    netSteps[idx] = steps;
    if (steps) {
      commitNetPath(buf, spec, steps);
    }
  }

  const MAX_ITERS = 36;
  let iterations = 0;
  let conflictInfo = findConflicts(buf, specs, netSteps);

  onProgress?.({
    iteration: 0,
    maxIterations: MAX_ITERS,
    conflicts: conflictInfo.totalConflicts,
    elapsedMs: Date.now() - startTime,
  });

  for (let iter = 1; iter <= MAX_ITERS && conflictInfo.totalConflicts > 0; iter++) {
    if (timedOut()) break;
    iterations = iter;

    for (const tIdx of conflictInfo.conflictTiles) {
      buf.histCost[tIdx] += 1.25;
    }
    buf.presFactor = 1.5 + iter * 0.75;

    const ripList = Array.from(conflictInfo.conflictingNets);
    if (iter % 2 === 1) ripList.reverse();

    for (const idx of ripList) {
      const prev = netSteps[idx];
      if (prev) {
        ripUpNetPath(buf, prev);
        netSteps[idx] = null;
      }
    }

    for (const idx of ripList) {
      if (timedOut()) break;
      const spec = specs[idx];
      let steps: PlacedTileStep[] | null;
      if (largeGrid) {
        steps = routeSingleNet(buf, spec, true, true, 0.65, 3.8, hWeight, 16 + iter * 5);
        if (!steps) {
          steps = routeSingleNet(buf, spec, true, false, 0.65, 3.8, hWeight, 14);
        }
      } else {
        steps = routeSingleNet(buf, spec, false, false, 0.65, 3.8, hWeight, 14);
        if (!steps) {
          steps = routeSingleNet(buf, spec, true, false, 0.65, 3.8, hWeight, 14);
        }
      }
      netSteps[idx] = steps;
      if (steps) {
        commitNetPath(buf, spec, steps);
      }
    }

    conflictInfo = findConflicts(buf, specs, netSteps);
    onProgress?.({
      iteration: iter,
      maxIterations: MAX_ITERS,
      conflicts: conflictInfo.totalConflicts,
      elapsedMs: Date.now() - startTime,
    });
  }

  if (optimizeRoutes && conflictInfo.totalConflicts === 0 && !timedOut()) {
    const hugeGrid = W * H > 25000 || Date.now() - startTime > 1200;
    optimizeRoutedNets(buf, specs, netSteps, hugeGrid ? 1 : 4, shouldCancel, hugeGrid);
    conflictInfo = findConflicts(buf, specs, netSteps);
  }

  let totalScore = 0;
  for (const steps of netSteps) {
    totalScore += steps ? scoreNetSteps(steps) : 1e6;
  }

  return {
    netSteps,
    iterations,
    conflictsRemaining: conflictInfo.totalConflicts,
    totalScore,
  };
}

export function routeGrid(
  synth: SynthesisResult,
  floorplan: FloorplanResult,
  onProgress?: RouteProgressCallback,
  shouldCancel?: () => boolean,
  optimizeRoutes = true,
): RouteResult {
  const startTime = Date.now();
  const W = floorplan.width;
  const H = floorplan.height;
  const fluidIdByItem = new Map<string, number>();
  const specs = buildRouteSpecs(synth, floorplan, fluidIdByItem);

  const byHpwl = specs.map((s, idx) => ({
    idx,
    hpwl: Math.abs(s.tx - s.sx) + Math.abs(s.ty - s.sy),
  }));
  const shortFirstOrder = [...byHpwl].sort((a, b) => a.hpwl - b.hpwl).map((o) => o.idx);

  let bestAttempt = runRoutingAttempt(
    floorplan,
    specs,
    fluidIdByItem,
    shortFirstOrder,
    optimizeRoutes,
    startTime,
    onProgress,
    shouldCancel,
  );

  // Dual-order routing trial: compare longest-first if shortest-first finished fast cleanly
  if (
    optimizeRoutes &&
    specs.length <= 45 &&
    bestAttempt.conflictsRemaining === 0 &&
    Date.now() - startTime < 150 &&
    !shouldCancel?.()
  ) {
    const longFirstOrder = [...byHpwl].sort((a, b) => b.hpwl - a.hpwl).map((o) => o.idx);
    const altAttempt = runRoutingAttempt(
      floorplan,
      specs,
      fluidIdByItem,
      longFirstOrder,
      optimizeRoutes,
      startTime,
      undefined,
      shouldCancel,
    );
    if (
      altAttempt.conflictsRemaining === 0 &&
      altAttempt.totalScore < bestAttempt.totalScore - 1e-4
    ) {
      bestAttempt = altAttempt;
    }
  }

  const { netSteps, iterations, conflictsRemaining } = bestAttempt;

  // Convert routed paths + perimeter pin edge stubs to EntityInstance[]
  const entities: EntityInstance[] = [];
  const routedNets: RoutedNetSegment[] = [];
  let rid = 0;

  // Emit perimeter edge pin stubs
  for (const pin of floorplan.pins) {
    const beltSpec = BELT_SPECS[pin.beltTier];
    entities.push({
      id: `pin-stub:${pin.id}`,
      name: pin.isFluid ? PIPE_SPEC.pipeName : beltSpec.beltName,
      tx: pin.x,
      ty: pin.y,
      w: 1,
      h: 1,
      direction: pin.dir,
      netId: pin.netId,
      item: pin.item,
      role: pin.isFluid ? 'pipe-route' : 'belt-route',
    });
  }

  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    const steps = netSteps[i];
    const beltSpec = BELT_SPECS[spec.beltTier];

    if (!steps) {
      routedNets.push({
        netId: spec.netId,
        item: spec.item,
        beltTier: spec.beltTier,
        isFluid: spec.isFluid || undefined,
        tiles: [],
        routed: false,
        length: 0,
        undergroundCount: 0,
      });
      continue;
    }

    let ugCount = 0;
    const segTiles: RoutedNetSegment['tiles'] = [];

    for (const st of steps) {
      const tx = st.tileIdx % W;
      const ty = (st.tileIdx - tx) / W;
      const dir = idx4ToDir(st.dirIdx);

      if (spec.isFluid) {
        if (st.kind === 1) {
          entities.push({
            id: `r:${rid++}`,
            name: PIPE_SPEC.pipeName,
            tx,
            ty,
            w: 1,
            h: 1,
            direction: dir,
            netId: spec.netId,
            item: spec.item,
            role: 'pipe-route',
          });
          segTiles.push({ tx, ty, dir, kind: 'belt' });
        } else if (st.kind === 2) {
          ugCount++;
          entities.push({
            id: `r:${rid++}`,
            name: PIPE_SPEC.undergroundName,
            tx,
            ty,
            w: 1,
            h: 1,
            direction: oppositeDir(dir),
            netId: spec.netId,
            item: spec.item,
            role: 'pipe-ug-route',
          });
          segTiles.push({ tx, ty, dir, kind: 'ug-in', jumpDist: st.jumpDist });
        } else {
          ugCount++;
          entities.push({
            id: `r:${rid++}`,
            name: PIPE_SPEC.undergroundName,
            tx,
            ty,
            w: 1,
            h: 1,
            direction: dir,
            netId: spec.netId,
            item: spec.item,
            role: 'pipe-ug-route',
          });
          segTiles.push({ tx, ty, dir, kind: 'ug-out' });
        }
        continue;
      }

      if (st.kind === 1) {
        entities.push({
          id: `r:${rid++}`,
          name: beltSpec.beltName,
          tx,
          ty,
          w: 1,
          h: 1,
          direction: dir,
          netId: spec.netId,
          item: spec.item,
          role: 'belt-route',
        });
        segTiles.push({ tx, ty, dir, kind: 'belt' });
      } else if (st.kind === 2) {
        ugCount++;
        entities.push({
          id: `r:${rid++}`,
          name: beltSpec.undergroundName,
          tx,
          ty,
          w: 1,
          h: 1,
          direction: dir,
          type: 'input',
          netId: spec.netId,
          item: spec.item,
          role: 'ug-route',
        });
        segTiles.push({ tx, ty, dir, kind: 'ug-in', jumpDist: st.jumpDist });
      } else {
        ugCount++;
        entities.push({
          id: `r:${rid++}`,
          name: beltSpec.undergroundName,
          tx,
          ty,
          w: 1,
          h: 1,
          direction: dir,
          type: 'output',
          netId: spec.netId,
          item: spec.item,
          role: 'ug-route',
        });
        segTiles.push({ tx, ty, dir, kind: 'ug-out' });
      }
    }

    routedNets.push({
      netId: spec.netId,
      item: spec.item,
      beltTier: spec.beltTier,
      isFluid: spec.isFluid || undefined,
      tiles: segTiles,
      routed: true,
      length: steps.length,
      undergroundCount: ugCount,
    });
  }

  return {
    width: W,
    height: H,
    routedNets,
    entities,
    iterations,
    conflictsRemaining,
    elapsedMs: Date.now() - startTime,
    autoExpandedCount: 0,
  };
}
