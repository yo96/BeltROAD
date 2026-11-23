import { Dir } from '../types.js';

export interface RouterBuffers {
  width: number;
  height: number;
  size: number;
  /** 1 = blocked for surface placement (macro entity / pole / inserter / etc.) */
  staticBlock: Uint8Array;
  /** 1 = tile contains a macro belt/ug/splitter (cannot be pointed into unless exact macro input pin) */
  macroObstacle: Uint8Array;
  /** -1 = unreserved, >= 0 = netIdx allowed to step onto this pin port tile on surface */
  pinReserved: Int32Array;
  /** Number of routed nets currently occupying surface tile */
  surfaceCount: Uint16Array;
  /** Last routed netIdx on surface tile (-1 if none) */
  surfaceOwner: Int32Array;
  /** Direction (0..3) of routed surface belt/ug-out/ug-in */
  surfaceDir: Uint8Array;
  /** Kind at surface tile: 0=empty, 1=belt, 2=ug-in, 3=ug-out */
  surfaceKind: Uint8Array;
  /** Horizontal underground span occupancy count (including macro internal ugs) */
  ugHorizOcc: Uint16Array;
  /** Vertical underground span occupancy count */
  ugVertOcc: Uint16Array;
  /** Static fluid ID (>0) at tile from macro pipes & perimeter fluid stubs */
  staticFluidId: Int16Array;
  /** Static underground-pipe fluid ID (>0) at tile */
  staticPipeUgFluid: Int16Array;
  /** Open surface port direction (0..3, -1 if none) of static pipe-to-ground at tile */
  staticPipeUgDir: Int8Array;
  /** Routed fluid ID (>0) occupying surface tile */
  routedFluidId: Int16Array;
  /** PathFinder historical congestion penalty */
  histCost: Float32Array;
  /** Per-tile present sharing factor */
  presFactor: number;

  // Reusable A* search buffers (4 directional states per tile)
  gScore: Float32Array;
  parentState: Int32Array;
  /** Transition kind into state: 0=surface, 1..15=underground jump distance k */
  parentJump: Uint8Array;
  closedStamp: Int32Array;
  openStamp: Int32Array;
  currentStamp: number;

  // Binary min-heap
  heapState: Int32Array;
  heapF: Float32Array;
  heapSize: number;

  // Optional coarse corridor mask (1 = inside corridor)
  corridorMask: Uint8Array;
}

export function createRouterBuffers(width: number, height: number): RouterBuffers {
  const size = width * height;
  const numStates = size * 4;
  return {
    width,
    height,
    size,
    staticBlock: new Uint8Array(size),
    macroObstacle: new Uint8Array(size),
    pinReserved: new Int32Array(size).fill(-1),
    surfaceCount: new Uint16Array(size),
    surfaceOwner: new Int32Array(size).fill(-1),
    surfaceDir: new Uint8Array(size),
    surfaceKind: new Uint8Array(size),
    ugHorizOcc: new Uint16Array(size),
    ugVertOcc: new Uint16Array(size),
    staticFluidId: new Int16Array(size),
    staticPipeUgFluid: new Int16Array(size),
    staticPipeUgDir: new Int8Array(size).fill(-1),
    routedFluidId: new Int16Array(size),
    histCost: new Float32Array(size),
    presFactor: 1.5,
    gScore: new Float32Array(numStates),
    parentState: new Int32Array(numStates).fill(-1),
    parentJump: new Uint8Array(numStates),
    closedStamp: new Int32Array(numStates),
    openStamp: new Int32Array(numStates),
    currentStamp: 1,
    heapState: new Int32Array(numStates),
    heapF: new Float32Array(numStates),
    heapSize: 0,
    corridorMask: new Uint8Array(size),
  };
}

export function heapPush(buf: RouterBuffers, state: number, f: number): void {
  if (buf.heapSize >= buf.heapState.length) {
    const nextCap = buf.heapState.length * 2;
    const ns = new Int32Array(nextCap);
    ns.set(buf.heapState);
    buf.heapState = ns;
    const nf = new Float32Array(nextCap);
    nf.set(buf.heapF);
    buf.heapF = nf;
  }
  let i = buf.heapSize++;
  const hs = buf.heapState;
  const hf = buf.heapF;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (hf[p] <= f) break;
    hs[i] = hs[p];
    hf[i] = hf[p];
    i = p;
  }
  hs[i] = state;
  hf[i] = f;
}

export function heapPop(buf: RouterBuffers): number {
  const hs = buf.heapState;
  const hf = buf.heapF;
  const top = hs[0];
  const n = --buf.heapSize;
  if (n > 0) {
    const lastS = hs[n];
    const lastF = hf[n];
    let i = 0;
    const half = n >> 1;
    while (i < half) {
      let c = (i << 1) + 1;
      const r = c + 1;
      if (r < n && hf[r] < hf[c]) c = r;
      if (lastF <= hf[c]) break;
      hs[i] = hs[c];
      hf[i] = hf[c];
      i = c;
    }
    hs[i] = lastS;
    hf[i] = lastF;
  }
  return top;
}

export const DX4 = new Int8Array([0, 1, 0, -1]); // N, E, S, W
export const DY4 = new Int8Array([-1, 0, 1, 0]);

export function dirToIdx4(dir: Dir): number {
  switch (dir) {
    case Dir.NORTH:
      return 0;
    case Dir.EAST:
      return 1;
    case Dir.SOUTH:
      return 2;
    case Dir.WEST:
      return 3;
  }
}

export function idx4ToDir(idx: number): Dir {
  switch (idx & 3) {
    case 0:
      return Dir.NORTH;
    case 1:
      return Dir.EAST;
    case 2:
      return Dir.SOUTH;
    default:
      return Dir.WEST;
  }
}
