import {
  BeltLaneFlowInfo,
  Dir,
  EntityInstance,
  StaNetReport,
} from '@factorio-eda/core';

export function laneUtilColor(u: number): string {
  if (u <= 0.001) return 'rgba(148, 163, 184, 0.16)';
  if (u > 1.0) return 'rgba(239, 68, 68, 0.62)';
  if (u > 0.8) return 'rgba(245, 158, 11, 0.52)';
  if (u > 0.4) return 'rgba(74, 222, 128, 0.42)';
  return 'rgba(56, 189, 248, 0.34)';
}

export function resolveEntityLaneUtils(
  e: EntityInstance,
  entityLanes: Record<string, BeltLaneFlowInfo> | undefined,
  staNetMap: Map<string, StaNetReport>,
): { leftUtil: number; rightUtil: number } | null {
  const info = entityLanes?.[e.id];
  if (info) {
    const halfCap = Math.max(0.01, info.capacityPerSec * 0.5);
    return {
      leftUtil: info.leftRatePerSec / halfCap,
      rightUtil: info.rightRatePerSec / halfCap,
    };
  }
  if (e.netId) {
    const net = staNetMap.get(e.netId);
    if (net) {
      const halfCap = Math.max(0.01, net.capacityPerSec * 0.5);
      const fallbackHalf = net.ratePerSec * 0.5;
      return {
        leftUtil: (net.leftRatePerSec ?? fallbackHalf) / halfCap,
        rightUtil: (net.rightRatePerSec ?? fallbackHalf) / halfCap,
      };
    }
  }
  return null;
}

/**
 * Render Left and Right half-belt utilization heatmaps according to belt direction.
 * Screen space has +x East and +y South:
 *  - EAST:  Left = top half,   Right = bottom half
 *  - WEST:  Left = bottom half, Right = top half
 *  - SOUTH: Left = right half,  Right = left half
 *  - NORTH: Left = left half,   Right = right half
 */
export function drawBeltLaneHeatmap(
  ctx: CanvasRenderingContext2D,
  ex: number,
  ey: number,
  s: number,
  direction: Dir,
  leftUtil: number,
  rightUtil: number,
  pad = 0,
): void {
  const ix = ex + pad;
  const iy = ey + pad;
  const is = Math.max(1, s - pad * 2);
  const half = is / 2;

  let lx = ix;
  let ly = iy;
  let lw = is;
  let lh = is;
  let rx = ix;
  let ry = iy;
  let rw = is;
  let rh = is;

  if (direction === Dir.EAST) {
    lh = half;
    ry = iy + half;
    rh = half;
  } else if (direction === Dir.WEST) {
    ly = iy + half;
    lh = half;
    rh = half;
  } else if (direction === Dir.SOUTH) {
    lx = ix + half;
    lw = half;
    rw = half;
  } else {
    // Dir.NORTH (and any horizontal fallback)
    lw = half;
    rx = ix + half;
    rw = half;
  }

  ctx.fillStyle = laneUtilColor(leftUtil);
  ctx.fillRect(lx, ly, lw, lh);
  ctx.fillStyle = laneUtilColor(rightUtil);
  ctx.fillRect(rx, ry, rw, rh);

  if (s >= 10) {
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (direction === Dir.EAST || direction === Dir.WEST) {
      ctx.moveTo(ix, iy + half);
      ctx.lineTo(ix + is, iy + half);
    } else {
      ctx.moveTo(ix + half, iy);
      ctx.lineTo(ix + half, iy + is);
    }
    ctx.stroke();
  }
}
