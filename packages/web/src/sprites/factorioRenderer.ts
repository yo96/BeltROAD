import {
  BELT_SPECS,
  BeltLaneFlowInfo,
  BeltTier,
  Dir,
  EntityInstance,
  FloorplanResult,
  INSERTER_BY_ENTITY_NAME,
  PIPE_SPEC,
  POLE_BY_ENTITY_NAME,
  QUALITY_SPECS,
  StaNetReport,
  beltTierFromEntityName,
  dirDelta,
  getItemMeta,
  isMachineName,
  isPipeName,
  isPipeUndergroundName,
  isSplitterName,
  isUndergroundName,
  oppositeDir,
} from '@factorio-eda/core';
import {
  drawCroppedIcon,
  getIcon,
  getLocalEntitySprite,
} from './factorioAssets';
import { drawSmartPinLabels } from '../components/pinLabels';
import {
  drawBeltLaneHeatmap,
  laneUtilColor,
  resolveEntityLaneUtils,
} from '../components/laneHeatmap';

export interface FactorioRenderLayerOpts {
  macros: boolean;
  belts: boolean;
  undergrounds: boolean;
  powerGrid: boolean;
  powerCoverage: boolean;
  heatmap: boolean;
  pinLabels: boolean;
  altMode: boolean;
}

const BELT_CURVE_ROW: Record<string, number> = {
  [`${Dir.EAST}->${Dir.NORTH}`]: 4,
  [`${Dir.NORTH}->${Dir.EAST}`]: 5,
  [`${Dir.WEST}->${Dir.NORTH}`]: 6,
  [`${Dir.NORTH}->${Dir.WEST}`]: 7,
  [`${Dir.SOUTH}->${Dir.EAST}`]: 8,
  [`${Dir.EAST}->${Dir.SOUTH}`]: 9,
  [`${Dir.SOUTH}->${Dir.WEST}`]: 10,
  [`${Dir.WEST}->${Dir.SOUTH}`]: 11,
};

function straightBeltRow(dir: Dir): number {
  switch (dir) {
    case Dir.EAST:
      return 0;
    case Dir.WEST:
      return 1;
    case Dir.NORTH:
      return 2;
    case Dir.SOUTH:
      return 3;
  }
}

export interface BeltShape {
  curved: boolean;
  inDir: Dir; // traveling direction entering the tile
  outDir: Dir; // traveling direction exiting the tile
  sheetRow: number;
}

function buildIncomingMap(entities: EntityInstance[]): Map<string, Dir[]> {
  const incoming = new Map<string, Dir[]>();
  const addFeed = (tx: number, ty: number, dir: Dir) => {
    const key = `${tx},${ty}`;
    let arr = incoming.get(key);
    if (!arr) {
      arr = [];
      incoming.set(key, arr);
    }
    arr.push(dir);
  };

  for (const e of entities) {
    const isBelt = beltTierFromEntityName(e.name) !== null;
    if (!isBelt) continue;
    // Underground inputs go below ground; they don't feed adjacent surface tiles ahead
    if (isUndergroundName(e.name) && e.type === 'input') continue;
    const { dx, dy } = dirDelta(e.direction);
    for (let ox = 0; ox < e.w; ox++) {
      for (let oy = 0; oy < e.h; oy++) {
        addFeed(e.tx + ox + dx, e.ty + oy + dy, e.direction);
      }
    }
  }
  return incoming;
}

export function classifyBeltShape(
  e: EntityInstance,
  incoming: Map<string, Dir[]>,
): BeltShape {
  const outDir = e.direction;
  if (e.intentionalSideLoad) {
    return { curved: false, inDir: outDir, outDir, sheetRow: straightBeltRow(outDir) };
  }
  const feeds = incoming.get(`${e.tx},${e.ty}`) ?? [];
  if (feeds.includes(outDir)) {
    return { curved: false, inDir: outDir, outDir, sheetRow: straightBeltRow(outDir) };
  }
  const opp = (((outDir + 8) % 16) as Dir);
  const sideFeeds = feeds.filter((d) => d !== outDir && d !== opp);
  const uniqueSides = Array.from(new Set(sideFeeds));
  if (uniqueSides.length === 1) {
    const inDir = uniqueSides[0];
    const row = BELT_CURVE_ROW[`${inDir}->${outDir}`];
    if (row !== undefined) {
      return { curved: true, inDir, outDir, sheetRow: row };
    }
  }
  return { curved: false, inDir: outDir, outDir, sheetRow: straightBeltRow(outDir) };
}

function tierColors(tier: BeltTier): {
  rail: string;
  trim: string;
  chevron: string;
  bed: string;
} {
  if (tier === 'turbo') {
    return {
      rail: '#14532d',
      trim: '#22c55e',
      chevron: '#86efac',
      bed: '#1e2b22',
    };
  }
  if (tier === 'red') {
    return {
      rail: '#7c2d12',
      trim: '#dc2626',
      chevron: '#fca5a5',
      bed: '#2b2628',
    };
  }
  if (tier === 'blue') {
    return {
      rail: '#1e3a5f',
      trim: '#38bdf8',
      chevron: '#bae6fd',
      bed: '#232933',
    };
  }
  return {
    rail: '#713f12',
    trim: '#eab308',
    chevron: '#fef08a',
    bed: '#2a2822',
  };
}

function drawChevronArrow(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  dir: Dir,
  size: number,
  color: string,
  lineWidth: number,
): void {
  const { dx, dy } = dirDelta(dir);
  const px = -dy;
  const py = dx;
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(cx - dx * size * 0.35 + px * size * 0.55, cy - dy * size * 0.35 + py * size * 0.55);
  ctx.lineTo(cx + dx * size * 0.45, cy + dy * size * 0.45);
  ctx.lineTo(cx - dx * size * 0.35 - px * size * 0.55, cy - dy * size * 0.35 - py * size * 0.55);
  ctx.stroke();
}

function drawBeltItemBadge(
  ctx: CanvasRenderingContext2D,
  item: string,
  cx: number,
  cy: number,
  radius: number,
): void {
  const img = getIcon(item);
  if (img) {
    drawCroppedIcon(ctx, img, cx - radius, cy - radius, radius * 2, radius * 2);
    return;
  }
  const meta = getItemMeta(item);
  ctx.fillStyle = meta.color;
  ctx.beginPath();
  ctx.arc(cx, cy, Math.max(1.5, radius * 0.65), 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.lineWidth = 0.8;
  ctx.stroke();
}

function drawSurfaceBelt(
  ctx: CanvasRenderingContext2D,
  e: EntityInstance,
  shape: BeltShape,
  ox: number,
  oy: number,
  s: number,
  tier: BeltTier,
  altMode: boolean,
): void {
  const ex = ox + e.tx * s;
  const ey = oy + e.ty * s;
  const localSheet = getLocalEntitySprite(e.name);

  if (localSheet && localSheet.naturalWidth > 0 && localSheet.naturalHeight > 0) {
    // Factorio transport-belt sheets are grid of 128x128 (direction_count=20 rows, scale=0.5)
    const rowH = Math.round(localSheet.naturalHeight / 20);
    const colW = rowH;
    const rowIdx = Math.min(19, Math.max(0, shape.sheetRow));
    ctx.drawImage(
      localSheet,
      0,
      rowIdx * rowH,
      colW,
      rowH,
      ex - s * 0.5,
      ey - s * 0.5,
      s * 2,
      s * 2,
    );
  } else {
    const c = tierColors(tier);
    const pad = s * 0.09;

    if (shape.curved) {
      const inVec = dirDelta(shape.inDir);
      const outVec = dirDelta(shape.outDir);
      // Enter at center of incoming edge, exit at center of outgoing edge
      const p0x = ex + s * (0.5 - 0.5 * inVec.dx);
      const p0y = ey + s * (0.5 - 0.5 * inVec.dy);
      const p2x = ex + s * (0.5 + 0.5 * outVec.dx);
      const p2y = ey + s * (0.5 + 0.5 * outVec.dy);
      const cx = ex + s * 0.5;
      const cy = ey + s * 0.5;

      // Outer guardrail band
      ctx.save();
      ctx.lineCap = 'butt';
      ctx.strokeStyle = c.rail;
      ctx.lineWidth = s * 0.82;
      ctx.beginPath();
      ctx.moveTo(p0x, p0y);
      ctx.quadraticCurveTo(cx, cy, p2x, p2y);
      ctx.stroke();

      // Track trim
      ctx.strokeStyle = c.trim;
      ctx.lineWidth = s * 0.72;
      ctx.beginPath();
      ctx.moveTo(p0x, p0y);
      ctx.quadraticCurveTo(cx, cy, p2x, p2y);
      ctx.stroke();

      // Dark belt rubber bed
      ctx.strokeStyle = c.bed;
      ctx.lineWidth = s * 0.58;
      ctx.beginPath();
      ctx.moveTo(p0x, p0y);
      ctx.quadraticCurveTo(cx, cy, p2x, p2y);
      ctx.stroke();

      // Center curved rib
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.lineWidth = Math.max(1, s * 0.05);
      ctx.beginPath();
      ctx.moveTo(p0x, p0y);
      ctx.quadraticCurveTo(cx, cy, p2x, p2y);
      ctx.stroke();
      ctx.restore();

      const midX = 0.25 * p0x + 0.5 * cx + 0.25 * p2x;
      const midY = 0.25 * p0y + 0.5 * cy + 0.25 * p2y;
      drawChevronArrow(
        ctx,
        midX,
        midY,
        shape.outDir,
        s * 0.28,
        c.chevron,
        Math.max(1.2, s * 0.1),
      );
    } else {
      const horiz = shape.outDir === Dir.EAST || shape.outDir === Dir.WEST;
      const bx = horiz ? ex : ex + pad;
      const by = horiz ? ey + pad : ey;
      const bw = horiz ? s : s - pad * 2;
      const bh = horiz ? s - pad * 2 : s;

      // Dark rubber track
      ctx.fillStyle = c.bed;
      ctx.fillRect(bx, by, bw, bh);

      // Steel / painted side rails
      const railTh = Math.max(1.2, s * 0.1);
      ctx.fillStyle = c.trim;
      if (horiz) {
        ctx.fillRect(bx, by, bw, railTh);
        ctx.fillRect(bx, by + bh - railTh, bw, railTh);
      } else {
        ctx.fillRect(bx, by, railTh, bh);
        ctx.fillRect(bx + bw - railTh, by, railTh, bh);
      }

      // Subtle track ribs
      if (s >= 10) {
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        if (horiz) {
          ctx.fillRect(bx + s * 0.22, by + railTh, Math.max(1, s * 0.06), bh - railTh * 2);
          ctx.fillRect(bx + s * 0.72, by + railTh, Math.max(1, s * 0.06), bh - railTh * 2);
        } else {
          ctx.fillRect(bx + railTh, by + s * 0.22, bw - railTh * 2, Math.max(1, s * 0.06));
          ctx.fillRect(bx + railTh, by + s * 0.72, bw - railTh * 2, Math.max(1, s * 0.06));
        }
      }

      // Directional chevrons
      const chevLen = s * 0.24;
      const lw = Math.max(1.1, s * 0.09);
      const cx = ex + s * 0.5;
      const cy = ey + s * 0.5;
      drawChevronArrow(ctx, cx, cy, shape.outDir, chevLen, c.chevron, lw);
    }
  }

  // Real Factorio item icons flowing along belt lanes
  if (altMode && s >= 9) {
    const cx = ex + s * 0.5;
    const cy = ey + s * 0.5;
    const { dx, dy } = dirDelta(shape.outDir);
    // Factorio left lane relative to belt forward vector
    const leftX = dy;
    const leftY = -dx;
    const itemR = Math.min(s * 0.21, 9);

    if (e.laneItems && e.laneItems.length === 2) {
      drawBeltItemBadge(
        ctx,
        e.laneItems[0],
        cx + leftX * s * 0.2,
        cy + leftY * s * 0.2,
        itemR,
      );
      drawBeltItemBadge(
        ctx,
        e.laneItems[1],
        cx - leftX * s * 0.2,
        cy - leftY * s * 0.2,
        itemR,
      );
    } else if (e.item) {
      if (s >= 14) {
        drawBeltItemBadge(
          ctx,
          e.item,
          cx + leftX * s * 0.19 - dx * s * 0.14,
          cy + leftY * s * 0.19 - dy * s * 0.14,
          itemR * 0.9,
        );
        drawBeltItemBadge(
          ctx,
          e.item,
          cx - leftX * s * 0.19 + dx * s * 0.14,
          cy - leftY * s * 0.19 + dy * s * 0.14,
          itemR * 0.9,
        );
      } else {
        drawBeltItemBadge(ctx, e.item, cx, cy, itemR * 1.15);
      }
    }
  }
}

function drawUndergroundHood(
  ctx: CanvasRenderingContext2D,
  e: EntityInstance,
  ox: number,
  oy: number,
  s: number,
  tier: BeltTier,
): void {
  const ex = ox + e.tx * s;
  const ey = oy + e.ty * s;
  const c = tierColors(tier);
  const { dx, dy } = dirDelta(e.direction);
  const pad = s * 0.08;

  // Underlying short belt bed
  ctx.fillStyle = c.bed;
  ctx.fillRect(ex + pad, ey + pad, s - pad * 2, s - pad * 2);

  // Dark underground tunnel mouth on the open belt side
  const isIn = e.type === 'input';
  const hoodShift = isIn ? 1 : -1;
  ctx.fillStyle = '#0f1216';
  ctx.fillRect(ex + s * 0.16, ey + s * 0.16, s * 0.68, s * 0.68);

  // Armored sloped metallic bunker hood
  const hx = ex + s * 0.1 + hoodShift * dx * s * 0.14;
  const hy = ey + s * 0.1 + hoodShift * dy * s * 0.14;
  const hw = s * 0.8 - Math.abs(dx) * s * 0.18;
  const hh = s * 0.8 - Math.abs(dy) * s * 0.18;

  ctx.fillStyle = '#525864';
  ctx.fillRect(hx, hy, hw, hh);
  ctx.strokeStyle = c.trim;
  ctx.lineWidth = Math.max(1.3, s * 0.09);
  ctx.strokeRect(hx, hy, hw, hh);

  // Yellow/red/blue caution hazard stripe + directional arrow
  drawChevronArrow(
    ctx,
    ex + s * 0.5,
    ey + s * 0.5,
    e.direction,
    s * 0.28,
    isIn ? c.chevron : '#f8fafc',
    Math.max(1.3, s * 0.11),
  );
}

function drawSplitterEntity(
  ctx: CanvasRenderingContext2D,
  e: EntityInstance,
  ox: number,
  oy: number,
  s: number,
  tier: BeltTier,
): void {
  const ex = ox + e.tx * s;
  const ey = oy + e.ty * s;
  const ew = e.w * s;
  const eh = e.h * s;
  const c = tierColors(tier);
  const isEW = e.direction === Dir.EAST || e.direction === Dir.WEST;
  const pad = s * 0.07;

  // Belt bed underneath
  ctx.fillStyle = c.bed;
  ctx.fillRect(ex + pad, ey + pad, ew - pad * 2, eh - pad * 2);
  ctx.strokeStyle = c.rail;
  ctx.lineWidth = Math.max(1, s * 0.08);
  ctx.strokeRect(ex + pad, ey + pad, ew - pad * 2, eh - pad * 2);

  // Central mechanical bridge housing spanning both lanes
  ctx.fillStyle = '#47505c';
  if (isEW) {
    ctx.fillRect(ex + ew * 0.2, ey + pad * 0.5, ew * 0.6, eh - pad);
    ctx.strokeStyle = c.trim;
    ctx.lineWidth = Math.max(1.4, s * 0.09);
    ctx.strokeRect(ex + ew * 0.2, ey + pad * 0.5, ew * 0.6, eh - pad);
  } else {
    ctx.fillRect(ex + pad * 0.5, ey + eh * 0.2, ew - pad, eh * 0.6);
    ctx.strokeStyle = c.trim;
    ctx.lineWidth = Math.max(1.4, s * 0.09);
    ctx.strokeRect(ex + pad * 0.5, ey + eh * 0.2, ew - pad, eh * 0.6);
  }

  // Dual lane directional chevrons
  for (const frac of [0.25, 0.75]) {
    const cx = isEW ? ex + ew * 0.5 : ex + ew * frac;
    const cy = isEW ? ey + eh * frac : ey + eh * 0.5;
    drawChevronArrow(
      ctx,
      cx,
      cy,
      e.direction,
      s * 0.26,
      c.chevron,
      Math.max(1.2, s * 0.1),
    );
  }
}

function drawMachineEntity(
  ctx: CanvasRenderingContext2D,
  e: EntityInstance,
  ox: number,
  oy: number,
  s: number,
  altMode: boolean,
  heatmapColor: string | null,
): void {
  const ex = ox + e.tx * s;
  const ey = oy + e.ty * s;
  const ew = e.w * s;
  const eh = e.h * s;
  const cx = ex + ew / 2;
  const cy = ey + eh / 2;

  // Ground shadow
  ctx.fillStyle = 'rgba(0,0,0,0.38)';
  ctx.fillRect(ex + s * 0.14, ey + s * 0.18, ew - s * 0.08, eh - s * 0.08);

  const localSprite = getLocalEntitySprite(e.name);
  if (localSprite && localSprite.naturalWidth > 0 && localSprite.naturalHeight > 0) {
    // Local Factorio 2.0 "-base.png" or single furnace image vs legacy 8x4 sheet
    const isGridSheet =
      e.name.startsWith('assembling-machine-') && localSprite.naturalWidth > 700;
    const sw = isGridSheet ? Math.round(localSprite.naturalWidth / 8) : localSprite.naturalWidth;
    const sh = isGridSheet ? Math.round(localSprite.naturalHeight / 4) : localSprite.naturalHeight;
    ctx.drawImage(
      localSprite,
      0,
      0,
      sw,
      sh,
      ex - s * 0.15,
      ey - s * 0.2,
      ew + s * 0.3,
      eh + s * 0.35,
    );
  } else {
    const isFurnace = e.name === 'electric-furnace';
    const isFoundry = e.name === 'foundry';
    const isEmPlant = e.name === 'electromagnetic-plant';
    const isCryo = e.name === 'cryogenic-plant';
    const isChem = e.name === 'chemical-plant';
    const margin = Math.max(1.5, s * 0.08);
    const bx = ex + margin;
    const by = ey + margin;
    const bw = ew - margin * 2;
    const bh = eh - margin * 2;

    if (isChem) {
      ctx.fillStyle = '#0f4c5c';
      ctx.fillRect(bx, by, bw, bh);
      ctx.strokeStyle = '#2dd4bf';
      ctx.lineWidth = Math.max(1.4, s * 0.08);
      ctx.strokeRect(bx, by, bw, bh);

      ctx.fillStyle = '#082f3a';
      ctx.fillRect(bx + bw * 0.14, by + bh * 0.14, bw * 0.72, bh * 0.72);
      // Twin chemical distillation domes
      ctx.fillStyle = '#14b8a6';
      ctx.beginPath();
      ctx.arc(cx - bw * 0.18, cy, bw * 0.16, 0, Math.PI * 2);
      ctx.arc(cx + bw * 0.18, cy, bw * 0.16, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#99f6e4';
      ctx.lineWidth = Math.max(1, s * 0.05);
      ctx.stroke();
    } else if (isFurnace || isFoundry) {
      // Heavy steel Electric Furnace or Space Age molten Foundry
      ctx.fillStyle = isFoundry ? '#5c2410' : '#3f454f';
      ctx.fillRect(bx, by, bw, bh);
      ctx.strokeStyle = isFoundry ? '#fb923c' : '#737d8c';
      ctx.lineWidth = Math.max(1.4, s * 0.08);
      ctx.strokeRect(bx, by, bw, bh);

      ctx.fillStyle = isFoundry ? '#2b1309' : '#242931';
      ctx.fillRect(bx + bw * 0.14, by + bh * 0.14, bw * 0.72, bh * 0.72);

      const glow = ctx.createRadialGradient(cx, cy, bw * 0.04, cx, cy, bw * 0.32);
      glow.addColorStop(0, '#fde047');
      glow.addColorStop(0.45, '#f97316');
      glow.addColorStop(1, 'rgba(234,88,12,0.12)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(cx, cy, bw * (isFoundry ? 0.32 : 0.28), 0, Math.PI * 2);
      ctx.fill();

      if (s >= 10) {
        ctx.fillStyle = isFoundry ? '#9a3412' : '#64748b';
        ctx.fillRect(bx + bw * 0.06, by + bh * 0.2, bw * 0.07, bh * 0.6);
        ctx.fillRect(bx + bw * 0.87, by + bh * 0.2, bw * 0.07, bh * 0.6);
      }
    } else if (isEmPlant) {
      ctx.fillStyle = '#3b1c6e';
      ctx.fillRect(bx, by, bw, bh);
      ctx.strokeStyle = '#e879f9';
      ctx.lineWidth = Math.max(1.4, s * 0.08);
      ctx.strokeRect(bx, by, bw, bh);

      ctx.fillStyle = '#1f103d';
      ctx.beginPath();
      ctx.arc(cx, cy, bw * 0.36, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#c084fc';
      ctx.lineWidth = Math.max(1.2, s * 0.07);
      ctx.stroke();

      const glow = ctx.createRadialGradient(cx, cy, bw * 0.04, cx, cy, bw * 0.28);
      glow.addColorStop(0, '#f5d0fe');
      glow.addColorStop(0.6, '#d946ef');
      glow.addColorStop(1, 'rgba(192,132,252,0.1)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(cx, cy, bw * 0.22, 0, Math.PI * 2);
      ctx.fill();
    } else if (isCryo) {
      ctx.fillStyle = '#164e63';
      ctx.fillRect(bx, by, bw, bh);
      ctx.strokeStyle = '#22d3ee';
      ctx.lineWidth = Math.max(1.4, s * 0.08);
      ctx.strokeRect(bx, by, bw, bh);

      ctx.fillStyle = '#0c2d3a';
      ctx.fillRect(bx + bw * 0.14, by + bh * 0.14, bw * 0.72, bh * 0.72);
      ctx.fillStyle = '#67e8f9';
      ctx.beginPath();
      ctx.arc(cx - bw * 0.16, cy, bw * 0.14, 0, Math.PI * 2);
      ctx.arc(cx + bw * 0.16, cy, bw * 0.14, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // Factorio Assembling Machine tier body colors
      const tier = e.name.endsWith('1') ? 1 : e.name.endsWith('3') ? 3 : 2;
      const shell = tier === 1 ? '#6e6a61' : tier === 2 ? '#34638c' : '#858e38';
      const trim = tier === 1 ? '#a8a29e' : tier === 2 ? '#60a5fa' : '#d9e048';
      const inner = tier === 1 ? '#2e2d2a' : tier === 2 ? '#1e3045' : '#2f341b';

      ctx.fillStyle = shell;
      ctx.fillRect(bx, by, bw, bh);
      ctx.strokeStyle = trim;
      ctx.lineWidth = Math.max(1.4, s * 0.08);
      ctx.strokeRect(bx, by, bw, bh);

      // Corner structural bolts
      const boltR = Math.max(1.2, bw * 0.06);
      ctx.fillStyle = '#94a3b8';
      for (const [oxf, oyf] of [
        [0.1, 0.1],
        [0.9, 0.1],
        [0.1, 0.9],
        [0.9, 0.9],
      ]) {
        ctx.fillRect(bx + bw * oxf - boltR / 2, by + bh * oyf - boltR / 2, boltR, boltR);
      }

      // Inner dark mechanical housing + rotary gear
      ctx.fillStyle = inner;
      ctx.beginPath();
      ctx.arc(cx, cy, bw * 0.34, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = trim;
      ctx.lineWidth = Math.max(1.2, s * 0.07);
      ctx.stroke();

      // Mechanical press teeth
      if (s >= 10) {
        ctx.strokeStyle = 'rgba(226, 232, 240, 0.35)';
        ctx.lineWidth = Math.max(1.5, s * 0.09);
        for (let k = 0; k < 4; k++) {
          const ang = (k * Math.PI) / 4;
          ctx.beginPath();
          ctx.moveTo(cx + Math.cos(ang) * bw * 0.29, cy + Math.sin(ang) * bh * 0.29);
          ctx.lineTo(cx - Math.cos(ang) * bw * 0.29, cy - Math.sin(ang) * bh * 0.29);
          ctx.stroke();
        }
      }
    }

    // Green Factorio status light top-left
    if (s >= 9) {
      ctx.fillStyle = '#4ade80';
      ctx.beginPath();
      ctx.arc(bx + bw * 0.16, by + bh * 0.16, Math.max(1.8, s * 0.09), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Quality tier dots (top-right of machine, clear of status light & centered bottom module icons)
  if (e.quality && e.quality !== 'normal' && s >= 7) {
    const qSpec = QUALITY_SPECS[e.quality];
    const pip = Math.max(2.5, s * 0.2);
    for (let qi = 0; qi < qSpec.level; qi++) {
      ctx.fillStyle = qSpec.color;
      ctx.fillRect(ex + ew - 3 - pip - qi * (pip + 1.5), ey + 3, pip, pip);
    }
  }

  if (heatmapColor) {
    ctx.fillStyle = heatmapColor;
    ctx.fillRect(ex + 1, ey + 1, ew - 2, eh - 2);
  }

  // Factorio Alt-Mode recipe badge centered on machine
  if (altMode && e.item && s >= 7) {
    const iconSize = Math.min(ew * 0.56, Math.max(14, s * 1.45));
    const badgeR = iconSize * 0.56;
    ctx.fillStyle = 'rgba(15, 20, 26, 0.72)';
    ctx.beginPath();
    ctx.arc(cx, cy, badgeR, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
    ctx.lineWidth = 1;
    ctx.stroke();

    const img = getIcon(e.item);
    if (img) {
      drawCroppedIcon(ctx, img, cx - iconSize / 2, cy - iconSize / 2, iconSize, iconSize);
    } else {
      const meta = getItemMeta(e.item);
      ctx.fillStyle = meta.color;
      ctx.beginPath();
      ctx.arc(cx, cy, iconSize * 0.35, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Installed modules at bottom edge
  if (altMode && e.items && e.items.length > 0 && s >= 9) {
    const slotSize = Math.max(5, Math.min(12, s * 0.42));
    const totalW = e.items.length * (slotSize + 2) - 2;
    const startX = cx - totalW / 2;
    const modY = ey + eh - slotSize - Math.max(2, s * 0.12);

    e.items.forEach((mod, idx) => {
      const mx = startX + idx * (slotSize + 2);
      ctx.fillStyle = 'rgba(10, 14, 20, 0.85)';
      ctx.fillRect(mx - 1, modY - 1, slotSize + 2, slotSize + 2);
      const img = getIcon(mod);
      if (img && s >= 12) {
        drawCroppedIcon(ctx, img, mx, modY, slotSize, slotSize);
      } else {
        ctx.fillStyle = mod.startsWith('speed')
          ? '#38bdf8'
          : mod.startsWith('productivity')
            ? '#ef4444'
            : '#22c55e';
        ctx.fillRect(mx, modY, slotSize, slotSize);
      }
    });
  }
}

function drawBeaconEntity(
  ctx: CanvasRenderingContext2D,
  e: EntityInstance,
  ox: number,
  oy: number,
  s: number,
  altMode: boolean,
): void {
  const ex = ox + e.tx * s;
  const ey = oy + e.ty * s;
  const ew = e.w * s;
  const eh = e.h * s;
  const cx = ex + ew / 2;
  const cy = ey + eh / 2;
  const margin = Math.max(1.5, s * 0.08);
  const bx = ex + margin;
  const by = ey + margin;
  const bw = ew - margin * 2;
  const bh = eh - margin * 2;

  ctx.fillStyle = 'rgba(0,0,0,0.36)';
  ctx.fillRect(ex + s * 0.12, ey + s * 0.16, ew - s * 0.06, eh - s * 0.06);

  ctx.fillStyle = '#153243';
  ctx.fillRect(bx, by, bw, bh);
  ctx.strokeStyle = '#22d3ee';
  ctx.lineWidth = Math.max(1.4, s * 0.08);
  ctx.strokeRect(bx, by, bw, bh);

  // Inner magnetic emitter rings
  ctx.fillStyle = '#0c2330';
  ctx.beginPath();
  ctx.arc(cx, cy, bw * 0.34, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#67e8f9';
  ctx.lineWidth = Math.max(1.1, s * 0.06);
  ctx.stroke();

  const glow = ctx.createRadialGradient(cx, cy, bw * 0.03, cx, cy, bw * 0.24);
  glow.addColorStop(0, '#cffafe');
  glow.addColorStop(0.55, '#06b6d4');
  glow.addColorStop(1, 'rgba(6,182,212,0.1)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy, bw * 0.22, 0, Math.PI * 2);
  ctx.fill();

  if (e.quality && e.quality !== 'normal' && s >= 7) {
    const qSpec = QUALITY_SPECS[e.quality];
    const pip = Math.max(2.5, s * 0.2);
    for (let qi = 0; qi < qSpec.level; qi++) {
      ctx.fillStyle = qSpec.color;
      ctx.fillRect(ex + ew - 3 - pip - qi * (pip + 1.5), ey + 3, pip, pip);
    }
  }

  if (altMode && e.items && e.items.length > 0 && s >= 9) {
    const slotSize = Math.max(5, Math.min(12, s * 0.42));
    const totalW = e.items.length * (slotSize + 2) - 2;
    const startX = cx - totalW / 2;
    const modY = ey + eh - slotSize - Math.max(2, s * 0.12);
    e.items.forEach((mod, idx) => {
      const mx = startX + idx * (slotSize + 2);
      ctx.fillStyle = 'rgba(10, 14, 20, 0.85)';
      ctx.fillRect(mx - 1, modY - 1, slotSize + 2, slotSize + 2);
      const img = getIcon(mod);
      if (img && s >= 12) {
        drawCroppedIcon(ctx, img, mx, modY, slotSize, slotSize);
      } else {
        ctx.fillStyle = mod.startsWith('speed')
          ? '#38bdf8'
          : mod.startsWith('efficiency')
            ? '#22c55e'
            : '#ef4444';
        ctx.fillRect(mx, modY, slotSize, slotSize);
      }
    });
  }
}

function drawInserterEntity(
  ctx: CanvasRenderingContext2D,
  e: EntityInstance,
  ox: number,
  oy: number,
  s: number,
): void {
  const ins = INSERTER_BY_ENTITY_NAME[e.name];
  if (!ins) return;
  const cx = ox + (e.tx + 0.5) * s;
  const cy = oy + (e.ty + 0.5) * s;
  const { dx, dy } = dirDelta(e.direction);

  // Dark metallic mounting plate
  const pad = s * 0.24;
  ctx.fillStyle = '#2d333b';
  ctx.fillRect(cx - pad, cy - pad, pad * 2, pad * 2);
  ctx.strokeStyle = '#64748b';
  ctx.lineWidth = Math.max(0.8, s * 0.05);
  ctx.strokeRect(cx - pad, cy - pad, pad * 2, pad * 2);

  // Extended mechanical arm reaching from pickup (+d) across base to drop (-d)
  const armLen = ins.reach === 2 ? s * 0.52 : s * 0.44;
  const pX = cx + dx * armLen;
  const pY = cy + dy * armLen;
  const dX = cx - dx * armLen;
  const dY = cy - dy * armLen;

  // Arm shadow
  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  ctx.lineWidth = Math.max(2.0, s * 0.17);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(pX + 1.5, pY + 1.5);
  ctx.lineTo(dX + 1.5, dY + 1.5);
  ctx.stroke();

  // Painted Factorio inserter arm
  ctx.strokeStyle = ins.color;
  ctx.lineWidth = Math.max(1.6, s * 0.14);
  ctx.beginPath();
  ctx.moveTo(pX, pY);
  ctx.lineTo(dX, dY);
  ctx.stroke();

  // Central pivot turret collar
  ctx.fillStyle = '#475569';
  ctx.beginPath();
  ctx.arc(cx, cy, Math.max(1.8, s * 0.14), 0, Math.PI * 2);
  ctx.fill();

  // Pickup claw (open U-fork facing +d) & drop head indicator on -d
  ctx.fillStyle = '#e2e8f0';
  ctx.beginPath();
  ctx.arc(pX, pY, Math.max(1.5, s * 0.09), 0, Math.PI * 2);
  ctx.fill();

  // Bright drop pincer triangle on drop side (-d)
  const px = -dy;
  const py = dx;
  ctx.fillStyle = ins.color;
  ctx.beginPath();
  ctx.moveTo(dX - dx * s * 0.1, dY - dy * s * 0.1);
  ctx.lineTo(dX + px * s * 0.11 + dx * s * 0.08, dY + py * s * 0.11 + dy * s * 0.08);
  ctx.lineTo(dX - px * s * 0.11 + dx * s * 0.08, dY - py * s * 0.11 + dy * s * 0.08);
  ctx.closePath();
  ctx.fill();
}

function drawPoleEntity(
  ctx: CanvasRenderingContext2D,
  e: EntityInstance,
  ox: number,
  oy: number,
  s: number,
): void {
  const ex = ox + e.tx * s;
  const ey = oy + e.ty * s;
  const ew = e.w * s;
  const eh = e.h * s;
  const cx = ex + ew / 2;
  const cy = ey + eh / 2;

  const localPole = getLocalEntitySprite(e.name);
  if (localPole && localPole.naturalWidth > 0 && localPole.naturalHeight > 0) {
    // Factorio pole sprites have 4 directions across sheet width
    const fw = Math.round(localPole.naturalWidth / 4);
    const fh = localPole.naturalHeight;
    const aspect = fw / Math.max(1, fh);
    const drawW = e.name === 'substation' ? ew * 1.15 : ew * 1.1;
    const drawH = drawW / Math.max(0.2, aspect);
    ctx.drawImage(
      localPole,
      0,
      0,
      fw,
      fh,
      cx - drawW * 0.48,
      ey + eh - drawH * 0.92,
      drawW,
      drawH,
    );
    return;
  }

  // Diagonal ground shadow extending SE
  ctx.strokeStyle = 'rgba(0,0,0,0.4)';
  ctx.lineWidth = Math.max(2, s * 0.16);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + ew * 0.65, cy + eh * 0.4);
  ctx.stroke();

  if (e.name === 'substation') {
    // 2x2 Industrial Transformer Substation
    const m = s * 0.12;
    ctx.fillStyle = '#334155';
    ctx.fillRect(ex + m, ey + m, ew - m * 2, eh - m * 2);
    ctx.strokeStyle = '#60a5fa';
    ctx.lineWidth = Math.max(1.5, s * 0.08);
    ctx.strokeRect(ex + m, ey + m, ew - m * 2, eh - m * 2);

    // Transformer coils + copper top terminals
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(ex + ew * 0.22, ey + eh * 0.25, ew * 0.56, eh * 0.5);
    ctx.fillStyle = '#38bdf8';
    ctx.beginPath();
    ctx.arc(cx, cy - eh * 0.12, Math.max(2.5, s * 0.22), 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#d97706';
    for (const bx of [cx - ew * 0.22, cx + ew * 0.22]) {
      ctx.beginPath();
      ctx.arc(bx, cy + eh * 0.14, Math.max(2, s * 0.14), 0, Math.PI * 2);
      ctx.fill();
    }
    return;
  }

  if (e.name === 'small-electric-pole') {
    // Wooden base + dark timber top + crossarm insulators
    ctx.fillStyle = '#78350f';
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(2.5, s * 0.24), 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#92400e';
    ctx.lineWidth = Math.max(1.5, s * 0.11);
    ctx.beginPath();
    ctx.moveTo(cx - s * 0.34, cy - s * 0.12);
    ctx.lineTo(cx + s * 0.34, cy - s * 0.12);
    ctx.stroke();
    ctx.fillStyle = '#38bdf8';
    ctx.beginPath();
    ctx.arc(cx - s * 0.28, cy - s * 0.12, Math.max(1.2, s * 0.08), 0, Math.PI * 2);
    ctx.arc(cx + s * 0.28, cy - s * 0.12, Math.max(1.2, s * 0.08), 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  // Medium steel lattice pylon
  ctx.fillStyle = '#475569';
  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = 1.3;
  ctx.fillRect(cx - s * 0.24, cy - s * 0.24, s * 0.48, s * 0.48);
  ctx.strokeRect(cx - s * 0.24, cy - s * 0.24, s * 0.48, s * 0.48);

  // Steel crossarm & turquoise ceramic insulators
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = Math.max(1.5, s * 0.09);
  ctx.beginPath();
  ctx.moveTo(cx - s * 0.36, cy - s * 0.12);
  ctx.lineTo(cx + s * 0.36, cy - s * 0.12);
  ctx.stroke();
  ctx.fillStyle = '#38bdf8';
  ctx.beginPath();
  ctx.arc(cx - s * 0.3, cy - s * 0.12, Math.max(1.5, s * 0.09), 0, Math.PI * 2);
  ctx.arc(cx + s * 0.3, cy - s * 0.12, Math.max(1.5, s * 0.09), 0, Math.PI * 2);
  ctx.fill();
}

function drawPipeSprite(
  ctx: CanvasRenderingContext2D,
  e: EntityInstance,
  pipeCoords: Set<string>,
  ox: number,
  oy: number,
  s: number,
): void {
  const ex = ox + e.tx * s;
  const ey = oy + e.ty * s;
  const cx = ex + s * 0.5;
  const cy = ey + s * 0.5;
  const fluidCol = e.item ? getItemMeta(e.item).color : PIPE_SPEC.color;
  const isUg = isPipeUndergroundName(e.name);
  const armW = Math.max(2, s * 0.36);

  ctx.fillStyle = '#475569';
  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = Math.max(1, s * 0.06);

  if (isUg) {
    const { dx, dy } = dirDelta(e.direction);
    // Surface stub towards open connection
    ctx.fillRect(
      cx - armW / 2 + (dx > 0 ? 0 : dx * s * 0.5),
      cy - armW / 2 + (dy > 0 ? 0 : dy * s * 0.5),
      dx !== 0 ? s * 0.5 + armW / 2 : armW,
      dy !== 0 ? s * 0.5 + armW / 2 : armW,
    );
    // Underground armored cap
    ctx.fillStyle = '#1e293b';
    ctx.strokeStyle = fluidCol;
    ctx.lineWidth = Math.max(1.3, s * 0.09);
    ctx.beginPath();
    ctx.roundRect(ex + s * 0.16, ey + s * 0.16, s * 0.68, s * 0.68, s * 0.12);
    ctx.fill();
    ctx.stroke();
  } else {
    // Connect to orthogonal fluid neighbors or draw cross core
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      if (pipeCoords.has(`${e.tx + dx},${e.ty + dy}`)) {
        ctx.fillRect(
          cx - armW / 2 + (dx < 0 ? -s * 0.5 + armW / 2 : 0),
          cy - armW / 2 + (dy < 0 ? -s * 0.5 + armW / 2 : 0),
          dx !== 0 ? s * 0.5 : armW,
          dy !== 0 ? s * 0.5 : armW,
        );
      }
    }
    ctx.fillRect(ex + s * 0.24, ey + s * 0.24, s * 0.52, s * 0.52);
    ctx.strokeRect(ex + s * 0.24, ey + s * 0.24, s * 0.52, s * 0.52);
  }

  // Fluid sighting glass
  ctx.fillStyle = fluidCol;
  ctx.beginPath();
  ctx.arc(cx, cy, Math.max(1.8, s * 0.15), 0, Math.PI * 2);
  ctx.fill();
}

export function renderFactorioScene(
  ctx: CanvasRenderingContext2D,
  canvasW: number,
  canvasH: number,
  floorplan: FloorplanResult,
  entities: EntityInstance[],
  ox: number,
  oy: number,
  s: number,
  layers: FactorioRenderLayerOpts,
  selectedMacroId: string | null,
  selectedPinId: string | null,
  netUtilMap: Map<string, number>,
  macroUtilMap: Map<string, number>,
  utilColorFn: (u: number) => string,
  highlightedPinIds?: Set<string>,
  entityLanes?: Record<string, BeltLaneFlowInfo>,
  staNetMap?: Map<string, StaNetReport>,
): { ugInputs: EntityInstance[]; ugOutputs: EntityInstance[] } {
  const emptyStaNetMap = staNetMap ?? new Map<string, StaNetReport>();
  const W = floorplan.width;
  const H = floorplan.height;

  // Refined Concrete outer ground & die pad
  ctx.fillStyle = '#1b1d20';
  ctx.fillRect(0, 0, canvasW, canvasH);

  ctx.fillStyle = '#34373c';
  ctx.fillRect(ox, oy, W * s, H * s);

  if (s >= 7) {
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.24)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= W; x++) {
      const px = Math.round(ox + x * s) + 0.5;
      ctx.moveTo(px, oy);
      ctx.lineTo(px, oy + H * s);
    }
    for (let y = 0; y <= H; y++) {
      const py = Math.round(oy + y * s) + 0.5;
      ctx.moveTo(ox, py);
      ctx.lineTo(ox + W * s, py);
    }
    ctx.stroke();
  }

  const gridStep = s < 3 ? 20 : 5;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= W; x += gridStep) {
    const px = Math.round(ox + x * s) + 0.5;
    ctx.moveTo(px, oy);
    ctx.lineTo(px, oy + H * s);
  }
  for (let y = 0; y <= H; y += gridStep) {
    const py = Math.round(oy + y * s) + 0.5;
    ctx.moveTo(ox, py);
    ctx.lineTo(ox + W * s, py);
  }
  ctx.stroke();

  if (s >= 9) {
    ctx.fillStyle = 'rgba(203, 213, 225, 0.55)';
    ctx.font = '10px JetBrains Mono, monospace';
    ctx.textAlign = 'center';
    for (let x = 0; x <= W; x += 5) {
      ctx.fillText(String(x), ox + x * s, oy - 5);
    }
    ctx.textAlign = 'right';
    for (let y = 0; y <= H; y += 5) {
      ctx.fillText(String(y), ox - 5, oy + y * s + 3);
    }
  }

  // Refined concrete border bevel
  ctx.strokeStyle = '#64748b';
  ctx.lineWidth = 2;
  ctx.strokeRect(ox, oy, W * s, H * s);

  // Power supply coverage overlay (when enabled)
  if (layers.powerCoverage) {
    for (const e of entities) {
      const ps = POLE_BY_ENTITY_NAME[e.name];
      if (!ps) continue;
      const pcx = ox + (e.tx + ps.size / 2) * s;
      const pcy = oy + (e.ty + ps.size / 2) * s;
      const r = ps.supplyRadius * s;
      ctx.fillStyle = 'rgba(56, 189, 248, 0.12)';
      ctx.fillRect(pcx - r, pcy - r, r * 2, r * 2);
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.45)';
      ctx.lineWidth = 1;
      ctx.strokeRect(pcx - r, pcy - r, r * 2, r * 2);
    }
  }

  // Soft macro outline overlay
  if (layers.macros) {
    for (const pm of floorplan.macros) {
      const mx = ox + pm.x * s;
      const my = oy + pm.y * s;
      const mw = pm.macro.width * s;
      const mh = pm.macro.height * s;
      const isSel = selectedMacroId === pm.id;
      const isBal = pm.macro.kind === 'balancer-macro';

      ctx.fillStyle = isSel ? 'rgba(245, 158, 11, 0.1)' : 'rgba(255, 255, 255, 0.03)';
      ctx.fillRect(mx, my, mw, mh);

      ctx.save();
      ctx.setLineDash(isSel ? [] : [4, 4]);
      ctx.strokeStyle = isSel
        ? '#f59e0b'
        : isBal
          ? 'rgba(251, 191, 36, 0.45)'
          : 'rgba(148, 163, 184, 0.35)';
      ctx.lineWidth = isSel ? 2.2 : 1;
      ctx.strokeRect(mx, my, mw, mh);
      ctx.restore();
    }
  }

  const isVis = (tx: number, ty: number, w = 1, h = 1, pad = 1) => {
    const x0 = ox + tx * s;
    const y0 = oy + ty * s;
    return (
      x0 + w * s >= -pad * s &&
      x0 <= canvasW + pad * s &&
      y0 + h * s >= -pad * s &&
      y0 <= canvasH + pad * s
    );
  };
  const fastLod = s < 4.5;

  // Classify visible entity draw order (belts -> machines -> inserters -> port markers -> poles & wires)
  const belts: EntityInstance[] = [];
  const ugs: EntityInstance[] = [];
  const pipes: EntityInstance[] = [];
  const splitters: EntityInstance[] = [];
  const machines: EntityInstance[] = [];
  const beacons: EntityInstance[] = [];
  const inserters: EntityInstance[] = [];
  const poles: EntityInstance[] = [];
  const markers: EntityInstance[] = [];
  const ugInputs: EntityInstance[] = [];
  const ugOutputs: EntityInstance[] = [];
  const pipeUgs: EntityInstance[] = [];
  const pipeCoords = new Set<string>();

  for (const e of entities) {
    if (isPipeName(e.name)) {
      pipeCoords.add(`${e.tx},${e.ty}`);
      if (isPipeUndergroundName(e.name) && isVis(e.tx, e.ty, e.w, e.h, 10)) {
        pipeUgs.push(e);
      }
      if (isVis(e.tx, e.ty, e.w, e.h, 1)) pipes.push(e);
    } else if (isUndergroundName(e.name)) {
      if (e.type === 'input') {
        if (isVis(e.tx, e.ty, e.w, e.h, 10)) ugInputs.push(e);
      } else {
        if (isVis(e.tx, e.ty, e.w, e.h, 10)) ugOutputs.push(e);
      }
      if (isVis(e.tx, e.ty, e.w, e.h, 1)) ugs.push(e);
    } else if (e.name in POLE_BY_ENTITY_NAME) {
      if (isVis(e.tx, e.ty, e.w, e.h, 18)) poles.push(e);
    } else if (!isVis(e.tx, e.ty, e.w, e.h, 1)) {
      continue;
    } else if (e.role === 'port-marker') {
      markers.push(e);
    } else if (isMachineName(e.name)) {
      machines.push(e);
    } else if (e.name === 'beacon') {
      beacons.push(e);
    } else if (isSplitterName(e.name)) {
      splitters.push(e);
    } else if (beltTierFromEntityName(e.name)) {
      belts.push(e);
    } else if (e.name in INSERTER_BY_ENTITY_NAME) {
      inserters.push(e);
    }
  }

  const incomingMap = fastLod ? null : buildIncomingMap(entities);

  // Layer 1: Surface belts
  if (layers.belts) {
    for (const b of belts) {
      const tier = beltTierFromEntityName(b.name)!;
      const laneUtils = layers.heatmap
        ? resolveEntityLaneUtils(b, entityLanes, emptyStaNetMap)
        : null;
      if (fastLod) {
        ctx.fillStyle = laneUtils
          ? laneUtilColor(Math.max(laneUtils.leftUtil, laneUtils.rightUtil))
          : layers.heatmap && b.netId && netUtilMap.has(b.netId)
            ? utilColorFn(netUtilMap.get(b.netId)!)
            : BELT_SPECS[tier].color;
        ctx.fillRect(ox + b.tx * s, oy + b.ty * s, Math.max(1.2, s), Math.max(1.2, s));
        continue;
      }
      const shape = classifyBeltShape(b, incomingMap!);
      drawSurfaceBelt(ctx, b, shape, ox, oy, s, tier, layers.altMode);
      if (laneUtils) {
        drawBeltLaneHeatmap(
          ctx,
          ox + b.tx * s,
          oy + b.ty * s,
          s,
          b.direction,
          laneUtils.leftUtil,
          laneUtils.rightUtil,
          0,
        );
      } else if (layers.heatmap && b.netId && netUtilMap.has(b.netId)) {
        ctx.fillStyle = utilColorFn(netUtilMap.get(b.netId)!);
        ctx.fillRect(ox + b.tx * s, oy + b.ty * s, s, s);
      }
    }
  }

  // Layer 2: Splitters & Underground Belt Hoods
  if (layers.belts) {
    for (const sp of splitters) {
      const tier = beltTierFromEntityName(sp.name) ?? 'yellow';
      const laneUtils = layers.heatmap
        ? resolveEntityLaneUtils(sp, entityLanes, emptyStaNetMap)
        : null;
      if (fastLod) {
        ctx.fillStyle = laneUtils
          ? laneUtilColor(Math.max(laneUtils.leftUtil, laneUtils.rightUtil))
          : BELT_SPECS[tier].color;
        ctx.fillRect(ox + sp.tx * s, oy + sp.ty * s, Math.max(1.5, sp.w * s), Math.max(1.5, sp.h * s));
        continue;
      }
      drawSplitterEntity(ctx, sp, ox, oy, s, tier);
      if (laneUtils) {
        ctx.fillStyle = laneUtilColor(Math.max(laneUtils.leftUtil, laneUtils.rightUtil));
        ctx.fillRect(ox + sp.tx * s, oy + sp.ty * s, sp.w * s, sp.h * s);
      }
    }
  }
  if (layers.undergrounds) {
    for (const ug of ugs) {
      const tier = beltTierFromEntityName(ug.name) ?? 'yellow';
      const laneUtils = layers.heatmap
        ? resolveEntityLaneUtils(ug, entityLanes, emptyStaNetMap)
        : null;
      if (fastLod) {
        ctx.fillStyle = laneUtils
          ? laneUtilColor(Math.max(laneUtils.leftUtil, laneUtils.rightUtil))
          : BELT_SPECS[tier].color;
        ctx.fillRect(ox + ug.tx * s, oy + ug.ty * s, Math.max(1.2, s), Math.max(1.2, s));
        continue;
      }
      drawUndergroundHood(ctx, ug, ox, oy, s, tier);
      if (laneUtils) {
        drawBeltLaneHeatmap(
          ctx,
          ox + ug.tx * s,
          oy + ug.ty * s,
          s,
          ug.direction,
          laneUtils.leftUtil,
          laneUtils.rightUtil,
          0,
        );
      }
    }
  }

  // Layer 2b: Fluid Pipes & Pipe-to-Ground Links
  if (layers.belts) {
    for (const p of pipes) {
      if (fastLod) {
        ctx.fillStyle = p.item ? getItemMeta(p.item).color : PIPE_SPEC.color;
        ctx.fillRect(ox + p.tx * s + 0.3, oy + p.ty * s + 0.3, Math.max(1.2, s - 0.6), Math.max(1.2, s - 0.6));
        continue;
      }
      drawPipeSprite(ctx, p, pipeCoords, ox, oy, s);
    }
    if (layers.undergrounds && s >= 2.5 && pipeUgs.length > 0) {
      const puMap = new Map(pipeUgs.map((u) => [`${u.tx},${u.ty}`, u]));
      ctx.save();
      ctx.setLineDash([3, 2]);
      ctx.lineWidth = Math.max(1.2, s * 0.1);
      for (const u of pipeUgs) {
        const opp = oppositeDir(u.direction);
        const { dx, dy } = dirDelta(opp);
        if (dx + dy <= 0) continue;
        for (let step = 1; step <= PIPE_SPEC.maxUgDistance; step++) {
          const partner = puMap.get(`${u.tx + dx * step},${u.ty + dy * step}`);
          if (partner && partner.direction === opp) {
            ctx.strokeStyle = u.item ? getItemMeta(u.item).color : PIPE_SPEC.color;
            ctx.beginPath();
            ctx.moveTo(ox + (u.tx + 0.5) * s, oy + (u.ty + 0.5) * s);
            ctx.lineTo(ox + (partner.tx + 0.5) * s, oy + (partner.ty + 0.5) * s);
            ctx.stroke();
            break;
          }
        }
      }
      ctx.restore();
    }
  }

  // Layer 3: Assembling Machines & Electric Furnaces
  for (const m of machines) {
    const hColor =
      layers.heatmap && m.macroId && macroUtilMap.has(m.macroId)
        ? utilColorFn(macroUtilMap.get(m.macroId)!)
        : null;
    if (fastLod) {
      const mColor =
        m.name === 'electric-furnace'
          ? '#64748b'
          : m.name === 'chemical-plant'
            ? '#0d9488'
            : m.name === 'foundry'
              ? '#9a3412'
              : m.name === 'electromagnetic-plant'
                ? '#6d28d9'
                : m.name === 'cryogenic-plant'
                  ? '#0e7490'
                  : '#2a5f82';
      ctx.fillStyle = hColor ?? mColor;
      ctx.fillRect(
        ox + m.tx * s + 0.3,
        oy + m.ty * s + 0.3,
        Math.max(1.5, m.w * s - 0.6),
        Math.max(1.5, m.h * s - 0.6),
      );
      continue;
    }
    drawMachineEntity(ctx, m, ox, oy, s, layers.altMode, hColor);
  }

  // Layer 3b: Beacons
  for (const b of beacons) {
    if (fastLod) {
      ctx.fillStyle = '#0891b2';
      ctx.fillRect(
        ox + b.tx * s + 0.3,
        oy + b.ty * s + 0.3,
        Math.max(1.5, b.w * s - 0.6),
        Math.max(1.5, b.h * s - 0.6),
      );
      continue;
    }
    drawBeaconEntity(ctx, b, ox, oy, s, layers.altMode);
  }

  // Layer 4: Inserters
  for (const ins of inserters) {
    if (fastLod) {
      ctx.fillStyle = INSERTER_BY_ENTITY_NAME[ins.name].color;
      ctx.fillRect(
        ox + (ins.tx + 0.25) * s,
        oy + (ins.ty + 0.25) * s,
        Math.max(1.2, s * 0.5),
        Math.max(1.2, s * 0.5),
      );
      continue;
    }
    drawInserterEntity(ctx, ins, ox, oy, s);
  }

  // Layer 5: Port markers (Display Panels / Constant Combinators)
  if (layers.pinLabels && !fastLod) {
    for (const mk of markers) {
      const mx = ox + mk.tx * s;
      const my = oy + mk.ty * s;
      ctx.fillStyle = '#334155';
      ctx.strokeStyle = '#94a3b8';
      ctx.lineWidth = 1.2;
      ctx.fillRect(mx + s * 0.14, my + s * 0.14, s * 0.72, s * 0.72);
      ctx.strokeRect(mx + s * 0.14, my + s * 0.14, s * 0.72, s * 0.72);
      if (mk.markerIcon) {
        const img = getIcon(mk.markerIcon);
        if (img) {
          drawCroppedIcon(ctx, img, mx + s * 0.22, my + s * 0.22, s * 0.56, s * 0.56);
        }
      }
    }
  }

  // Layer 6: Power Poles + Spatial-Hashed Copper Wires
  const poleCenters: Array<{ ent: EntityInstance; cx: number; cy: number; wireReach: number }> = [];
  for (const pe of poles) {
    const ps = POLE_BY_ENTITY_NAME[pe.name];
    if (!ps) continue;
    const cx = ox + (pe.tx + pe.w / 2) * s;
    const cy = oy + (pe.ty + pe.h / 2) * s;
    poleCenters.push({ ent: pe, cx, cy, wireReach: ps.wireReach });
    if (layers.powerGrid && isVis(pe.tx, pe.ty, pe.w, pe.h, 1)) {
      if (fastLod) {
        ctx.fillStyle = ps.color;
        ctx.fillRect(cx - 1.2, cy - 1.2, 2.4, 2.4);
      } else {
        drawPoleEntity(ctx, pe, ox, oy, s);
      }
    }
  }

  if (layers.powerGrid && poleCenters.length > 1) {
    const CELL = 18;
    const poleGrid = new Map<string, number[]>();
    for (let i = 0; i < poleCenters.length; i++) {
      const pe = poleCenters[i].ent;
      const key = `${Math.floor((pe.tx + pe.w / 2) / CELL)},${Math.floor((pe.ty + pe.h / 2) / CELL)}`;
      let b = poleGrid.get(key);
      if (!b) {
        b = [];
        poleGrid.set(key, b);
      }
      b.push(i);
    }

    const drawShadows = s >= 5;
    ctx.save();
    for (let i = 0; i < poleCenters.length; i++) {
      const a = poleCenters[i];
      const ax = a.ent.tx + a.ent.w / 2;
      const ayTile = a.ent.ty + a.ent.h / 2;
      const gcx = Math.floor(ax / CELL);
      const gcy = Math.floor(ayTile / CELL);
      for (let ky = gcy - 1; ky <= gcy + 1; ky++) {
        for (let kx = gcx - 1; kx <= gcx + 1; kx++) {
          const bucket = poleGrid.get(`${kx},${ky}`);
          if (!bucket) continue;
          for (const j of bucket) {
            if (j <= i) continue;
            const b = poleCenters[j];
            const reach = Math.min(a.wireReach, b.wireReach);
            const dx = ax - (b.ent.tx + b.ent.w / 2);
            const dy = ayTile - (b.ent.ty + b.ent.h / 2);
            if (dx * dx + dy * dy <= reach * reach + 1e-6) {
              if (!drawShadows) {
                ctx.strokeStyle = 'rgba(217, 130, 62, 0.65)';
                ctx.lineWidth = s < 3 ? 0.7 : 1;
                ctx.beginPath();
                ctx.moveTo(a.cx, a.cy);
                ctx.lineTo(b.cx, b.cy);
                ctx.stroke();
              } else {
                const mx = (a.cx + b.cx) / 2;
                const my = (a.cy + b.cy) / 2;
                const dist = Math.hypot(b.cx - a.cx, b.cy - a.cy);
                const sag = Math.min(s * 0.75, dist * 0.08);
                const ay = a.cy - s * 0.14;
                const by = b.cy - s * 0.14;

                // Wire shadow
                ctx.strokeStyle = 'rgba(0, 0, 0, 0.26)';
                ctx.lineWidth = 1.2;
                ctx.beginPath();
                ctx.moveTo(a.cx + 2, ay + 4);
                ctx.quadraticCurveTo(mx + 2, my + 4 + sag, b.cx + 2, by + 4);
                ctx.stroke();

                // Warm Factorio copper wire
                ctx.strokeStyle = 'rgba(217, 130, 62, 0.78)';
                ctx.lineWidth = 1.15;
                ctx.beginPath();
                ctx.moveTo(a.cx, ay);
                ctx.quadraticCurveTo(mx, my + sag, b.cx, by);
                ctx.stroke();
              }
            }
          }
        }
      }
    }
    ctx.restore();
  }

  // Macro label pills drawn above entities & wires so adjacent machines/belts never occlude tags
  if (layers.macros && s >= 8) {
    ctx.save();
    const fontSize = Math.max(9, Math.min(11, s * 0.5));
    ctx.font = `600 ${fontSize}px Inter, sans-serif`;
    ctx.textAlign = 'left';
    for (const pm of floorplan.macros) {
      const mx = ox + pm.x * s;
      const my = oy + pm.y * s;
      const isBal = pm.macro.kind === 'balancer-macro';
      const isSel = selectedMacroId === pm.id;
      const tag = `${pm.locked ? '🔒 ' : ''}${pm.macro.label} (${pm.macro.sublabel})`;
      const tw = ctx.measureText(tag).width;
      ctx.fillStyle = isSel ? 'rgba(30, 41, 59, 0.92)' : 'rgba(15, 20, 28, 0.84)';
      ctx.fillRect(mx + 2, my - 15, tw + 8, 13);
      if (isSel) {
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 1;
        ctx.strokeRect(mx + 2, my - 15, tw + 8, 13);
      }
      ctx.fillStyle = isBal ? '#fde68a' : '#e2e8f0';
      ctx.fillText(tag, mx + 6, my - 5);
    }
    ctx.restore();
  }

  // Layer 7: Perimeter I/O Badges + Real Item Icons
  for (const pin of floorplan.pins) {
    const px = ox + (pin.x + 0.5) * s;
    const py = oy + (pin.y + 0.5) * s;
    const isSel = selectedPinId === pin.id || (highlightedPinIds?.has(pin.id) ?? false);
    const col = pin.kind === 'input' ? '#4ade80' : '#f472b6';

    ctx.fillStyle = '#181c22';
    ctx.strokeStyle = selectedPinId === pin.id ? '#f59e0b' : isSel ? '#ffffff' : col;
    ctx.lineWidth = isSel ? 2.5 : 1.8;
    ctx.beginPath();
    ctx.arc(px, py, Math.max(4.5, s * 0.42), 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    const pinIcon = getIcon(pin.item);
    if (pinIcon && s >= 9) {
      const r = Math.max(4, s * 0.34);
      drawCroppedIcon(ctx, pinIcon, px - r, py - r, r * 2, r * 2);
    } else {
      ctx.fillStyle = getItemMeta(pin.item).color;
      ctx.beginPath();
      ctx.arc(px, py, Math.max(2, s * 0.2), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  if (layers.pinLabels) {
    drawSmartPinLabels(ctx, floorplan, ox, oy, s, {
      selectedPinId,
      highlightedPinIds,
      theme: 'factorio',
    });
  }

  void BELT_SPECS;
  return { ugInputs, ugOutputs };
}
