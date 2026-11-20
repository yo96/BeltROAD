import { Dir, Edge, Rot90 } from './types.js';

export const CARDINAL_DIRS: readonly Dir[] = [Dir.NORTH, Dir.EAST, Dir.SOUTH, Dir.WEST];

export function dirDelta(dir: Dir): { dx: number; dy: number } {
  switch (dir) {
    case Dir.NORTH:
      return { dx: 0, dy: -1 };
    case Dir.EAST:
      return { dx: 1, dy: 0 };
    case Dir.SOUTH:
      return { dx: 0, dy: 1 };
    case Dir.WEST:
      return { dx: -1, dy: 0 };
  }
}

export function dirToIndex(dir: Dir): 0 | 1 | 2 | 3 {
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

export function indexToDir(idx: number): Dir {
  return CARDINAL_DIRS[((idx % 4) + 4) % 4];
}

export function rotateDir(dir: Dir, rot90: Rot90): Dir {
  return (((dir + rot90 * 4) % 16) as Dir);
}

export function oppositeDir(dir: Dir): Dir {
  return (((dir + 8) % 16) as Dir);
}

export function flipDirY(dir: Dir): Dir {
  if (dir === Dir.NORTH) return Dir.SOUTH;
  if (dir === Dir.SOUTH) return Dir.NORTH;
  return dir;
}

export function dirName(dir: Dir): string {
  switch (dir) {
    case Dir.NORTH:
      return 'N';
    case Dir.EAST:
      return 'E';
    case Dir.SOUTH:
      return 'S';
    case Dir.WEST:
      return 'W';
  }
}

export function edgeToInwardDir(edge: Edge): Dir {
  switch (edge) {
    case 'N':
      return Dir.SOUTH;
    case 'S':
      return Dir.NORTH;
    case 'W':
      return Dir.EAST;
    case 'E':
      return Dir.WEST;
  }
}

export function edgeToOutwardDir(edge: Edge): Dir {
  switch (edge) {
    case 'N':
      return Dir.NORTH;
    case 'S':
      return Dir.SOUTH;
    case 'W':
      return Dir.WEST;
    case 'E':
      return Dir.EAST;
  }
}

export function dirToEdge(dir: Dir): Edge {
  switch (dir) {
    case Dir.NORTH:
      return 'N';
    case Dir.EAST:
      return 'E';
    case Dir.SOUTH:
      return 'S';
    case Dir.WEST:
      return 'W';
  }
}

/**
 * In Factorio 2.0 blueprints, an inserter's `direction` points FROM its center
 * TOWARD its pickup tile. `pickupDir` is the direction from the inserter to the
 * tile it picks items up from.
 */
export function inserterDirectionFromPickupDir(pickupDir: Dir): Dir {
  return pickupDir;
}

/**
 * Computes pickup and drop tile offsets for an inserter given its Factorio
 * `direction` (facing pickup) and reach (1 for normal/fast/bulk, 2 for long).
 */
export function inserterReachTiles(
  tx: number,
  ty: number,
  direction: Dir,
  reach: 1 | 2,
): { pickupX: number; pickupY: number; dropX: number; dropY: number } {
  const { dx, dy } = dirDelta(direction);
  return {
    pickupX: tx + dx * reach,
    pickupY: ty + dy * reach,
    dropX: tx - dx * reach,
    dropY: ty - dy * reach,
  };
}
