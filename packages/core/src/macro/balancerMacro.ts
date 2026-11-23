import {
  BalancerMacroSpec,
  BalancerTemplate,
  CompiledMacro,
  EntityInstance,
  MacroPin,
} from '../types.js';
import { BELT_SPECS } from '../data/entities.js';
import { getItemMeta } from '../data/catalog.js';
import { selectBalancerTemplate } from '../data/balancers.js';
import { pinOutsideOffset } from './transform.js';

function compilePipeManifold(spec: BalancerMacroSpec): CompiledMacro {
  const S = Math.max(1, spec.inputs);
  const D = Math.max(1, spec.outputs);
  const maxPorts = Math.max(S, D);
  const height = Math.max(3, maxPorts * 2 - 1);
  const width = 2;
  const meta = getItemMeta(spec.item);

  const entities: EntityInstance[] = [];
  const pins: MacroPin[] = [];
  let pid = 0;

  for (let y = 0; y < height; y++) {
    entities.push({
      id: `${spec.id}:pm:${pid++}`,
      name: 'pipe',
      tx: 1,
      ty: y,
      w: 1,
      h: 1,
      direction: 0,
      macroId: spec.id,
      item: spec.item,
      role: 'pipe-macro',
    });
  }

  const inRate = spec.totalRatePerSec / S;
  const outRate = spec.totalRatePerSec / D;

  for (let i = 0; i < S; i++) {
    const iy = S === 1 ? Math.floor((height - 1) / 2) : i * 2;
    entities.push({
      id: `${spec.id}:pm:${pid++}`,
      name: 'pipe',
      tx: 0,
      ty: iy,
      w: 1,
      h: 1,
      direction: 0,
      macroId: spec.id,
      item: spec.item,
      role: 'pipe-macro',
    });
    const out = pinOutsideOffset(0, iy, 4, 'input'); // Dir.EAST = 4
    pins.push({
      id: `in:${i}`,
      item: spec.item,
      direction: 4,
      kind: 'input',
      x: 0,
      y: iy,
      portX: out.portX,
      portY: out.portY,
      ratePerSec: inRate,
      beltTier: spec.beltTier,
      isFluid: true,
    });
  }

  for (let j = 0; j < D; j++) {
    const oy = j * 2;
    const out = pinOutsideOffset(1, oy, 4, 'output'); // Dir.EAST = 4
    pins.push({
      id: `out:${j}`,
      item: spec.item,
      direction: 4,
      kind: 'output',
      x: 1,
      y: oy,
      portX: out.portX,
      portY: out.portY,
      ratePerSec: outRate,
      beltTier: spec.beltTier,
      isFluid: true,
    });
  }

  return {
    id: spec.id,
    kind: 'balancer-macro',
    label: `${meta.name} Pipe Manifold`,
    sublabel: `${S}→${D} Pipe`,
    outputItem: spec.item,
    rows: 1,
    width,
    height,
    rotation: 0,
    noFlipY: true,
    entities,
    pins,
    powerTargets: [],
  };
}

export function compileBalancerMacro(
  spec: BalancerMacroSpec,
  customBalancers: BalancerTemplate[] = [],
): CompiledMacro {
  if (spec.isFluid || spec.templateId.startsWith('pipe-manifold:')) {
    return compilePipeManifold(spec);
  }
  const tpl = selectBalancerTemplate(
    spec.inputs,
    spec.outputs,
    spec.beltTier,
    customBalancers,
  );
  const beltSpec = BELT_SPECS[tpl.beltTier];

  const entities: EntityInstance[] = tpl.entities.map((e, i) => {
    const name =
      e.kind === 'belt'
        ? beltSpec.beltName
        : e.kind === 'underground'
          ? beltSpec.undergroundName
          : beltSpec.splitterName;
    return {
      id: `${spec.id}:b:${i}`,
      name,
      tx: e.tx,
      ty: e.ty,
      w: e.w,
      h: e.h,
      direction: e.direction,
      type: e.ugType,
      macroId: spec.id,
      item: spec.item,
      role: 'balancer',
    };
  });

  const pins: MacroPin[] = [];
  const inRate = spec.totalRatePerSec / Math.max(1, spec.inputs);
  const outRate = spec.totalRatePerSec / Math.max(1, spec.outputs);

  tpl.inputPorts.forEach((p, idx) => {
    const out = pinOutsideOffset(p.x, p.y, p.dir, 'input');
    pins.push({
      id: `in:${idx}`,
      item: spec.item,
      direction: p.dir,
      kind: 'input',
      x: p.x,
      y: p.y,
      portX: out.portX,
      portY: out.portY,
      ratePerSec: inRate,
      beltTier: tpl.beltTier,
    });
  });

  tpl.outputPorts.forEach((p, idx) => {
    const out = pinOutsideOffset(p.x, p.y, p.dir, 'output');
    pins.push({
      id: `out:${idx}`,
      item: spec.item,
      direction: p.dir,
      kind: 'output',
      x: p.x,
      y: p.y,
      portX: out.portX,
      portY: out.portY,
      ratePerSec: outRate,
      beltTier: tpl.beltTier,
    });
  });

  return {
    id: spec.id,
    kind: 'balancer-macro',
    label: `${spec.inputs}×${spec.outputs} Bal`,
    sublabel: spec.item,
    outputItem: spec.item,
    rows: 1,
    width: tpl.width,
    height: tpl.height,
    rotation: 0,
    entities,
    pins,
    powerTargets: [],
  };
}
