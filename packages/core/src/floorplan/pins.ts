import {
  DesignSpec,
  Edge,
  PerimeterPin,
  PinConstraint,
  PlacedMacro,
  SynthInputNode,
  SynthNet,
  SynthOutputNode,
  SynthesisResult,
} from '../types.js';
import { edgeToInwardDir, edgeToOutwardDir } from '../geometry.js';

function matchConstraint(
  node: SynthInputNode | SynthOutputNode,
  constraints: PinConstraint[],
): PinConstraint | undefined {
  // 1. Exact pin ID match
  const exact = constraints.find((c) => c.id && c.id === node.id);
  if (exact) return exact;

  // 2. Bus match ("in:iron-plate", "out:electronic-circuit", or bare "iron-plate")
  const prefix = node.kind === 'primary-input' ? 'in:' : 'out:';
  const fullBus = `${prefix}${node.item}`;
  return constraints.find(
    (c) => !c.id && c.bus && (c.bus === fullBus || c.bus === node.item),
  );
}

export function minEdgeLengthForPins(pinCount: number, pitch = 2, cornerPad = 2): number {
  if (pinCount <= 0) return 16;
  return Math.max(16, cornerPad * 2 + (pinCount - 1) * pitch + 2);
}

export function resolvePerimeterPins(
  synth: SynthesisResult,
  spec: DesignSpec,
  width: number,
  height: number,
): { pins: PerimeterPin[]; warnings: string[] } {
  const warnings: string[] = [];
  const ioNodes = synth.nodes.filter(
    (n): n is SynthInputNode | SynthOutputNode =>
      n.kind === 'primary-input' || n.kind === 'primary-output',
  );

  const netByEndpoint = new Map<string, SynthNet>();
  for (const net of synth.nets) {
    if (net.source.nodeId.startsWith('in:')) {
      netByEndpoint.set(net.source.nodeId, net);
    }
    if (net.sink.nodeId.startsWith('out:')) {
      netByEndpoint.set(net.sink.nodeId, net);
    }
  }

  interface DraftPin {
    node: SynthInputNode | SynthOutputNode;
    edge: Edge;
    order: number;
    fixedOffset?: number;
    locked: boolean;
    busKey: string;
  }

  const drafts: DraftPin[] = [];
  let autoOrder = 0;

  for (const node of ioNodes) {
    const c = matchConstraint(node, spec.pins);
    const defaultEdge: Edge = node.kind === 'primary-input' ? 'W' : 'E';
    const edge: Edge = c?.edge ?? defaultEdge;
    let fixedOffset: number | undefined;
    if (c?.offset !== undefined) {
      fixedOffset = c.id
        ? Math.round(c.offset)
        : Math.round(c.offset) + node.busIndex * 2;
    }

    drafts.push({
      node,
      edge,
      order: c?.order !== undefined ? c.order * 100 + node.busIndex : 10000 + autoOrder++,
      fixedOffset,
      locked: Boolean(c?.locked || c?.offset !== undefined),
      busKey: `${node.kind}:${node.item}`,
    });
  }

  // Overflow unconstrained pins onto N/S if W or E is over-capacity
  const edgeLimit = (e: Edge) => (e === 'W' || e === 'E' ? height : width) - 4;
  const countOnEdge = (e: Edge) => drafts.filter((d) => d.edge === e).length;

  for (const d of drafts) {
    const c = matchConstraint(d.node, spec.pins);
    if (c?.edge) continue; // Respect explicit user edge
    const maxSlots = Math.max(1, Math.floor(edgeLimit(d.edge) / 2));
    if (countOnEdge(d.edge) > maxSlots) {
      const altEdges: Edge[] = d.node.kind === 'primary-input' ? ['N', 'S'] : ['S', 'N'];
      for (const alt of altEdges) {
        const altMax = Math.max(1, Math.floor(edgeLimit(alt) / 2));
        if (countOnEdge(alt) < altMax) {
          d.edge = alt;
          break;
        }
      }
    }
  }

  const pins: PerimeterPin[] = [];

  for (const edge of ['W', 'E', 'N', 'S'] as Edge[]) {
    const edgeDrafts = drafts.filter((d) => d.edge === edge);
    if (edgeDrafts.length === 0) continue;

    const edgeLen = edge === 'W' || edge === 'E' ? height : width;
    const minOff = 1;
    const maxOff = Math.max(1, edgeLen - 2);
    const used = new Set<number>();
    const usedFluid = new Set<number>();

    const fixed = edgeDrafts.filter((d) => d.fixedOffset !== undefined);
    const floating = edgeDrafts
      .filter((d) => d.fixedOffset === undefined)
      .sort((a, b) => a.order - b.order || a.node.busIndex - b.node.busIndex);

    const assigned = new Map<DraftPin, number>();

    for (const d of fixed) {
      let off = Math.max(minOff, Math.min(maxOff, d.fixedOffset!));
      if (used.has(off)) {
        warnings.push(`Pin "${d.node.id}" offset ${off} on edge ${edge} collides with another pin; nudged.`);
        for (let delta = 1; delta < edgeLen; delta++) {
          if (off + delta <= maxOff && !used.has(off + delta)) {
            off = off + delta;
            break;
          }
          if (off - delta >= minOff && !used.has(off - delta)) {
            off = off - delta;
            break;
          }
        }
      }
      used.add(off);
      if (d.node.isFluid) usedFluid.add(off);
      assigned.set(d, off);
    }

    if (floating.length > 0) {
      // Calculate required slots with 2-tile intra-bus pitch and 3-tile inter-bus pitch
      let totalSpan = 0;
      for (let i = 0; i < floating.length; i++) {
        if (i > 0) {
          totalSpan += floating[i].busKey === floating[i - 1].busKey ? 2 : 3;
        }
      }
      const usableStart = Math.min(maxOff, 2);
      const usableEnd = Math.max(usableStart, edgeLen - 3);
      const avail = usableEnd - usableStart;
      const pitchInter = totalSpan <= avail ? 3 : 2;

      const compactSpan = floating.reduce((acc, d, i) => {
        if (i === 0) return 0;
        return acc + (d.busKey === floating[i - 1].busKey ? 2 : pitchInter);
      }, 0);

      let cursor = Math.max(
        usableStart,
        Math.floor((edgeLen - 1 - compactSpan) / 2),
      );

      for (let i = 0; i < floating.length; i++) {
        if (i > 0) {
          cursor += floating[i].busKey === floating[i - 1].busKey ? 2 : pitchInter;
        }
        const isFl = Boolean(floating[i].node.isFluid);
        // Find nearest free offset avoiding direct adjacency with fixed pins and any fluid-fluid adjacency
        let off = Math.max(minOff, Math.min(maxOff, cursor));
        while (
          off <= maxOff &&
          (used.has(off) ||
            used.has(off - 1) ||
            used.has(off + 1) ||
            (isFl && (usedFluid.has(off - 1) || usedFluid.has(off + 1))))
        ) {
          off++;
        }
        if (off > maxOff) {
          off = minOff;
          while (
            off <= maxOff &&
            (used.has(off) ||
              (isFl && (usedFluid.has(off - 1) || usedFluid.has(off + 1))))
          ) {
            off++;
          }
          if (off > maxOff) {
            off = minOff;
            while (off <= maxOff && used.has(off)) off++;
          }
        }
        off = Math.min(maxOff, off);
        used.add(off);
        if (isFl) usedFluid.add(off);
        assigned.set(floating[i], off);
        cursor = off;
      }
    }

    for (const d of edgeDrafts) {
      const off = assigned.get(d)!;
      const x = edge === 'W' ? 0 : edge === 'E' ? width - 1 : off;
      const y = edge === 'N' ? 0 : edge === 'S' ? height - 1 : off;
      const dir =
        d.node.kind === 'primary-input'
          ? edgeToInwardDir(edge)
          : edgeToOutwardDir(edge);
      const net = netByEndpoint.get(d.node.id);

      pins.push({
        id: d.node.id,
        busId: `${d.node.kind === 'primary-input' ? 'in' : 'out'}:${d.node.item}`,
        busIndex: d.node.busIndex,
        kind: d.node.kind === 'primary-input' ? 'input' : 'output',
        item: d.node.item,
        ratePerSec: d.node.ratePerSec,
        beltTier: d.node.beltTier,
        isFluid: d.node.isFluid,
        isByproduct: d.node.kind === 'primary-output' ? d.node.isByproduct : undefined,
        edge,
        offset: off,
        x,
        y,
        dir,
        order: d.order,
        locked: d.locked,
        netId: net?.id,
      });
    }
  }

  return { pins, warnings };
}

/**
 * Pool Adjacent Violators Algorithm (PAVA) for non-decreasing isotonic regression.
 */
function isotonicNonDecreasing(values: number[]): number[] {
  const blocks: Array<{ sum: number; count: number }> = [];
  for (const v of values) {
    blocks.push({ sum: v, count: 1 });
    while (blocks.length >= 2) {
      const a = blocks[blocks.length - 2];
      const b = blocks[blocks.length - 1];
      if (a.sum / a.count <= b.sum / b.count) break;
      blocks.pop();
      a.sum += b.sum;
      a.count += b.count;
    }
  }
  const out: number[] = [];
  for (const b of blocks) {
    const avg = b.sum / b.count;
    for (let i = 0; i < b.count; i++) out.push(avg);
  }
  return out;
}

/**
 * Aligns floating (unlocked) perimeter pins directly across from the macro ports
 * they connect to while preserving minimum 2-tile spacing and respecting locked pins.
 */
export function alignFloatingPinsToMacros(
  pins: PerimeterPin[],
  synth: SynthesisResult,
  macros: PlacedMacro[],
  width: number,
  height: number,
  groupByBus = false,
): PerimeterPin[] {
  const macroById = new Map(macros.map((m) => [m.id, m]));
  const pinById = new Map(pins.map((p) => [p.id, p]));
  const targetCoordByPinId = new Map<string, { x: number; y: number }>();

  for (const net of synth.nets) {
    if (net.source.nodeId.startsWith('in:')) {
      const pm = macroById.get(net.sink.nodeId);
      const mp = pm?.macro.pins.find((p) => p.id === net.sink.pinId);
      if (pm && mp) {
        targetCoordByPinId.set(net.source.nodeId, {
          x: pm.x + mp.portX,
          y: pm.y + mp.portY,
        });
      } else {
        const outP = pinById.get(net.sink.nodeId);
        if (outP) targetCoordByPinId.set(net.source.nodeId, { x: outP.x, y: outP.y });
      }
    }
    if (net.sink.nodeId.startsWith('out:')) {
      const pm = macroById.get(net.source.nodeId);
      const mp = pm?.macro.pins.find((p) => p.id === net.source.pinId);
      if (pm && mp) {
        targetCoordByPinId.set(net.sink.nodeId, {
          x: pm.x + mp.portX,
          y: pm.y + mp.portY,
        });
      } else {
        const inP = pinById.get(net.source.nodeId);
        if (inP) targetCoordByPinId.set(net.sink.nodeId, { x: inP.x, y: inP.y });
      }
    }
  }

  const updated = pins.map((p) => ({ ...p }));

  for (const edge of ['W', 'E', 'N', 'S'] as Edge[]) {
    const edgePins = updated.filter((p) => p.edge === edge);
    if (edgePins.length === 0) continue;

    const edgeLen = edge === 'W' || edge === 'E' ? height : width;
    const minOff = 1;
    const maxOff = Math.max(1, edgeLen - 2);

    const locked = edgePins.filter((p) => p.locked);
    const floating = edgePins.filter((p) => !p.locked);
    if (floating.length === 0) continue;

    const idealOf = (p: PerimeterPin): number => {
      const tc = targetCoordByPinId.get(p.id);
      if (!tc) return p.offset;
      const raw = edge === 'W' || edge === 'E' ? tc.y : tc.x;
      return Math.max(minOff + 1, Math.min(maxOff - 1, raw));
    };

    const hasExplicitOrder = floating.some((p) => p.order < 10000);
    if (hasExplicitOrder) {
      floating.sort((a, b) => a.order - b.order || a.busIndex - b.busIndex);
    } else if (groupByBus) {
      const busSums = new Map<string, { sum: number; count: number }>();
      for (const p of floating) {
        const cur = busSums.get(p.busId) ?? { sum: 0, count: 0 };
        cur.sum += idealOf(p);
        cur.count += 1;
        busSums.set(p.busId, cur);
      }
      const busAvg = (busId: string) => {
        const b = busSums.get(busId);
        return b && b.count > 0 ? b.sum / b.count : 0;
      };
      floating.sort(
        (a, b) =>
          busAvg(a.busId) - busAvg(b.busId) ||
          a.busId.localeCompare(b.busId) ||
          a.busIndex - b.busIndex,
      );
    } else {
      floating.sort((a, b) => idealOf(a) - idealOf(b) || a.busIndex - b.busIndex);
    }

    const pitch = floating.length * 2 <= maxOff - minOff ? 2 : 1;
    const ideals = floating.map(idealOf);
    const shifted = ideals.map((v, i) => v - pitch * i);
    const iso = isotonicNonDecreasing(shifted);

    const lockedSet = new Set(locked.map((p) => p.offset));
    const placedFluidSet = new Set(locked.filter((p) => p.isFluid).map((p) => p.offset));
    const placedFloatingSet = new Set<number>();
    const isBlocked = (pos: number, isFluidPin: boolean): boolean => {
      if (pos < minOff || pos > maxOff) return true;
      if (lockedSet.has(pos) || placedFloatingSet.has(pos)) return true;
      if (pitch >= 2 && (lockedSet.has(pos - 1) || lockedSet.has(pos + 1))) return true;
      if (isFluidPin && (placedFluidSet.has(pos - 1) || placedFluidSet.has(pos + 1))) {
        return true;
      }
      return false;
    };

    let prev = minOff - pitch;
    for (let i = 0; i < floating.length; i++) {
      const pin = floating[i];
      const isFl = Boolean(pin.isFluid);
      const remAfter = floating.length - 1 - i;
      const maxAllowed = maxOff - remAfter * pitch;
      let pos = Math.round(iso[i] + pitch * i);
      pos = Math.max(prev + pitch, Math.min(maxAllowed, pos));

      if (isBlocked(pos, isFl)) {
        // Search nearest unblocked slot >= prev + pitch (preferring small shift)
        let found = -1;
        for (let d = 1; d <= edgeLen; d++) {
          if (pos + d <= maxAllowed && pos + d >= prev + pitch && !isBlocked(pos + d, isFl)) {
            found = pos + d;
            break;
          }
          if (pos - d >= prev + pitch && pos - d <= maxAllowed && !isBlocked(pos - d, isFl)) {
            found = pos - d;
            break;
          }
        }
        if (found >= 0) pos = found;
        else {
          // Fallback: scan forward keeping fluid pins >= 2 apart even on tight edges
          let qFound = -1;
          for (let q = Math.max(minOff, prev + 1); q <= maxOff; q++) {
            if (
              !lockedSet.has(q) &&
              !placedFloatingSet.has(q) &&
              (!isFl || (!placedFluidSet.has(q - 1) && !placedFluidSet.has(q + 1)))
            ) {
              qFound = q;
              break;
            }
          }
          if (qFound >= 0) {
            pos = qFound;
          } else {
            for (let q = Math.max(minOff, prev + 1); q <= maxOff; q++) {
              if (!lockedSet.has(q) && !placedFloatingSet.has(q)) {
                pos = q;
                break;
              }
            }
          }
        }
      }

      pin.offset = pos;
      pin.x = edge === 'W' ? 0 : edge === 'E' ? width - 1 : pos;
      pin.y = edge === 'N' ? 0 : edge === 'S' ? height - 1 : pos;
      placedFloatingSet.add(pos);
      if (isFl) placedFluidSet.add(pos);
      prev = pos;
    }
  }

  return updated;
}
