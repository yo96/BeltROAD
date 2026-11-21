import { FloorplanResult, PerimeterPin, getItemMeta } from '@factorio-eda/core';

export interface SmartPinLabelOpts {
  selectedPinId: string | null;
  highlightedPinIds?: Set<string>;
  theme: 'factorio' | 'eda';
}

interface PreparedPinLabel {
  pin: PerimeterPin;
  px: number;
  py: number;
  text: string;
  pw: number;
  ph: number;
}

function fillRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.lineTo(x + w - rad, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
  ctx.lineTo(x + w, y + h - rad);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
  ctx.lineTo(x + rad, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
  ctx.lineTo(x, y + rad);
  ctx.quadraticCurveTo(x, y, x + rad, y);
  ctx.closePath();
}

function solveVerticalClusters(anchorsY: number[], minStep: number): number[] {
  const n = anchorsY.length;
  if (n === 0) return [];
  const ly = anchorsY.slice();

  // Forward push pass
  for (let i = 1; i < n; i++) {
    if (ly[i] < ly[i - 1] + minStep) {
      ly[i] = ly[i - 1] + minStep;
    }
  }

  // Recenter contiguous shifted clusters around original anchor mean
  let clusterStart = 0;
  while (clusterStart < n) {
    let clusterEnd = clusterStart;
    while (
      clusterEnd + 1 < n &&
      ly[clusterEnd + 1] - ly[clusterEnd] <= minStep + 0.5
    ) {
      clusterEnd++;
    }
    if (clusterEnd > clusterStart) {
      let sumOrig = 0;
      let sumShift = 0;
      const count = clusterEnd - clusterStart + 1;
      for (let k = clusterStart; k <= clusterEnd; k++) {
        sumOrig += anchorsY[k];
        sumShift += ly[k];
      }
      let delta = sumOrig / count - sumShift / count;
      if (clusterStart > 0) {
        const minFirst = ly[clusterStart - 1] + minStep;
        if (ly[clusterStart] + delta < minFirst) {
          delta = minFirst - ly[clusterStart];
        }
      }
      for (let k = clusterStart; k <= clusterEnd; k++) {
        ly[k] += delta;
      }
    }
    clusterStart = clusterEnd + 1;
  }

  // Final forward guarantee pass
  for (let i = 1; i < n; i++) {
    if (ly[i] < ly[i - 1] + minStep) {
      ly[i] = ly[i - 1] + minStep;
    }
  }

  return ly;
}

function drawPill(
  ctx: CanvasRenderingContext2D,
  bx: number,
  by: number,
  pw: number,
  ph: number,
  text: string,
  pin: PerimeterPin,
  selectedPinId: string | null,
  highlightedPinIds: Set<string> | undefined,
  theme: 'factorio' | 'eda',
  fontSize: number,
): void {
  const isSelected = selectedPinId === pin.id;
  const isHighlighted = highlightedPinIds?.has(pin.id) ?? false;

  const bg =
    theme === 'factorio' ? 'rgba(15, 20, 28, 0.88)' : 'rgba(8, 22, 38, 0.92)';
  let border =
    pin.kind === 'input'
      ? 'rgba(74, 222, 128, 0.55)'
      : 'rgba(244, 114, 182, 0.55)';
  if (isHighlighted) border = '#ffffff';
  if (isSelected) border = '#f59e0b';

  fillRoundRect(ctx, bx, by, pw, ph, 4);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.strokeStyle = border;
  ctx.lineWidth = isSelected || isHighlighted ? 1.5 : 1;
  ctx.stroke();

  ctx.fillStyle = isSelected ? '#fde68a' : '#f1f5f9';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, bx + 6, by + ph / 2 + 0.5, pw - 12);
  void fontSize;
}

export function drawSmartPinLabels(
  ctx: CanvasRenderingContext2D,
  floorplan: FloorplanResult,
  ox: number,
  oy: number,
  s: number,
  opts: SmartPinLabelOpts,
): void {
  if (s < 4.5 || floorplan.pins.length === 0) return;

  const { selectedPinId, highlightedPinIds, theme } = opts;
  const fontSize = Math.max(8.5, Math.min(11, s * 0.55));
  const ph = fontSize + 5;
  const pad = Math.max(9, s * 0.85);

  ctx.save();
  ctx.font = `600 ${fontSize}px JetBrains Mono, monospace`;

  const byEdge: Record<'W' | 'E' | 'N' | 'S', PreparedPinLabel[]> = {
    W: [],
    E: [],
    N: [],
    S: [],
  };

  for (const pin of floorplan.pins) {
    const meta = getItemMeta(pin.item);
    const text = `${pin.locked ? '🔒 ' : ''}${meta.name} (${Math.round(pin.ratePerSec * 60)}/m)`;
    const pw = ctx.measureText(text).width + 12;
    byEdge[pin.edge].push({
      pin,
      px: ox + (pin.x + 0.5) * s,
      py: oy + (pin.y + 0.5) * s,
      text,
      pw,
      ph,
    });
  }

  // West & East edges: vertical non-overlap cluster relaxation
  for (const edge of ['W', 'E'] as const) {
    const list = byEdge[edge].sort((a, b) => a.py - b.py);
    if (list.length === 0) continue;

    const minStep = ph + 3;
    const solvedY = solveVerticalClusters(
      list.map((it) => it.py),
      minStep,
    );

    list.forEach((it, idx) => {
      const ly = solvedY[idx];
      const by = ly - it.ph / 2;
      const bx = edge === 'W' ? it.px - pad - it.pw : it.px + pad;
      const innerEdgeX = edge === 'W' ? bx + it.pw : bx;
      const dotEdgeX =
        edge === 'W'
          ? it.px - Math.max(4.5, s * 0.42)
          : it.px + Math.max(4.5, s * 0.42);

      if (Math.abs(ly - it.py) > 1.5) {
        ctx.strokeStyle =
          it.pin.kind === 'input'
            ? 'rgba(74, 222, 128, 0.45)'
            : 'rgba(244, 114, 182, 0.45)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(dotEdgeX, it.py);
        ctx.lineTo(innerEdgeX, ly);
        ctx.stroke();
      }

      drawPill(
        ctx,
        bx,
        by,
        it.pw,
        it.ph,
        it.text,
        it.pin,
        selectedPinId,
        highlightedPinIds,
        theme,
        fontSize,
      );
    });
  }

  // North & South edges: horizontal multi-row staggering (up to 3 rows)
  for (const edge of ['N', 'S'] as const) {
    const list = byEdge[edge].sort((a, b) => a.px - b.px);
    if (list.length === 0) continue;

    const rowRightX: number[] = [-Infinity, -Infinity, -Infinity];
    for (const it of list) {
      let chosenRow = -1;
      let bx = it.px - it.pw / 2;
      for (let r = 0; r < 3; r++) {
        if (bx >= rowRightX[r] + 5) {
          chosenRow = r;
          break;
        }
      }
      if (chosenRow === -1) {
        // Pick row with smallest rightmost extent and shift pill rightward to prevent overlap
        let bestRow = 0;
        for (let r = 1; r < 3; r++) {
          if (rowRightX[r] < rowRightX[bestRow]) bestRow = r;
        }
        chosenRow = bestRow;
        if (rowRightX[chosenRow] > -Infinity) {
          bx = Math.max(bx, rowRightX[chosenRow] + 5);
        }
      }
      rowRightX[chosenRow] = bx + it.pw;

      const rowOffset = pad + chosenRow * (it.ph + 4);
      const by = edge === 'N' ? it.py - rowOffset - it.ph : it.py + rowOffset;
      const anchorEdgeY =
        edge === 'N'
          ? it.py - Math.max(4.5, s * 0.42)
          : it.py + Math.max(4.5, s * 0.42);
      const pillAnchorY = edge === 'N' ? by + it.ph : by;
      const pillCenterX = Math.max(bx + 6, Math.min(bx + it.pw - 6, it.px));

      ctx.strokeStyle =
        it.pin.kind === 'input'
          ? 'rgba(74, 222, 128, 0.45)'
          : 'rgba(244, 114, 182, 0.45)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(it.px, anchorEdgeY);
      ctx.lineTo(pillCenterX, pillAnchorY);
      ctx.stroke();

      drawPill(
        ctx,
        bx,
        by,
        it.pw,
        it.ph,
        it.text,
        it.pin,
        selectedPinId,
        highlightedPinIds,
        theme,
        fontSize,
      );
    }
  }

  ctx.restore();
}
