import {
  BalancerEntityDef,
  BalancerPort,
  BalancerTemplate,
  BeltTier,
  Dir,
} from '../types.js';
import { BELT_SPECS } from './entities.js';

function belt(tx: number, ty: number, direction: Dir = Dir.EAST): BalancerEntityDef {
  return { tx, ty, w: 1, h: 1, kind: 'belt', direction };
}

function ug(
  tx: number,
  ty: number,
  ugType: 'input' | 'output',
  direction: Dir = Dir.EAST,
): BalancerEntityDef {
  return { tx, ty, w: 1, h: 1, kind: 'underground', direction, ugType };
}

function splitter(tx: number, ty: number, direction: Dir = Dir.EAST): BalancerEntityDef {
  const isNS = direction === Dir.NORTH || direction === Dir.SOUTH;
  return {
    tx,
    ty,
    w: isNS ? 2 : 1,
    h: isNS ? 1 : 2,
    kind: 'splitter',
    direction,
  };
}

function makePorts(xs: number, ys: number[], dir: Dir = Dir.EAST): BalancerPort[] {
  return ys.map((y) => ({ x: xs, y, dir }));
}

function createTemplate(
  id: string,
  name: string,
  inputs: number,
  outputs: number,
  width: number,
  height: number,
  entities: BalancerEntityDef[],
  inputPorts: BalancerPort[],
  outputPorts: BalancerPort[],
  source: 'builtin' | 'procedural' = 'builtin',
  beltTier: BeltTier = 'yellow',
): BalancerTemplate {
  return {
    id,
    name,
    inputs,
    outputs,
    width,
    height,
    beltTier,
    maxUgDistance: BELT_SPECS[beltTier].maxUgDistance,
    entities,
    inputPorts,
    outputPorts,
    source,
  };
}

function build1x2(): BalancerTemplate {
  const entities: BalancerEntityDef[] = [splitter(0, 0)];
  return createTemplate(
    'builtin-1x2',
    '1x2 Splitter',
    1,
    2,
    1,
    2,
    entities,
    makePorts(0, [0]),
    makePorts(0, [0, 1]),
  );
}

function build2x1(): BalancerTemplate {
  const entities: BalancerEntityDef[] = [splitter(0, 0)];
  return createTemplate(
    'builtin-2x1',
    '2x1 Merger',
    2,
    1,
    1,
    2,
    entities,
    makePorts(0, [0, 1]),
    makePorts(0, [0]),
  );
}

function build2x2(): BalancerTemplate {
  const entities: BalancerEntityDef[] = [splitter(0, 0)];
  return createTemplate(
    'builtin-2x2',
    '2x2 Balancer',
    2,
    2,
    1,
    2,
    entities,
    makePorts(0, [0, 1]),
    makePorts(0, [0, 1]),
  );
}

function build1x3(): BalancerTemplate {
  // Exact 1-to-3 loopback splitter (5x5, zero undergrounds)
  const entities: BalancerEntityDef[] = [
    belt(0, 1, Dir.EAST),
    // Loopback return path from (4,3) -> y=4 -> x=0 -> (0,2)
    belt(0, 2, Dir.EAST),
    belt(0, 3, Dir.NORTH),
    belt(0, 4, Dir.NORTH),
    belt(1, 4, Dir.WEST),
    belt(2, 4, Dir.WEST),
    belt(3, 4, Dir.WEST),
    belt(4, 4, Dir.WEST),
    splitter(1, 1, Dir.EAST),
    belt(2, 1, Dir.NORTH),
    belt(2, 0, Dir.EAST),
    belt(2, 2, Dir.EAST),
    splitter(3, 0, Dir.EAST),
    splitter(3, 2, Dir.EAST),
    belt(4, 0, Dir.EAST),
    belt(4, 1, Dir.EAST),
    belt(4, 2, Dir.EAST),
    belt(4, 3, Dir.SOUTH),
  ];
  return createTemplate(
    'builtin-1x3',
    '1x3 Balanced Splitter',
    1,
    3,
    5,
    5,
    entities,
    makePorts(0, [1]),
    makePorts(4, [0, 1, 2]),
  );
}

function build1x4(): BalancerTemplate {
  // Binary 1-to-4 tree (3x4, direct splitter mouths)
  const entities: BalancerEntityDef[] = [
    splitter(0, 1),
    belt(1, 1, Dir.NORTH),
    belt(1, 0, Dir.EAST),
    belt(1, 2, Dir.SOUTH),
    belt(1, 3, Dir.EAST),
    splitter(2, 0),
    splitter(2, 2),
  ];
  return createTemplate(
    'builtin-1x4',
    '1x4 Balanced Splitter',
    1,
    4,
    3,
    4,
    entities,
    makePorts(0, [1]),
    makePorts(2, [0, 1, 2, 3]),
  );
}

function build4x1(): BalancerTemplate {
  // Balanced 4-to-1 binary merger (2x4, direct splitter backs/mouths)
  const entities: BalancerEntityDef[] = [
    splitter(0, 0),
    splitter(0, 2),
    splitter(1, 1),
  ];
  return createTemplate(
    'builtin-4x1',
    '4x1 Balanced Merger',
    4,
    1,
    2,
    4,
    entities,
    makePorts(0, [0, 1, 2, 3]),
    makePorts(1, [1]),
  );
}

/**
 * Classic 4x4 Throughput-Unlimited Factorio balancer (10x4).
 * Core occupies x=1..8, y=0..3, with explicit port belts at x=0 and x=9.
 */
function build4x4CoreEntities(offsetX: number): BalancerEntityDef[] {
  const x = (dx: number) => offsetX + dx;
  return [
    // Stage 1 splitters
    splitter(x(0), 0),
    splitter(x(0), 2),
    // Stage 2: outer straight, inner mix
    belt(x(1), 0),
    splitter(x(1), 1),
    belt(x(1), 3),
    // Stage 3: outer straight, inner underground under outer merge
    belt(x(2), 0),
    ug(x(2), 1, 'input', Dir.EAST),
    ug(x(2), 2, 'input', Dir.EAST),
    belt(x(2), 3),
    // Outer lanes curve inward over inner undergrounds
    belt(x(3), 0, Dir.SOUTH),
    belt(x(3), 1, Dir.EAST),
    belt(x(3), 2, Dir.EAST),
    belt(x(3), 3, Dir.NORTH),
    // Central outer-pair splitter
    splitter(x(4), 1),
    // Inner pair diverges back to outer lanes
    belt(x(5), 1, Dir.NORTH),
    belt(x(5), 0, Dir.EAST),
    belt(x(5), 2, Dir.SOUTH),
    belt(x(5), 3, Dir.EAST),
    // Underground exits
    belt(x(6), 0),
    ug(x(6), 1, 'output', Dir.EAST),
    ug(x(6), 2, 'output', Dir.EAST),
    belt(x(6), 3),
    // Final output stage splitters
    splitter(x(7), 0),
    splitter(x(7), 2),
  ];
}

function build4x4(): BalancerTemplate {
  const entities: BalancerEntityDef[] = [...build4x4CoreEntities(0)];
  return createTemplate(
    'builtin-4x4',
    '4x4 TU Balancer',
    4,
    4,
    8,
    4,
    entities,
    makePorts(0, [0, 1, 2, 3]),
    makePorts(7, [0, 1, 2, 3]),
  );
}

function build3x3(): BalancerTemplate {
  // 4x4 TU core with lane 3 looped back along y=4 (10x5)
  const entities: BalancerEntityDef[] = [
    belt(0, 0),
    belt(0, 1),
    belt(0, 2),
    belt(0, 3), // fed by (0,4) N
    ...build4x4CoreEntities(1),
    belt(9, 0),
    belt(9, 1),
    belt(9, 2),
    belt(9, 3, Dir.SOUTH),
    belt(9, 4, Dir.WEST),
    belt(8, 4, Dir.WEST),
    belt(7, 4, Dir.WEST),
    belt(6, 4, Dir.WEST),
    belt(5, 4, Dir.WEST),
    belt(4, 4, Dir.WEST),
    belt(3, 4, Dir.WEST),
    belt(2, 4, Dir.WEST),
    belt(1, 4, Dir.WEST),
    belt(0, 4, Dir.NORTH),
  ];
  return createTemplate(
    'builtin-3x3',
    '3x3 Balanced',
    3,
    3,
    10,
    5,
    entities,
    makePorts(0, [0, 1, 2]),
    makePorts(9, [0, 1, 2]),
  );
}

function build2x4(): BalancerTemplate {
  // 2 inputs -> 2x2 mixer -> fan out to 4 outputs (3x4, direct splitter mouths)
  const entities: BalancerEntityDef[] = [
    splitter(0, 1),
    belt(1, 1, Dir.NORTH),
    belt(1, 0, Dir.EAST),
    belt(1, 2, Dir.SOUTH),
    belt(1, 3, Dir.EAST),
    splitter(2, 0),
    splitter(2, 2),
  ];
  return createTemplate(
    'builtin-2x4',
    '2x4 Balanced Splitter',
    2,
    4,
    3,
    4,
    entities,
    makePorts(0, [1, 2]),
    makePorts(2, [0, 1, 2, 3]),
  );
}

function build4x2(): BalancerTemplate {
  // 4 inputs -> 4x4 TU core -> merge pairs (10x4)
  const entities: BalancerEntityDef[] = [
    ...build4x4CoreEntities(0),
    belt(8, 0),
    belt(8, 1),
    belt(8, 2),
    belt(8, 3),
    splitter(9, 0),
    splitter(9, 2),
  ];
  return createTemplate(
    'builtin-4x2',
    '4x2 Balanced Merger',
    4,
    2,
    10,
    4,
    entities,
    makePorts(0, [0, 1, 2, 3]),
    makePorts(9, [0, 2]),
  );
}

function build3x4(): BalancerTemplate {
  // 4x4 TU core with 3 inputs on 0..2 and 4th input empty (8x4)
  const entities: BalancerEntityDef[] = [...build4x4CoreEntities(0)];
  return createTemplate(
    'builtin-3x4',
    '3x4 Balanced',
    3,
    4,
    8,
    4,
    entities,
    makePorts(0, [0, 1, 2]),
    makePorts(7, [0, 1, 2, 3]),
  );
}

function build4x3(): BalancerTemplate {
  // 4x4 TU core with lane 3 output looped back to? Wait: all 4 inputs are used,
  // so 3x3 loopback wouldn't have a free input slot! Instead, feed 4 inputs through
  // 4x4 TU core, then split lane 3 into 3? Wait: if output 3 loops back? No, 4 inputs already fill input 0..3.
  // Use general procedural odd-even mixer + 1 merger!
  return generateProceduralBalancer(4, 3, 'yellow', 'builtin-4x3', '4x3 Balanced');
}

function build2x3(): BalancerTemplate {
  return generateProceduralBalancer(2, 3, 'yellow', 'builtin-2x3', '2x3 Balanced');
}

function build3x2(): BalancerTemplate {
  return generateProceduralBalancer(3, 2, 'yellow', 'builtin-3x2', '3x2 Balanced');
}

function build3x1(): BalancerTemplate {
  // Compact 2x3 3-to-1 merger (direct splitter backs/mouths)
  const entities: BalancerEntityDef[] = [
    splitter(0, 0),
    belt(0, 2),
    splitter(1, 1),
  ];
  return createTemplate(
    'builtin-3x1',
    '3x1 Compact Merger',
    3,
    1,
    2,
    3,
    entities,
    makePorts(0, [0, 1, 2]),
    makePorts(1, [1]),
  );
}

/**
 * Procedural N x M splitter-network generator.
 * Uses odd-even adjacent splitter stages with explicit fan-out / fan-in so
 * ANY N x M size is generated with zero collisions, zero undergrounds, and
 * zero accidental side-loading.
 */
export function generateProceduralBalancer(
  inputs: number,
  outputs: number,
  beltTier: BeltTier = 'yellow',
  id?: string,
  name?: string,
): BalancerTemplate {
  const L = Math.max(inputs, outputs, 2);
  const entities: BalancerEntityDef[] = [];
  let x = 0;

  // If inputs < L, fan out active lanes downward via cascading splitters
  if (inputs < L) {
    let active = inputs;
    while (active < L) {
      const splitUsed = new Set<number>();
      const startRow = Math.max(0, active - 1);
      entities.push(splitter(x, startRow, Dir.EAST));
      splitUsed.add(startRow);
      splitUsed.add(startRow + 1);
      for (let y = 0; y < active; y++) {
        if (!splitUsed.has(y)) {
          entities.push(belt(x, y, Dir.EAST));
        }
      }
      active++;
      x++;
    }
  }

  // Mixing network: skip redundant stages when 1-to-N or N-to-1; keep N-to-M compact
  const numStages =
    inputs === 1 || outputs === 1 ? 0 : L <= 2 ? 1 : L === 3 ? 2 : Math.min(L, 4);
  for (let s = 0; s < numStages; s++) {
    const startParity = s % 2;
    const occupied = new Set<number>();
    for (let y = startParity; y + 1 < L; y += 2) {
      entities.push(splitter(x, y, Dir.EAST));
      occupied.add(y);
      occupied.add(y + 1);
    }
    for (let y = 0; y < L; y++) {
      if (!occupied.has(y)) {
        entities.push(belt(x, y, Dir.EAST));
      }
    }
    x++;
  }

  // If outputs < L, merge extra trailing lanes upward into 0..outputs-1
  if (outputs < L) {
    let active = L;
    while (active > outputs) {
      const mergeRow = active - 2; // merges [active-2, active-1]
      const occupied = new Set<number>();
      entities.push(splitter(x, mergeRow, Dir.EAST));
      occupied.add(mergeRow);
      occupied.add(mergeRow + 1);
      for (let y = 0; y < active; y++) {
        if (!occupied.has(y)) {
          entities.push(belt(x, y, Dir.EAST));
        }
      }
      active--;
      x++;
    }
  }

  if (x === 0) {
    entities.push(belt(0, 0, Dir.EAST));
    x = 1;
  }
  const width = Math.max(1, x);

  return createTemplate(
    id ?? `proc-${inputs}x${outputs}`,
    name ?? `${inputs}x${outputs} Balancer`,
    inputs,
    outputs,
    width,
    L,
    entities,
    makePorts(0, Array.from({ length: inputs }, (_, i) => i)),
    makePorts(width - 1, Array.from({ length: outputs }, (_, i) => i)),
    'procedural',
    beltTier,
  );
}

export const BUILTIN_BALANCERS: BalancerTemplate[] = [
  build1x2(),
  build2x1(),
  build2x2(),
  build1x3(),
  build3x1(),
  build1x4(),
  build4x1(),
  build2x3(),
  build3x2(),
  build2x4(),
  build4x2(),
  build3x3(),
  build3x4(),
  build4x3(),
  build4x4(),
];

export function remapBalancerTier(
  template: BalancerTemplate,
  targetTier: BeltTier,
): BalancerTemplate {
  const targetMaxDist = BELT_SPECS[targetTier].maxUgDistance;
  // Check underground spans inside template against target tier max distance
  if (template.beltTier !== targetTier) {
    // Verify no underground pair exceeds targetMaxDist
    const ugs = template.entities.filter((e) => e.kind === 'underground');
    for (const u of ugs) {
      if (u.ugType !== 'input') continue;
      // Find partner along u.direction
      const dx = u.direction === Dir.EAST ? 1 : u.direction === Dir.WEST ? -1 : 0;
      const dy = u.direction === Dir.SOUTH ? 1 : u.direction === Dir.NORTH ? -1 : 0;
      let dist = Infinity;
      for (let step = 1; step <= 12; step++) {
        const px = u.tx + dx * step;
        const py = u.ty + dy * step;
        const match = ugs.find(
          (o) => o.tx === px && o.ty === py && o.direction === u.direction && o.ugType === 'output',
        );
        if (match) {
          dist = step;
          break;
        }
      }
      if (dist > targetMaxDist) {
        // Fallback to procedural balancer compatible with any tier
        return generateProceduralBalancer(
          template.inputs,
          template.outputs,
          targetTier,
          `${template.id}-${targetTier}-fallback`,
          template.name,
        );
      }
    }
  }

  return {
    ...template,
    beltTier: targetTier,
    maxUgDistance: targetMaxDist,
  };
}

export function selectBalancerTemplate(
  inputs: number,
  outputs: number,
  targetTier: BeltTier,
  customBalancers: BalancerTemplate[] = [],
): BalancerTemplate {
  // Prefer user-imported custom balancers matching exact (inputs, outputs)
  const custom = customBalancers.find((b) => b.inputs === inputs && b.outputs === outputs);
  if (custom) {
    return remapBalancerTier(custom, targetTier);
  }

  const builtin = BUILTIN_BALANCERS.find((b) => b.inputs === inputs && b.outputs === outputs);
  if (builtin) {
    return remapBalancerTier(builtin, targetTier);
  }

  return generateProceduralBalancer(inputs, outputs, targetTier);
}
