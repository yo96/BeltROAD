import {
  AllInserterKind,
  DesignSpec,
  Dir,
  EntityInstance,
  FloorplanResult,
  InserterTier,
  PerimeterPin,
  RouteResult,
} from '../types.js';
import { BELT_SPECS, INSERTER_SPECS } from '../data/entities.js';

function pickHeaderInserterName(spec: DesignSpec): string {
  const prefOrder: InserterTier[] = ['stack', 'bulk', 'fast', 'yellow'];
  for (const t of prefOrder) {
    if (spec.pdk.allowedInserterTiers.includes(t)) {
      return INSERTER_SPECS[t as AllInserterKind].name;
    }
  }
  return INSERTER_SPECS[spec.pdk.defaultInserterTier].name;
}

/**
 * Expands the finalized die with an organized perimeter header apron:
 * - `'bus-header'`: extends aligned bus-grouped pins out across a 5-tile W/E (4-tile N/S) apron.
 * - `'train-station'`: adds Factorio even-grid vertical `straight-rail` unloading (W) &
 *   loading (E) bays with `train-stop` headers, `steel-chest` buffers, inserters, and fluid pipes.
 */
export function applyPerimeterHeader(
  floorplan: FloorplanResult,
  route: RouteResult,
  spec: DesignSpec,
): { floorplan: FloorplanResult; route: RouteResult } {
  const mode = spec.floorplan.headerMode ?? 'none';
  if (mode === 'none') {
    return { floorplan, route };
  }

  const hasW = floorplan.pins.some((p) => p.edge === 'W');
  const hasE = floorplan.pins.some((p) => p.edge === 'E');
  const hasN = floorplan.pins.some((p) => p.edge === 'N');
  const hasS = floorplan.pins.some((p) => p.edge === 'S');

  let leftApron = 0;
  let rightApron = 0;
  let topApron = 0;
  let botApron = 0;
  let eastRailX = -1;

  if (mode === 'bus-header') {
    leftApron = hasW ? 5 : 0;
    rightApron = hasE ? 5 : 0;
    topApron = hasN ? 4 : 0;
    botApron = hasS ? 4 : 0;
  } else {
    leftApron = hasW ? 8 : 0;
    topApron = hasN ? 4 : 0;
    botApron = hasS ? 4 : 0;
    const baseRight = leftApron + floorplan.width;
    if (hasE) {
      eastRailX = (baseRight + 4) % 2 === 0 ? baseRight + 4 : baseRight + 5;
      rightApron = eastRailX + 4 - baseRight;
    }
  }

  const newW = leftApron + floorplan.width + rightApron;
  let newH = topApron + floorplan.height + botApron;
  if (mode === 'train-station' && (hasW || hasE) && newH % 2 === 1) {
    newH += 1;
  }
  const baseRight = leftApron + floorplan.width;

  const shiftedMacros = floorplan.macros.map((pm) => ({
    ...pm,
    x: pm.x + leftApron,
    y: pm.y + topApron,
  }));

  const shiftedRouteEnts: EntityInstance[] = route.entities.map((e) => ({
    ...e,
    tx: e.tx + leftApron,
    ty: e.ty + topApron,
  }));

  const shiftedNets = route.routedNets.map((rn) => ({
    ...rn,
    tiles: rn.tiles.map((t) => ({
      ...t,
      tx: t.tx + leftApron,
      ty: t.ty + topApron,
    })),
  }));

  const headerEnts: EntityInstance[] = [];
  let hid = 0;
  const eid = (p: string) => `hdr:${p}:${hid++}`;

  const addLeadTile = (
    tx: number,
    ty: number,
    pin: PerimeterPin,
    dir: Dir,
  ) => {
    if (pin.isFluid) {
      headerEnts.push({
        id: eid('hp'),
        name: 'pipe',
        tx,
        ty,
        w: 1,
        h: 1,
        direction: Dir.NORTH,
        netId: pin.netId,
        item: pin.item,
        role: 'pipe-route',
      });
    } else {
      headerEnts.push({
        id: eid('hb'),
        name: BELT_SPECS[pin.beltTier].beltName,
        tx,
        ty,
        w: 1,
        h: 1,
        direction: dir,
        netId: pin.netId,
        item: pin.item,
        role: 'belt-route',
      });
    }
  };

  if (mode === 'train-station') {
    const insName = pickHeaderInserterName(spec);
    if (hasW) {
      for (let ry = 0; ry + 1 < newH; ry += 2) {
        headerEnts.push({
          id: eid('railw'),
          name: 'straight-rail',
          tx: 2,
          ty: ry,
          w: 2,
          h: 2,
          direction: Dir.NORTH,
          role: 'header',
        });
      }
      headerEnts.push({
        id: eid('stopw'),
        name: 'train-stop',
        tx: 0,
        ty: 0,
        w: 2,
        h: 2,
        direction: Dir.SOUTH,
        station: `[BeltROAD] ${spec.name} IN`,
        role: 'header',
      });
    }
    if (hasE && eastRailX >= 0) {
      for (let ry = 0; ry + 1 < newH; ry += 2) {
        headerEnts.push({
          id: eid('raile'),
          name: 'straight-rail',
          tx: eastRailX,
          ty: ry,
          w: 2,
          h: 2,
          direction: Dir.NORTH,
          role: 'header',
        });
      }
      headerEnts.push({
        id: eid('stope'),
        name: 'train-stop',
        tx: eastRailX + 2,
        ty: 0,
        w: 2,
        h: 2,
        direction: Dir.NORTH,
        station: `[BeltROAD] ${spec.name} OUT`,
        role: 'header',
      });
    }

    const updatedPins: PerimeterPin[] = floorplan.pins.map((pin) => {
      const oldX = pin.x + leftApron;
      const oldY = pin.y + topApron;

      if (pin.edge === 'W') {
        if (pin.isFluid) {
          for (let x = 4; x < oldX; x++) {
            addLeadTile(x, oldY, pin, pin.dir);
          }
        } else {
          const insDir = pin.kind === 'input' ? Dir.WEST : Dir.EAST;
          headerEnts.push({
            id: eid('iw0'),
            name: insName,
            tx: 4,
            ty: oldY,
            w: 1,
            h: 1,
            direction: insDir,
            role: 'header',
          });
          headerEnts.push({
            id: eid('cw'),
            name: 'steel-chest',
            tx: 5,
            ty: oldY,
            w: 1,
            h: 1,
            direction: Dir.NORTH,
            item: pin.item,
            role: 'header',
          });
          headerEnts.push({
            id: eid('iw1'),
            name: insName,
            tx: 6,
            ty: oldY,
            w: 1,
            h: 1,
            direction: insDir,
            role: 'header',
          });
          for (let x = 7; x < oldX; x++) {
            addLeadTile(x, oldY, pin, pin.dir);
          }
        }
        return { ...pin, x: 0, y: oldY, offset: oldY };
      }

      if (pin.edge === 'E' && eastRailX >= 0) {
        if (pin.isFluid) {
          for (let x = oldX + 1; x < eastRailX; x++) {
            addLeadTile(x, oldY, pin, pin.dir);
          }
        } else {
          const insDir = pin.kind === 'output' ? Dir.WEST : Dir.EAST;
          for (let x = oldX + 1; x <= eastRailX - 4; x++) {
            addLeadTile(x, oldY, pin, pin.dir);
          }
          headerEnts.push({
            id: eid('ie0'),
            name: insName,
            tx: eastRailX - 3,
            ty: oldY,
            w: 1,
            h: 1,
            direction: insDir,
            role: 'header',
          });
          headerEnts.push({
            id: eid('ce'),
            name: 'steel-chest',
            tx: eastRailX - 2,
            ty: oldY,
            w: 1,
            h: 1,
            direction: Dir.NORTH,
            item: pin.item,
            role: 'header',
          });
          headerEnts.push({
            id: eid('ie1'),
            name: insName,
            tx: eastRailX - 1,
            ty: oldY,
            w: 1,
            h: 1,
            direction: insDir,
            role: 'header',
          });
        }
        return { ...pin, x: newW - 1, y: oldY, offset: oldY };
      }

      if (pin.edge === 'N') {
        for (let y = 0; y < oldY; y++) {
          addLeadTile(oldX, y, pin, pin.dir);
        }
        return { ...pin, x: oldX, y: 0, offset: oldX };
      }

      // South
      for (let y = oldY + 1; y < newH; y++) {
        addLeadTile(oldX, y, pin, pin.dir);
      }
      return { ...pin, x: oldX, y: newH - 1, offset: oldX };
    });

    return {
      floorplan: {
        ...floorplan,
        width: newW,
        height: newH,
        macros: shiftedMacros,
        pins: updatedPins,
      },
      route: {
        ...route,
        width: newW,
        height: newH,
        routedNets: shiftedNets,
        entities: [...shiftedRouteEnts, ...headerEnts],
      },
    };
  }

  // 'bus-header' mode: extend aligned perimeter lead-in / lead-out aprons
  const updatedPins: PerimeterPin[] = floorplan.pins.map((pin) => {
    const oldX = pin.x + leftApron;
    const oldY = pin.y + topApron;

    if (pin.edge === 'W') {
      for (let x = 0; x < oldX; x++) {
        addLeadTile(x, oldY, pin, pin.dir);
      }
      return { ...pin, x: 0, y: oldY, offset: oldY };
    }
    if (pin.edge === 'E') {
      for (let x = oldX + 1; x < newW; x++) {
        addLeadTile(x, oldY, pin, pin.dir);
      }
      return { ...pin, x: newW - 1, y: oldY, offset: oldY };
    }
    if (pin.edge === 'N') {
      for (let y = 0; y < oldY; y++) {
        addLeadTile(oldX, y, pin, pin.dir);
      }
      return { ...pin, x: oldX, y: 0, offset: oldX };
    }
    for (let y = oldY + 1; y < newH; y++) {
      addLeadTile(oldX, y, pin, pin.dir);
    }
    return { ...pin, x: oldX, y: newH - 1, offset: oldX };
  });

  return {
    floorplan: {
      ...floorplan,
      width: newW,
      height: newH,
      macros: shiftedMacros,
      pins: updatedPins,
    },
    route: {
      ...route,
      width: newW,
      height: newH,
      routedNets: shiftedNets,
      entities: [...shiftedRouteEnts, ...headerEnts],
    },
  };
}
