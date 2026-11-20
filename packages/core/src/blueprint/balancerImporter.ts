import {
  BalancerEntityDef,
  BalancerPort,
  BalancerTemplate,
  BeltTier,
  Dir,
  FACTORIO_2_0_MIN_VERSION,
} from '../types.js';
import {
  BELT_SPECS,
  beltTierFromEntityName,
  isSplitterName,
  isUndergroundName,
  splitterFootprint,
} from '../data/entities.js';
import { dirDelta } from '../geometry.js';
import { BlueprintData, BlueprintBookData, decodeBlueprintWrapper } from './codec.js';

function normalizeDirection(rawDir: number | undefined, isV2: boolean): Dir {
  const d = rawDir ?? 0;
  const scaled = isV2 ? d : d * 2;
  const norm = ((scaled % 16) + 16) % 16;
  if (norm === 0 || norm === 4 || norm === 8 || norm === 12) {
    return norm as Dir;
  }
  // Snap nearest cardinal direction if odd
  const snapped = (Math.round(norm / 4) * 4) % 16;
  return snapped as Dir;
}

function collectBlueprints(
  node: { blueprint?: BlueprintData; blueprint_book?: BlueprintBookData },
  out: BlueprintData[],
): void {
  if (node.blueprint) {
    out.push(node.blueprint);
  }
  if (node.blueprint_book) {
    for (const child of node.blueprint_book.blueprints) {
      collectBlueprints(child, out);
    }
  }
}

function extractBalancerFromBlueprint(bp: BlueprintData, idx: number): BalancerTemplate | null {
  const isV2 = (bp.version ?? 0) >= FACTORIO_2_0_MIN_VERSION;

  interface RawDef {
    tx: number;
    ty: number;
    w: number;
    h: number;
    kind: 'belt' | 'underground' | 'splitter';
    direction: Dir;
    ugType?: 'input' | 'output';
    tier: BeltTier;
  }

  const rawDefs: RawDef[] = [];
  for (const ent of bp.entities ?? []) {
    const tier = beltTierFromEntityName(ent.name);
    if (!tier) continue;
    const direction = normalizeDirection(ent.direction, isV2);
    let kind: 'belt' | 'underground' | 'splitter' = 'belt';
    let w = 1;
    let h = 1;
    if (isUndergroundName(ent.name)) {
      kind = 'underground';
    } else if (isSplitterName(ent.name)) {
      kind = 'splitter';
      const fp = splitterFootprint(direction);
      w = fp.w;
      h = fp.h;
    }
    const tx = Math.round(ent.position.x - w / 2);
    const ty = Math.round(ent.position.y - h / 2);
    rawDefs.push({
      tx,
      ty,
      w,
      h,
      kind,
      direction,
      ugType: ent.type,
      tier,
    });
  }

  if (rawDefs.length === 0) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const d of rawDefs) {
    minX = Math.min(minX, d.tx);
    minY = Math.min(minY, d.ty);
    maxX = Math.max(maxX, d.tx + d.w);
    maxY = Math.max(maxY, d.ty + d.h);
  }

  const width = maxX - minX;
  const height = maxY - minY;
  const entities: BalancerEntityDef[] = rawDefs.map((d) => ({
    tx: d.tx - minX,
    ty: d.ty - minY,
    w: d.w,
    h: d.h,
    kind: d.kind,
    direction: d.direction,
    ugType: d.ugType,
  }));

  // Determine dominant belt tier and verify no weaving
  const tiersPresent = new Set(rawDefs.map((r) => r.tier));
  const beltTier: BeltTier = tiersPresent.has('blue')
    ? 'blue'
    : tiersPresent.has('red')
      ? 'red'
      : 'yellow';

  // Map occupied tiles to detect perimeter input & output ports
  const tileMap = new Map<string, BalancerEntityDef>();
  for (const e of entities) {
    for (let dx = 0; dx < e.w; dx++) {
      for (let dy = 0; dy < e.h; dy++) {
        tileMap.set(`${e.tx + dx},${e.ty + dy}`, e);
      }
    }
  }

  const inputPorts: BalancerPort[] = [];
  const outputPorts: BalancerPort[] = [];

  for (const e of entities) {
    const { dx, dy } = dirDelta(e.direction);

    for (let ox = 0; ox < e.w; ox++) {
      for (let oy = 0; oy < e.h; oy++) {
        const px = e.tx + ox;
        const py = e.ty + oy;

        // Check all 4 neighbors to see if any neighbor feeds into (px, py)
        const { dx: fdx, dy: fdy } = dirDelta(e.direction);
        const upX = px - fdx;
        const upY = py - fdy;
        const upstreamOutside = upX < 0 || upX >= width || upY < 0 || upY >= height;

        let hasUpstream = e.kind === 'underground' && e.ugType === 'output';
        if (!hasUpstream) {
          for (const checkDir of [Dir.NORTH, Dir.EAST, Dir.SOUTH, Dir.WEST]) {
            const d = dirDelta(checkDir);
            const nx = px - d.dx;
            const ny = py - d.dy;
            const neighbor = tileMap.get(`${nx},${ny}`);
            if (
              neighbor &&
              neighbor.direction === checkDir &&
              !(neighbor.kind === 'underground' && neighbor.ugType === 'input')
            ) {
              hasUpstream = true;
              break;
            }
          }
        }
        if (!hasUpstream && upstreamOutside) {
          inputPorts.push({ x: px, y: py, dir: e.direction });
        }

        // Check downstream tile (where items leave this tile)
        const vx = px + dx;
        const vy = py + dy;
        const downstreamOutside = vx < 0 || vx >= width || vy < 0 || vy >= height;
        const downstream = tileMap.get(`${vx},${vy}`);
        const hasDownstream =
          (e.kind === 'underground' && e.ugType === 'input') ||
          downstream !== undefined;
        if (!hasDownstream && downstreamOutside) {
          outputPorts.push({ x: px, y: py, dir: e.direction });
        }
      }
    }
  }

  if (inputPorts.length === 0 || outputPorts.length === 0) return null;

  // Deduplicate and sort ports cleanly
  inputPorts.sort((a, b) => a.y - b.y || a.x - b.x);
  outputPorts.sort((a, b) => a.y - b.y || a.x - b.x);

  const label = bp.label?.trim() || `${inputPorts.length}x${outputPorts.length} Imported`;
  return {
    id: `imported-${inputPorts.length}x${outputPorts.length}-${idx}`,
    name: label,
    inputs: inputPorts.length,
    outputs: outputPorts.length,
    width,
    height,
    beltTier,
    maxUgDistance: BELT_SPECS[beltTier].maxUgDistance,
    entities,
    inputPorts,
    outputPorts,
    source: 'imported',
  };
}

export interface ImportBalancerBookResult {
  balancers: BalancerTemplate[];
  skipped: number;
  warnings: string[];
}

export function importBalancerBook(bpString: string): ImportBalancerBookResult {
  const wrapper = decodeBlueprintWrapper(bpString);
  const blueprints: BlueprintData[] = [];
  collectBlueprints(wrapper, blueprints);

  const balancers: BalancerTemplate[] = [];
  const warnings: string[] = [];
  let skipped = 0;

  blueprints.forEach((bp, idx) => {
    try {
      const tpl = extractBalancerFromBlueprint(bp, idx);
      if (tpl) {
        balancers.push(tpl);
      } else {
        skipped++;
      }
    } catch (err) {
      skipped++;
      warnings.push(`Skipped "${bp.label ?? idx}": ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  return { balancers, skipped, warnings };
}
