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
import { BELT_SPECS, isBeltLikeName, isSplitterName, isUndergroundName } from '../data/entities.js';
import { dirDelta } from '../geometry.js';
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
  maxUgDist: number;
  sx: number;
  sy: number;
  srcDirIdx: number;
  tx: number;
  ty: number;
  dstDirIdx: number;
  /** Exact macro tile fed by (tx, ty) if sink is a macro pin, else -1 */
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
): RouteNetSpec[] {
  const macroById = new Map(floorplan.macros.map((m) => [m.id, m]));
  const pinById = new Map(floorplan.pins.map((p) => [p.id, p]));

  const specs: RouteNetSpec[] = [];
  synth.nets.forEach((net, idx) => {
    let sx = 0;
    let sy = 0;
    let srcDir = Dir.EAST;
    let fixedStartPin: PerimeterPin | undefined;

    if (net.source.nodeId.startsWith('in:')) {
      const p = pinById.get(net.source.nodeId);
      if (!p) return;
      const d = dirDelta(p.dir);
      sx = p.x + d.dx;
      sy = p.y + d.dy;
      srcDir = p.dir;
      fixedStartPin = p;
    } else {
      const pm = macroById.get(net.source.nodeId);
      const mp = pm?.macro.pins.find((p) => p.id === net.source.pinId);
      if (!pm || !mp) return;
      sx = pm.x + mp.portX;
      sy = pm.y + mp.portY;
      srcDir = mp.direction;
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

    specs.push({
      netIdx: idx,
      netId: net.id,
      item: net.item,
      beltTier: net.beltTier,
      maxUgDist: BELT_SPECS[net.beltTier].maxUgDistance,
      sx,
      sy,
      srcDirIdx: dirToIdx4(srcDir),
      tx,
      ty,
      dstDirIdx: dirToIdx4(dstDir),
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
): void {
  const W = buf.width;
  const H = buf.height;

  // Block all macro entities & register macro internal underground spans
  const macroUgs: Array<{
    tx: number;
    ty: number;
    dir: Dir;
    type: 'input' | 'output';
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

  // Block perimeter pins on edge AND reserve 1-tile port stubs for each net
  for (const pin of floorplan.pins) {
    if (pin.x >= 0 && pin.x < W && pin.y >= 0 && pin.y < H) {
      const idx = pin.y * W + pin.x;
      buf.staticBlock[idx] = 1;
      buf.macroObstacle[idx] = 1;
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

function routeSingleNet(
  buf: RouterBuffers,
  spec: RouteNetSpec,
  allowCongestion: boolean,
  useCorridor: boolean,
  turnPenalty = 0.65,
  ugBasePenalty = 3.8,
  hWeight = 1.0,
  corridorPad = 14,
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

      const slPen = sideLoadPenalty(buf, x, y, nd, spec, allowCongestion);
      if (slPen === Infinity) continue;

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
      const busBias = aligned ? 0 : 0.06;
      const candG = curG + nextBaseCost + slPen + turnCost + busBias;
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
        const slPen = sideLoadPenalty(buf, ex, ey, dIdx, spec, allowCongestion);
        if (slPen < Infinity) {
          let spanPenaltyA = 0;
          if (allowCongestion) {
            for (let m = 0; m <= k; m++) {
              const mIdx = (y + dy * m) * W + (x + dx * m);
              const occ = isHoriz ? ugH[mIdx] : ugV[mIdx];
              if (occ > 0) spanPenaltyA += buf.presFactor * 8 * occ;
            }
          }
          const jumpCost = ugBasePenalty + k * 1.02 + slPen + outCost + spanPenaltyA;
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

      const slExit = sideLoadPenalty(buf, ex, ey, dIdx, spec, allowCongestion);
      if (slExit === Infinity) continue;

      let spanPenalty = 0;
      if (allowCongestion) {
        for (let m = 0; m <= k; m++) {
          const mIdx = (y + dy * m) * W + (x + dx * m);
          const occ = isHoriz ? ugH[mIdx] : ugV[mIdx];
          if (occ > 0) spanPenalty += buf.presFactor * 8 * occ;
        }
      }

      const candG = curG + ugBasePenalty + k * 1.02 + outCost + aCost + slExit + spanPenalty;
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
      if (st.kind === 1 || st.kind === 3) {
        const x = st.tileIdx % W;
        const y = (st.tileIdx - x) / W;
        const nx = x + DX4[st.dirIdx];
        const ny = y + DY4[st.dirIdx];
        if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
          const nIdx = ny * W + nx;
          if (
            nIdx !== specs[i].allowedTargetTile &&
            buf.surfaceCount[nIdx] > 0 &&
            buf.surfaceOwner[nIdx] !== specs[i].netIdx
          ) {
            conflictTiles.add(nIdx);
            netHasConflict = true;
            totalConflicts++;
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
  order: number[],
  optimizeRoutes: boolean,
  startTime: number,
  onProgress?: RouteProgressCallback,
  shouldCancel?: () => boolean,
): RoutingAttemptResult {
  const W = floorplan.width;
  const H = floorplan.height;
  const buf = createRouterBuffers(W, H);
  initStaticGrid(buf, floorplan, specs);

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
  const specs = buildRouteSpecs(synth, floorplan);

  const byHpwl = specs.map((s, idx) => ({
    idx,
    hpwl: Math.abs(s.tx - s.sx) + Math.abs(s.ty - s.sy),
  }));
  const shortFirstOrder = [...byHpwl].sort((a, b) => a.hpwl - b.hpwl).map((o) => o.idx);

  let bestAttempt = runRoutingAttempt(
    floorplan,
    specs,
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
      name: beltSpec.beltName,
      tx: pin.x,
      ty: pin.y,
      w: 1,
      h: 1,
      direction: pin.dir,
      netId: pin.netId,
      item: pin.item,
      role: 'belt-route',
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
