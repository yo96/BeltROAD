import {
  BalancerMacroSpec,
  BalancerTemplate,
  CompiledMacro,
  EntityInstance,
  MacroPin,
} from '../types.js';
import { BELT_SPECS } from '../data/entities.js';
import { selectBalancerTemplate } from '../data/balancers.js';
import { pinOutsideOffset } from './transform.js';

export function compileBalancerMacro(
  spec: BalancerMacroSpec,
  customBalancers: BalancerTemplate[] = [],
): CompiledMacro {
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
