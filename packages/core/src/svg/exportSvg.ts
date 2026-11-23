import {
  EntityInstance,
  PipelineResult,
} from '../types.js';
import {
  BELT_SPECS,
  INSERTER_BY_ENTITY_NAME,
  POLE_BY_ENTITY_NAME,
  beltTierFromEntityName,
  isMachineName,
  isSplitterName,
  isUndergroundName,
} from '../data/entities.js';
import { getItemMeta } from '../data/catalog.js';
import { dirDelta } from '../geometry.js';

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderLayoutToSvg(result: PipelineResult, tilePx = 18): string {
  const padTiles = 2;
  const W = result.floorplan.width;
  const H = result.floorplan.height;
  const svgW = (W + padTiles * 2) * tilePx;
  const svgH = (H + padTiles * 2) * tilePx;
  const ox = padTiles * tilePx;
  const oy = padTiles * tilePx;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">`,
  );

  // Blueprint blue background
  parts.push(`<rect width="${svgW}" height="${svgH}" fill="#0c2238" />`);
  parts.push(
    `<rect x="${ox}" y="${oy}" width="${W * tilePx}" height="${H * tilePx}" fill="#112e4b" stroke="#60a5fa" stroke-width="2" />`,
  );

  // Grid lines (1-tile and 5-tile major)
  parts.push(`<g stroke="#1d4b75" stroke-width="0.6">`);
  for (let x = 0; x <= W; x++) {
    const px = ox + x * tilePx;
    const major = x % 5 === 0;
    parts.push(
      `<line x1="${px}" y1="${oy}" x2="${px}" y2="${oy + H * tilePx}" ${major ? 'stroke="#2563eb" stroke-opacity="0.45" stroke-width="1"' : ''} />`,
    );
  }
  for (let y = 0; y <= H; y++) {
    const py = oy + y * tilePx;
    const major = y % 5 === 0;
    parts.push(
      `<line x1="${ox}" y1="${py}" x2="${ox + W * tilePx}" y2="${py}" ${major ? 'stroke="#2563eb" stroke-opacity="0.45" stroke-width="1"' : ''} />`,
    );
  }
  parts.push(`</g>`);

  // Macro outlines
  for (const pm of result.floorplan.macros) {
    const mx = ox + pm.x * tilePx;
    const my = oy + pm.y * tilePx;
    const mw = pm.macro.width * tilePx;
    const mh = pm.macro.height * tilePx;
    const isBal = pm.macro.kind === 'balancer-macro';
    parts.push(
      `<rect x="${mx}" y="${my}" width="${mw}" height="${mh}" fill="${isBal ? 'rgba(245,158,11,0.08)' : 'rgba(56,189,248,0.08)'}" stroke="${isBal ? '#fbbf24' : '#38bdf8'}" stroke-dasharray="4 3" stroke-width="1.2" rx="3" />`,
    );
    parts.push(
      `<text x="${mx + 4}" y="${my + 11}" fill="#bae6fd" font-size="9" font-weight="600">${escapeXml(pm.macro.label)}</text>`,
    );
  }

  // Entities
  const ugInputs: EntityInstance[] = [];
  const ugOutputs: EntityInstance[] = [];

  for (const e of result.allEntities) {
    const ex = ox + e.tx * tilePx;
    const ey = oy + e.ty * tilePx;
    const ew = e.w * tilePx;
    const eh = e.h * tilePx;

    if (isMachineName(e.name)) {
      const itemMeta = e.item ? getItemMeta(e.item) : null;
      const fillCol =
        e.name === 'electric-furnace'
          ? '#334155'
          : e.name === 'foundry'
            ? '#5c2410'
            : e.name === 'electromagnetic-plant'
              ? '#3b1c6e'
              : e.name === 'cryogenic-plant'
                ? '#164e63'
                : '#1e3a5f';
      const strokeCol =
        e.name === 'electric-furnace'
          ? '#f97316'
          : e.name === 'foundry'
            ? '#fb923c'
            : e.name === 'electromagnetic-plant'
              ? '#e879f9'
              : e.name === 'cryogenic-plant'
                ? '#22d3ee'
                : '#93c5fd';
      parts.push(
        `<rect x="${ex + 1}" y="${ey + 1}" width="${ew - 2}" height="${eh - 2}" fill="${fillCol}" stroke="${strokeCol}" stroke-width="1.5" rx="3" />`,
      );
      if (itemMeta) {
        parts.push(
          `<circle cx="${ex + ew / 2}" cy="${ey + eh / 2}" r="${Math.min(ew, eh) * 0.24}" fill="${itemMeta.color}" stroke="#0f172a" stroke-width="1" />`,
        );
      }
      continue;
    }

    if (isSplitterName(e.name)) {
      const tier = beltTierFromEntityName(e.name) ?? 'yellow';
      const col = BELT_SPECS[tier].color;
      parts.push(
        `<rect x="${ex + 1}" y="${ey + 1}" width="${ew - 2}" height="${eh - 2}" fill="#1e293b" stroke="${col}" stroke-width="1.6" rx="2" />`,
      );
      continue;
    }

    if (isUndergroundName(e.name)) {
      if (e.type === 'input') ugInputs.push(e);
      else ugOutputs.push(e);
      const tier = beltTierFromEntityName(e.name) ?? 'yellow';
      const col = BELT_SPECS[tier].color;
      parts.push(
        `<rect x="${ex + 2}" y="${ey + 2}" width="${ew - 4}" height="${eh - 4}" fill="${e.type === 'input' ? '#0f172a' : '#1e293b'}" stroke="${col}" stroke-width="1.5" rx="2" />`,
      );
      continue;
    }

    if (beltTierFromEntityName(e.name)) {
      const tier = beltTierFromEntityName(e.name)!;
      const col = BELT_SPECS[tier].color;
      const cx = ex + ew / 2;
      const cy = ey + eh / 2;
      const { dx, dy } = dirDelta(e.direction);
      const itemColor = e.item ? getItemMeta(e.item).color : col;
      parts.push(
        `<rect x="${ex + 2}" y="${ey + 2}" width="${ew - 4}" height="${eh - 4}" fill="rgba(15,23,42,0.72)" stroke="${col}" stroke-width="1" rx="2" />`,
      );
      parts.push(
        `<line x1="${cx - dx * 4}" y1="${cy - dy * 4}" x2="${cx + dx * 4}" y2="${cy + dy * 4}" stroke="${itemColor}" stroke-width="2" stroke-linecap="round" />`,
      );
      continue;
    }

    if (e.name in INSERTER_BY_ENTITY_NAME) {
      const ins = INSERTER_BY_ENTITY_NAME[e.name];
      const cx = ex + ew / 2;
      const cy = ey + eh / 2;
      const { dx, dy } = dirDelta(e.direction);
      parts.push(
        `<circle cx="${cx}" cy="${cy}" r="${tilePx * 0.25}" fill="#0f172a" stroke="${ins.color}" stroke-width="1.3" />`,
      );
      parts.push(
        `<line x1="${cx + dx * 4}" y1="${cy + dy * 4}" x2="${cx - dx * 5}" y2="${cy - dy * 5}" stroke="${ins.color}" stroke-width="1.6" />`,
      );
      continue;
    }

    if (e.name in POLE_BY_ENTITY_NAME) {
      const p = POLE_BY_ENTITY_NAME[e.name];
      parts.push(
        `<circle cx="${ex + ew / 2}" cy="${ey + eh / 2}" r="${Math.min(ew, eh) * 0.34}" fill="${p.color}" stroke="#f8fafc" stroke-width="1" />`,
      );
    }
  }

  // Underground span dashed lines
  parts.push(`<g stroke="#38bdf8" stroke-dasharray="3 2" stroke-width="1.2" opacity="0.75">`);
  for (const u of ugInputs) {
    const { dx, dy } = dirDelta(u.direction);
    const tier = beltTierFromEntityName(u.name)!;
    const maxD = BELT_SPECS[tier].maxUgDistance;
    for (let step = 1; step <= maxD; step++) {
      const m = ugOutputs.find(
        (o) =>
          o.tx === u.tx + dx * step &&
          o.ty === u.ty + dy * step &&
          o.direction === u.direction &&
          beltTierFromEntityName(o.name) === tier,
      );
      if (m) {
        parts.push(
          `<line x1="${ox + (u.tx + 0.5) * tilePx}" y1="${oy + (u.ty + 0.5) * tilePx}" x2="${ox + (m.tx + 0.5) * tilePx}" y2="${oy + (m.ty + 0.5) * tilePx}" />`,
        );
        break;
      }
    }
  }
  parts.push(`</g>`);

  // Perimeter pin labels
  for (const pin of result.floorplan.pins) {
    const px = ox + (pin.x + 0.5) * tilePx;
    const py = oy + (pin.y + 0.5) * tilePx;
    const col = pin.kind === 'input' ? '#4ade80' : '#f472b6';
    parts.push(`<circle cx="${px}" cy="${py}" r="4.5" fill="${col}" stroke="#0f172a" stroke-width="1" />`);
    const labelOffX = pin.edge === 'W' ? -6 : pin.edge === 'E' ? 6 : 0;
    const labelOffY = pin.edge === 'N' ? -7 : pin.edge === 'S' ? 12 : 3;
    const anchor = pin.edge === 'W' ? 'end' : pin.edge === 'E' ? 'start' : 'middle';
    parts.push(
      `<text x="${px + labelOffX}" y="${py + labelOffY}" fill="#e2e8f0" font-size="8.5" text-anchor="${anchor}">${escapeXml(pin.item)}</text>`,
    );
  }

  // Title banner
  parts.push(
    `<text x="${ox + 6}" y="${oy - 8}" fill="#93c5fd" font-size="11" font-weight="700">${escapeXml(result.spec.name)} — ${W}×${H} — DRC: ${result.drc.passed ? 'PASS' : 'FAIL'} | STA: ${result.sta.passed ? 'PASS' : 'FAIL'}</text>`,
  );

  parts.push(`</svg>`);
  return parts.join('\n');
}
