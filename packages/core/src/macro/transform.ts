import { CompiledMacro, Dir, EntityInstance, MacroPin, Rot90 } from '../types.js';
import { dirDelta, flipDirY, rotateDir } from '../geometry.js';

export function rotateBox(
  tx: number,
  ty: number,
  w: number,
  h: number,
  containerW: number,
  containerH: number,
  rot90: Rot90,
): { tx: number; ty: number; w: number; h: number } {
  if (rot90 === 0) return { tx, ty, w, h };
  if (rot90 === 1) {
    return { tx: containerH - (ty + h), ty: tx, w: h, h: w };
  }
  if (rot90 === 2) {
    return { tx: containerW - (tx + w), ty: containerH - (ty + h), w, h };
  }
  return { tx: ty, ty: containerW - (tx + w), w: h, h: w };
}

export function rotateMacro(macro: CompiledMacro, rot90: Rot90): CompiledMacro {
  if (rot90 === 0 && macro.rotation === 0) return macro;
  // Always rotate relative to the given macro by rot90 steps
  const W = macro.width;
  const H = macro.height;
  const newWidth = rot90 % 2 === 0 ? W : H;
  const newHeight = rot90 % 2 === 0 ? H : W;

  const entities: EntityInstance[] = macro.entities.map((ent) => {
    const rb = rotateBox(ent.tx, ent.ty, ent.w, ent.h, W, H, rot90);
    const isDirectional =
      ent.role !== 'machine' &&
      ent.role !== 'pole-macro' &&
      ent.role !== 'pole-pdn' &&
      ent.role !== 'port-marker';
    return {
      ...ent,
      tx: rb.tx,
      ty: rb.ty,
      w: rb.w,
      h: rb.h,
      direction: isDirectional ? rotateDir(ent.direction, rot90) : ent.direction,
    };
  });

  const pins: MacroPin[] = macro.pins.map((pin) => {
    const rp = rotateBox(pin.x, pin.y, 1, 1, W, H, rot90);
    const newDir = rotateDir(pin.direction, rot90);
    const { dx, dy } = dirDelta(newDir);
    const portX = pin.kind === 'input' ? rp.tx - dx : rp.tx + dx;
    const portY = pin.kind === 'input' ? rp.ty - dy : rp.ty + dy;
    return {
      ...pin,
      x: rp.tx,
      y: rp.ty,
      direction: newDir,
      portX,
      portY,
    };
  });

  const powerTargets = macro.powerTargets.map((pt) => {
    const rb = rotateBox(pt.tx, pt.ty, pt.w, pt.h, W, H, rot90);
    return { tx: rb.tx, ty: rb.ty, w: rb.w, h: rb.h };
  });

  return {
    ...macro,
    rotation: (((macro.rotation + rot90) % 4) as Rot90),
    width: newWidth,
    height: newHeight,
    entities,
    pins,
    powerTargets,
  };
}

export function mirrorMacroY(macro: CompiledMacro): CompiledMacro {
  const H = macro.height;

  const entities: EntityInstance[] = macro.entities.map((ent) => {
    const isDirectional =
      ent.role !== 'machine' &&
      ent.role !== 'pole-macro' &&
      ent.role !== 'pole-pdn' &&
      ent.role !== 'port-marker';
    return {
      ...ent,
      ty: H - (ent.ty + ent.h),
      direction: isDirectional ? flipDirY(ent.direction) : ent.direction,
      laneItems: ent.laneItems ? [ent.laneItems[1], ent.laneItems[0]] : undefined,
    };
  });

  const pins: MacroPin[] = macro.pins.map((pin) => {
    const newY = H - 1 - pin.y;
    const newDir = flipDirY(pin.direction);
    const { dx, dy } = dirDelta(newDir);
    const portX = pin.kind === 'input' ? pin.x - dx : pin.x + dx;
    const portY = pin.kind === 'input' ? newY - dy : newY + dy;
    return {
      ...pin,
      y: newY,
      direction: newDir,
      portX,
      portY,
    };
  });

  const powerTargets = macro.powerTargets.map((pt) => ({
    tx: pt.tx,
    ty: H - (pt.ty + pt.h),
    w: pt.w,
    h: pt.h,
  }));

  return {
    ...macro,
    flippedY: !macro.flippedY,
    entities,
    pins,
    powerTargets,
  };
}

export function pinOutsideOffset(x: number, y: number, dir: Dir, kind: 'input' | 'output') {
  const { dx, dy } = dirDelta(dir);
  return {
    portX: kind === 'input' ? x - dx : x + dx,
    portY: kind === 'input' ? y - dy : y + dy,
  };
}
