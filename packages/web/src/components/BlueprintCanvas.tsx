import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BELT_SPECS,
  Dir,
  DrcReport,
  EntityInstance,
  FloorplanResult,
  INSERTER_BY_ENTITY_NAME,
  POLE_BY_ENTITY_NAME,
  PerimeterPin,
  PlacedMacro,
  RouteResult,
  StaReport,
  SynthesisResult,
  beltTierFromEntityName,
  dirDelta,
  getItemMeta,
  isMachineName,
  isSplitterName,
  isUndergroundName,
} from '@factorio-eda/core';
import { ArrowUpDown, HelpCircle, Maximize2, RotateCw, X, ZoomIn, ZoomOut } from 'lucide-react';
import { subscribeAssets } from '../sprites/factorioAssets';
import { renderFactorioScene } from '../sprites/factorioRenderer';
import { drawSmartPinLabels } from './pinLabels';

export type RenderMode = 'eda' | 'factorio';

export interface CanvasLayers {
  macros: boolean;
  belts: boolean;
  undergrounds: boolean;
  powerGrid: boolean;
  powerCoverage: boolean;
  flylines: boolean;
  heatmap: boolean;
  pinLabels: boolean;
  drc: boolean;
}

export type SelectionTarget =
  | { kind: 'pin'; pinId: string }
  | { kind: 'macro'; macroId: string }
  | { kind: 'net'; netId: string }
  | null;

interface BlueprintCanvasProps {
  synthesis: SynthesisResult | null;
  floorplan: FloorplanResult | null;
  route: RouteResult | null;
  entities: EntityInstance[];
  drc: DrcReport | null;
  sta: StaReport | null;
  layers: CanvasLayers;
  renderMode?: RenderMode;
  altMode?: boolean;
  assetVersion?: number;
  selection: SelectionTarget;
  focusTile: { tx: number; ty: number; nonce: number } | null;
  onSelect: (sel: SelectionTarget) => void;
  onMovePin: (pinId: string, edge: 'N' | 'S' | 'E' | 'W', offset: number) => void;
  onMoveMacro: (macroId: string, x: number, y: number) => void;
  onRotateMacro: (macroId: string) => void;
  onFlipMacro: (macroId: string) => void;
  onToggleAltMode?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
}

interface HoverInfo {
  tx: number;
  ty: number;
  screenX: number;
  screenY: number;
  lines: string[];
}

export const BlueprintCanvas: React.FC<BlueprintCanvasProps> = ({
  synthesis,
  floorplan,
  route,
  entities,
  drc,
  sta,
  layers,
  renderMode = 'factorio',
  altMode = true,
  assetVersion = 0,
  selection,
  focusTile,
  onSelect,
  onMovePin,
  onMoveMacro,
  onRotateMacro,
  onFlipMacro,
  onToggleAltMode,
  onUndo,
  onRedo,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [cam, setCam] = useState({ x: 0, y: 0, scale: 18 });
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [assetTick, setAssetTick] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => subscribeAssets(() => setAssetTick((t) => t + 1)), []);

  const { highlightedNetIds, highlightedPinIds } = useMemo(() => {
    const netIds = new Set<string>();
    const pinIds = new Set<string>();
    if (!selection) return { highlightedNetIds: netIds, highlightedPinIds: pinIds };

    if (selection.kind === 'net') {
      netIds.add(selection.netId);
      const net = synthesis?.nets.find((n) => n.id === selection.netId);
      if (net) {
        if (net.source.nodeId.startsWith('in:') || net.source.nodeId.startsWith('out:')) {
          pinIds.add(net.source.nodeId);
        }
        if (net.sink.nodeId.startsWith('in:') || net.sink.nodeId.startsWith('out:')) {
          pinIds.add(net.sink.nodeId);
        }
      }
    } else if (selection.kind === 'pin') {
      pinIds.add(selection.pinId);
      if (synthesis) {
        for (const n of synthesis.nets) {
          if (n.source.nodeId === selection.pinId || n.sink.nodeId === selection.pinId) {
            netIds.add(n.id);
          }
        }
      }
    } else if (selection.kind === 'macro' && synthesis) {
      for (const n of synthesis.nets) {
        if (n.source.nodeId === selection.macroId || n.sink.nodeId === selection.macroId) {
          netIds.add(n.id);
        }
      }
    }
    return { highlightedNetIds: netIds, highlightedPinIds: pinIds };
  }, [selection, synthesis]);

  const dragRef = useRef<
    | {
        mode: 'pan';
        startX: number;
        startY: number;
        origCamX: number;
        origCamY: number;
        movedPx: number;
      }
    | {
        mode: 'pin';
        pin: PerimeterPin;
        previewEdge: 'N' | 'S' | 'E' | 'W';
        previewOffset: number;
      }
    | {
        mode: 'macro';
        macro: PlacedMacro;
        offsetTileX: number;
        offsetTileY: number;
        previewX: number;
        previewY: number;
      }
    | null
  >(null);

  const [dragPreview, setDragPreview] = useState<{
    kind: 'pin' | 'macro';
    macroId?: string;
    edge?: 'N' | 'S' | 'E' | 'W';
    offset?: number;
    x?: number;
    y?: number;
    w?: number;
    h?: number;
    label?: string;
  } | null>(null);

  const fitToView = useCallback(() => {
    if (!floorplan || size.w <= 0 || size.h <= 0) return;
    const hasW = floorplan.pins.some((p) => p.edge === 'W');
    const hasE = floorplan.pins.some((p) => p.edge === 'E');
    const hasN = floorplan.pins.some((p) => p.edge === 'N');
    const hasS = floorplan.pins.some((p) => p.edge === 'S');
    const padLeftPx = hasW ? Math.min(130, size.w * 0.21) : 34;
    const padRightPx = hasE ? Math.min(150, size.w * 0.23) : 34;
    const padTopPx = hasN ? 46 : 30;
    const padBotPx = hasS ? 48 : 38;
    const availW = Math.max(120, size.w - padLeftPx - padRightPx);
    const availH = Math.max(120, size.h - padTopPx - padBotPx);
    const scale = Math.max(
      4,
      Math.min(36, Math.min(availW / floorplan.width, availH / floorplan.height)),
    );
    const x = padLeftPx + (availW - floorplan.width * scale) / 2;
    const y = padTopPx + (availH - floorplan.height * scale) / 2;
    setCam({ x, y, scale });
  }, [floorplan, size.w, size.h]);

  // Observe container resize
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const cr = entry.contentRect;
        setSize({ w: Math.max(200, cr.width), h: Math.max(200, cr.height) });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Auto fit when floorplan dimensions change
  const lastDieRef = useRef<string>('');
  useEffect(() => {
    if (!floorplan) return;
    const key = `${floorplan.width}x${floorplan.height}`;
    if (key !== lastDieRef.current) {
      lastDieRef.current = key;
      fitToView();
    }
  }, [floorplan, fitToView]);

  // Focus tile (e.g. clicking a DRC violation)
  useEffect(() => {
    if (!focusTile) return;
    const scale = Math.max(cam.scale, 22);
    const x = size.w / 2 - (focusTile.tx + 0.5) * scale;
    const y = size.h / 2 - (focusTile.ty + 0.5) * scale;
    setCam({ x, y, scale });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTile?.nonce]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      ) {
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) onRedo?.();
        else onUndo?.();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        onRedo?.();
        return;
      }
      if ((e.key === 'r' || e.key === 'R') && selection?.kind === 'macro') {
        onRotateMacro(selection.macroId);
      } else if ((e.key === 'f' || e.key === 'F') && selection?.kind === 'macro') {
        onFlipMacro(selection.macroId);
      } else if (e.key === 'a' || e.key === 'A') {
        onToggleAltMode?.();
      } else if (e.key === ' ' || e.key === '0') {
        e.preventDefault();
        fitToView();
      } else if (e.key === 'Escape') {
        onSelect(null);
        setHelpOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selection, onRotateMacro, onFlipMacro, onToggleAltMode, fitToView, onSelect, onUndo, onRedo]);

  const screenToTile = useCallback(
    (sx: number, sy: number) => ({
      tx: Math.floor((sx - cam.x) / cam.scale),
      ty: Math.floor((sy - cam.y) / cam.scale),
    }),
    [cam],
  );

  // Render Canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(size.w * dpr);
    canvas.height = Math.floor(size.h * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.save();
    ctx.scale(dpr, dpr);

    // Outer blueprint-blue backdrop
    ctx.fillStyle = '#091a2c';
    ctx.fillRect(0, 0, size.w, size.h);

    if (!floorplan) {
      ctx.fillStyle = '#8cb2d9';
      ctx.font = '14px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Configure targets & click Run P&R to generate layout', size.w / 2, size.h / 2);
      ctx.restore();
      return;
    }

    const W = floorplan.width;
    const H = floorplan.height;
    const s = cam.scale;
    const ox = cam.x;
    const oy = cam.y;

    // Utilization lookup for Heatmap
    const netUtilMap = new Map<string, number>();
    const macroUtilMap = new Map<string, number>();
    if (sta) {
      for (const n of sta.nets) netUtilMap.set(n.netId, n.utilization);
      for (const m of sta.macros) macroUtilMap.set(m.macroId, m.utilization);
    }

    const utilColor = (u: number) => {
      if (u > 1.0) return 'rgba(239, 68, 68, 0.45)';
      if (u > 0.8) return 'rgba(245, 158, 11, 0.35)';
      return 'rgba(74, 222, 128, 0.25)';
    };

    let ugInputs: EntityInstance[] = [];
    let ugOutputs: EntityInstance[] = [];

    if (renderMode === 'factorio') {
      const res = renderFactorioScene(
        ctx,
        size.w,
        size.h,
        floorplan,
        entities,
        ox,
        oy,
        s,
        {
          macros: layers.macros,
          belts: layers.belts,
          undergrounds: layers.undergrounds,
          powerGrid: layers.powerGrid,
          powerCoverage: layers.powerCoverage,
          heatmap: layers.heatmap,
          pinLabels: layers.pinLabels,
          altMode,
        },
        selection?.kind === 'macro' ? selection.macroId : null,
        selection?.kind === 'pin' ? selection.pinId : null,
        netUtilMap,
        macroUtilMap,
        utilColor,
        highlightedPinIds,
      );
      ugInputs = res.ugInputs;
      ugOutputs = res.ugOutputs;
    } else {
      // Die surface
      ctx.fillStyle = '#102b47';
      ctx.fillRect(ox, oy, W * s, H * s);

      // Grid lines
      if (s >= 6) {
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.12)';
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

      // Major 5-tile grid
      ctx.strokeStyle = 'rgba(59, 130, 246, 0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= W; x += 5) {
        const px = Math.round(ox + x * s) + 0.5;
        ctx.moveTo(px, oy);
        ctx.lineTo(px, oy + H * s);
      }
      for (let y = 0; y <= H; y += 5) {
        const py = Math.round(oy + y * s) + 0.5;
        ctx.moveTo(ox, py);
        ctx.lineTo(ox + W * s, py);
      }
      ctx.stroke();

      // Coordinate ruler ticks along top & left
      if (s >= 9) {
        ctx.fillStyle = 'rgba(148, 197, 248, 0.6)';
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

      // Die border
      ctx.strokeStyle = '#60a5fa';
      ctx.lineWidth = 2;
      ctx.strokeRect(ox, oy, W * s, H * s);

      // Power Coverage layer
      if (layers.powerCoverage) {
        for (const e of entities) {
          const ps = POLE_BY_ENTITY_NAME[e.name];
          if (!ps) continue;
          const cx = ox + (e.tx + ps.size / 2) * s;
          const cy = oy + (e.ty + ps.size / 2) * s;
          const r = ps.supplyRadius * s;
          ctx.fillStyle = 'rgba(56, 189, 248, 0.08)';
          ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
          ctx.strokeStyle = 'rgba(56, 189, 248, 0.35)';
          ctx.lineWidth = 1;
          ctx.strokeRect(cx - r, cy - r, r * 2, r * 2);
        }
      }

      // Macro frames
      if (layers.macros) {
        for (const pm of floorplan.macros) {
          const mx = ox + pm.x * s;
          const my = oy + pm.y * s;
          const mw = pm.macro.width * s;
          const mh = pm.macro.height * s;
          const isSel = selection?.kind === 'macro' && selection.macroId === pm.id;
          const isBal = pm.macro.kind === 'balancer-macro';

          ctx.fillStyle = isBal
            ? 'rgba(245, 158, 11, 0.08)'
            : 'rgba(56, 189, 248, 0.06)';
          ctx.fillRect(mx, my, mw, mh);

          ctx.save();
          ctx.setLineDash(isSel ? [] : [5, 4]);
          ctx.strokeStyle = isSel ? '#f59e0b' : isBal ? '#fbbf24' : '#38bdf8';
          ctx.lineWidth = isSel ? 2.2 : 1.2;
          ctx.strokeRect(mx, my, mw, mh);
          ctx.restore();

          if (s >= 8) {
            ctx.fillStyle = isBal ? '#fde68a' : '#bae6fd';
            ctx.font = `700 ${Math.max(9, Math.min(12, s * 0.55))}px Inter, sans-serif`;
            ctx.textAlign = 'left';
            const tag = `${pm.locked ? '🔒 ' : ''}${pm.macro.label} (${pm.macro.sublabel})`;
            ctx.fillText(tag, mx + 4, my - 4);
          }
        }
      }

      // Draw entities
      const poles: Array<{ ent: EntityInstance; cx: number; cy: number; wireReach: number }> = [];

      for (const e of entities) {
        const ex = ox + e.tx * s;
        const ey = oy + e.ty * s;
        const ew = e.w * s;
        const eh = e.h * s;

        if (e.role === 'port-marker') {
          if (!layers.pinLabels) continue;
          ctx.fillStyle = '#0f172a';
          ctx.strokeStyle = '#94a3b8';
          ctx.lineWidth = 1.2;
          ctx.fillRect(ex + s * 0.15, ey + s * 0.15, s * 0.7, s * 0.7);
          ctx.strokeRect(ex + s * 0.15, ey + s * 0.15, s * 0.7, s * 0.7);
          continue;
        }

        if (isMachineName(e.name)) {
          const isFurnace = e.name === 'electric-furnace';
          ctx.fillStyle = isFurnace ? '#2b3445' : '#1b385c';
          ctx.fillRect(ex + 1, ey + 1, ew - 2, eh - 2);
          ctx.strokeStyle = isFurnace ? '#fb923c' : '#7dd3fc';
          ctx.lineWidth = Math.max(1, s * 0.08);
          ctx.strokeRect(ex + 1, ey + 1, ew - 2, eh - 2);

          if (layers.heatmap && e.macroId && macroUtilMap.has(e.macroId)) {
            ctx.fillStyle = utilColor(macroUtilMap.get(e.macroId)!);
            ctx.fillRect(ex + 1, ey + 1, ew - 2, eh - 2);
          }

          // Procedural assembler gear / furnace chamber silhouette
          const cx = ex + ew / 2;
          const cy = ey + eh / 2;
          ctx.strokeStyle = isFurnace ? 'rgba(251,146,60,0.45)' : 'rgba(186,230,253,0.35)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(cx, cy, Math.min(ew, eh) * 0.32, 0, Math.PI * 2);
          ctx.stroke();

          // Recipe item center badge
          if (e.item) {
            const meta = getItemMeta(e.item);
            ctx.fillStyle = meta.color;
            ctx.beginPath();
            ctx.arc(cx, cy, Math.max(2.5, Math.min(ew, eh) * 0.18), 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = '#091a2c';
            ctx.lineWidth = 1;
            ctx.stroke();
          }

          if (s >= 10) {
            ctx.fillStyle = '#e2eef9';
            ctx.font = `700 ${Math.max(8, s * 0.34)}px JetBrains Mono, monospace`;
            ctx.textAlign = 'left';
            const badge = isFurnace ? 'EF' : `A${e.name.slice(-1)}`;
            ctx.fillText(badge, ex + 3, ey + Math.max(10, s * 0.38));

            // Module pips
            if (e.items && e.items.length > 0) {
              e.items.forEach((mod, mi) => {
                ctx.fillStyle = mod.startsWith('speed')
                  ? '#38bdf8'
                  : mod.startsWith('productivity')
                    ? '#ef4444'
                    : '#22c55e';
                ctx.fillRect(ex + 3 + mi * (s * 0.24), ey + eh - s * 0.28, s * 0.18, s * 0.18);
              });
            }
          }
          continue;
        }

        if (isSplitterName(e.name)) {
          if (!layers.belts) continue;
          const tier = beltTierFromEntityName(e.name) ?? 'yellow';
          const col = BELT_SPECS[tier].color;
          ctx.fillStyle = '#1e293b';
          ctx.fillRect(ex + 1, ey + 1, ew - 2, eh - 2);
          ctx.strokeStyle = col;
          ctx.lineWidth = 1.6;
          ctx.strokeRect(ex + 1, ey + 1, ew - 2, eh - 2);

          // Dual directional arrows
          const { dx, dy } = dirDelta(e.direction);
          ctx.strokeStyle = col;
          ctx.lineWidth = Math.max(1.2, s * 0.1);
          const lanes = e.w > e.h ? [0.25, 0.75] : [0.25, 0.75];
          for (const frac of lanes) {
            const lx = e.w > e.h ? ex + ew * frac : ex + ew * 0.5;
            const ly = e.w > e.h ? ey + eh * 0.5 : ey + eh * frac;
            ctx.beginPath();
            ctx.moveTo(lx - dx * s * 0.25, ly - dy * s * 0.25);
            ctx.lineTo(lx + dx * s * 0.25, ly + dy * s * 0.25);
            ctx.stroke();
          }
          continue;
        }

        if (isUndergroundName(e.name)) {
          if (e.type === 'input') ugInputs.push(e);
          else ugOutputs.push(e);
          if (!layers.undergrounds) continue;

          const tier = beltTierFromEntityName(e.name) ?? 'yellow';
          const col = BELT_SPECS[tier].color;
          ctx.fillStyle = e.type === 'input' ? '#0b1320' : '#1e293b';
          ctx.fillRect(ex + s * 0.08, ey + s * 0.08, ew - s * 0.16, eh - s * 0.16);
          ctx.strokeStyle = col;
          ctx.lineWidth = 1.6;
          ctx.strokeRect(ex + s * 0.08, ey + s * 0.08, ew - s * 0.16, eh - s * 0.16);

          // Directional hood arrow
          const cx = ex + ew / 2;
          const cy = ey + eh / 2;
          const { dx, dy } = dirDelta(e.direction);
          ctx.fillStyle = e.type === 'input' ? '#f59e0b' : '#38bdf8';
          ctx.beginPath();
          ctx.arc(cx + dx * s * 0.16, cy + dy * s * 0.16, Math.max(1.8, s * 0.16), 0, Math.PI * 2);
          ctx.fill();
          continue;
        }

        if (beltTierFromEntityName(e.name)) {
          if (!layers.belts) continue;
          const tier = beltTierFromEntityName(e.name)!;
          const col = BELT_SPECS[tier].color;
          ctx.fillStyle = '#0d1929';
          ctx.fillRect(ex + s * 0.08, ey + s * 0.08, ew - s * 0.16, eh - s * 0.16);
          ctx.strokeStyle = col;
          ctx.lineWidth = Math.max(1, s * 0.08);
          ctx.strokeRect(ex + s * 0.08, ey + s * 0.08, ew - s * 0.16, eh - s * 0.16);

          if (layers.heatmap && e.netId && netUtilMap.has(e.netId)) {
            ctx.fillStyle = utilColor(netUtilMap.get(e.netId)!);
            ctx.fillRect(ex + s * 0.08, ey + s * 0.08, ew - s * 0.16, eh - s * 0.16);
          }

          // Direction chevron + item tint
          const cx = ex + ew / 2;
          const cy = ey + eh / 2;
          const { dx, dy } = dirDelta(e.direction);
          const px = -dy;
          const py = dx;
          const itemColor = e.item ? getItemMeta(e.item).color : col;

          ctx.strokeStyle = itemColor;
          ctx.lineWidth = Math.max(1.2, s * 0.12);
          ctx.beginPath();
          ctx.moveTo(cx - dx * s * 0.18 + px * s * 0.2, cy - dy * s * 0.18 + py * s * 0.2);
          ctx.lineTo(cx + dx * s * 0.24, cy + dy * s * 0.24);
          ctx.lineTo(cx - dx * s * 0.18 - px * s * 0.2, cy - dy * s * 0.18 - py * s * 0.2);
          ctx.stroke();
          continue;
        }

        if (e.name in INSERTER_BY_ENTITY_NAME) {
          const ins = INSERTER_BY_ENTITY_NAME[e.name];
          const cx = ex + ew / 2;
          const cy = ey + eh / 2;
          const { dx, dy } = dirDelta(e.direction);

          ctx.fillStyle = '#091524';
          ctx.strokeStyle = ins.color;
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.arc(cx, cy, Math.max(2, s * 0.22), 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();

          // Arm: base -> pickup side (+d), drop claw -> opposite (-d)
          ctx.strokeStyle = ins.color;
          ctx.lineWidth = Math.max(1.2, s * 0.12);
          ctx.beginPath();
          ctx.moveTo(cx + dx * s * 0.36, cy + dy * s * 0.36);
          ctx.lineTo(cx - dx * s * 0.36, cy - dy * s * 0.36);
          ctx.stroke();

          // Drop arrow tip on -d side
          ctx.fillStyle = ins.color;
          ctx.beginPath();
          ctx.arc(cx - dx * s * 0.35, cy - dy * s * 0.35, Math.max(1.5, s * 0.11), 0, Math.PI * 2);
          ctx.fill();
          continue;
        }

        if (e.name in POLE_BY_ENTITY_NAME) {
          const ps = POLE_BY_ENTITY_NAME[e.name];
          const cx = ex + ew / 2;
          const cy = ey + eh / 2;
          poles.push({ ent: e, cx, cy, wireReach: ps.wireReach });
          if (!layers.powerGrid) continue;

          ctx.fillStyle = '#1e293b';
          ctx.strokeStyle = ps.color;
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          ctx.arc(cx, cy, Math.max(2.5, Math.min(ew, eh) * 0.32), 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();

          // Copper center dot
          ctx.fillStyle = '#f59e0b';
          ctx.beginPath();
          ctx.arc(cx, cy, Math.max(1.4, Math.min(ew, eh) * 0.14), 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Power grid copper wires (MST/reach lines)
      if (layers.powerGrid && poles.length > 1) {
        ctx.save();
        ctx.strokeStyle = 'rgba(245, 158, 11, 0.55)';
        ctx.lineWidth = 1.2;
        for (let i = 0; i < poles.length; i++) {
          for (let j = i + 1; j < poles.length; j++) {
            const a = poles[i];
            const b = poles[j];
            const reach = Math.min(a.wireReach, b.wireReach);
            const dx = a.ent.tx + a.ent.w / 2 - (b.ent.tx + b.ent.w / 2);
            const dy = a.ent.ty + a.ent.h / 2 - (b.ent.ty + b.ent.h / 2);
            if (dx * dx + dy * dy <= reach * reach + 1e-6) {
              ctx.beginPath();
              ctx.moveTo(a.cx, a.cy);
              ctx.lineTo(b.cx, b.cy);
              ctx.stroke();
            }
          }
        }
        ctx.restore();
      }
    }

    // Underground dashed bridge lines (M2 layer)
    if (layers.undergrounds) {
      ctx.save();
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = Math.max(1.2, s * 0.1);
      for (const u of ugInputs) {
        const { dx, dy } = dirDelta(u.direction);
        const tier = beltTierFromEntityName(u.name)!;
        const maxD = BELT_SPECS[tier].maxUgDistance;
        for (let step = 1; step <= maxD; step++) {
          const partner = ugOutputs.find(
            (o) =>
              o.tx === u.tx + dx * step &&
              o.ty === u.ty + dy * step &&
              o.direction === u.direction &&
              beltTierFromEntityName(o.name) === tier,
          );
          if (partner) {
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

    // Net trace highlight overlay (from selected belt net, pin, or macro)
    if (highlightedNetIds.size > 0) {
      const isNetSel = selection?.kind === 'net';
      const fillCol = isNetSel ? 'rgba(56, 189, 248, 0.34)' : 'rgba(245, 158, 11, 0.24)';
      const strokeCol = isNetSel ? '#38bdf8' : '#fbbf24';

      ctx.save();
      ctx.fillStyle = fillCol;
      ctx.strokeStyle = strokeCol;
      ctx.lineWidth = 2;
      for (const e of entities) {
        if (!e.netId || !highlightedNetIds.has(e.netId)) continue;
        const rx = ox + e.tx * s;
        const ry = oy + e.ty * s;
        const rw = e.w * s;
        const rh = e.h * s;
        ctx.fillRect(rx, ry, rw, rh);
        ctx.strokeRect(rx + 0.5, ry + 0.5, rw - 1, rh - 1);
      }

      // Highlight matching underground tunnel spans
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = '#fde047';
      ctx.lineWidth = Math.max(2.2, s * 0.16);
      for (const u of ugInputs) {
        if (!u.netId || !highlightedNetIds.has(u.netId)) continue;
        const { dx, dy } = dirDelta(u.direction);
        const tier = beltTierFromEntityName(u.name)!;
        const maxD = BELT_SPECS[tier].maxUgDistance;
        for (let step = 1; step <= maxD; step++) {
          const partner = ugOutputs.find(
            (o) =>
              o.tx === u.tx + dx * step &&
              o.ty === u.ty + dy * step &&
              o.direction === u.direction &&
              beltTierFromEntityName(o.name) === tier,
          );
          if (partner) {
            ctx.beginPath();
            ctx.moveTo(ox + (u.tx + 0.5) * s, oy + (u.ty + 0.5) * s);
            ctx.lineTo(ox + (partner.tx + 0.5) * s, oy + (partner.ty + 0.5) * s);
            ctx.stroke();
            break;
          }
        }
      }

      // Endpoint rings when a single net is selected
      if (isNetSel && synthesis) {
        const net = synthesis.nets.find((n) => n.id === selection.netId);
        if (net) {
          const resolveEndpoint = (ep: typeof net.source): { x: number; y: number } | null => {
            if (ep.nodeId.startsWith('in:') || ep.nodeId.startsWith('out:')) {
              const p = floorplan.pins.find((pin) => pin.id === ep.nodeId);
              return p ? { x: p.x + 0.5, y: p.y + 0.5 } : null;
            }
            const pm = floorplan.macros.find((m) => m.id === ep.nodeId);
            const mp = pm?.macro.pins.find((p) => p.id === ep.pinId);
            return pm && mp ? { x: pm.x + mp.x + 0.5, y: pm.y + mp.y + 0.5 } : null;
          };

          ctx.setLineDash([]);
          const srcPt = resolveEndpoint(net.source);
          if (srcPt) {
            ctx.strokeStyle = '#4ade80';
            ctx.lineWidth = 2.6;
            ctx.beginPath();
            ctx.arc(ox + srcPt.x * s, oy + srcPt.y * s, Math.max(6, s * 0.55), 0, Math.PI * 2);
            ctx.stroke();
          }
          const snkPt = resolveEndpoint(net.sink);
          if (snkPt) {
            ctx.strokeStyle = '#f472b6';
            ctx.lineWidth = 2.6;
            ctx.beginPath();
            ctx.arc(ox + snkPt.x * s, oy + snkPt.y * s, Math.max(6, s * 0.55), 0, Math.PI * 2);
            ctx.stroke();
          }
        }
      }
      ctx.restore();
    }

    // Rat's-nest flylines
    if (layers.flylines && synthesis) {
      const macroById = new Map(floorplan.macros.map((m) => [m.id, m]));
      const pinById = new Map(floorplan.pins.map((p) => [p.id, p]));
      ctx.save();
      ctx.strokeStyle = 'rgba(244, 114, 182, 0.55)';
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1.3;
      for (const net of synthesis.nets) {
        let x1 = 0,
          y1 = 0,
          x2 = 0,
          y2 = 0;
        if (net.source.nodeId.startsWith('in:')) {
          const p = pinById.get(net.source.nodeId);
          if (!p) continue;
          x1 = p.x + 0.5;
          y1 = p.y + 0.5;
        } else {
          const pm = macroById.get(net.source.nodeId);
          const mp = pm?.macro.pins.find((p) => p.id === net.source.pinId);
          if (!pm || !mp) continue;
          x1 = pm.x + mp.x + 0.5;
          y1 = pm.y + mp.y + 0.5;
        }

        if (net.sink.nodeId.startsWith('out:')) {
          const p = pinById.get(net.sink.nodeId);
          if (!p) continue;
          x2 = p.x + 0.5;
          y2 = p.y + 0.5;
        } else {
          const pm = macroById.get(net.sink.nodeId);
          const mp = pm?.macro.pins.find((p) => p.id === net.sink.pinId);
          if (!pm || !mp) continue;
          x2 = pm.x + mp.x + 0.5;
          y2 = pm.y + mp.y + 0.5;
        }

        ctx.beginPath();
        ctx.moveTo(ox + x1 * s, oy + y1 * s);
        ctx.lineTo(ox + x2 * s, oy + y2 * s);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Perimeter pins (EDA mode draws schematic dots; Factorio mode already draws icon pins)
    if (renderMode === 'eda') {
      for (const pin of floorplan.pins) {
        const px = ox + (pin.x + 0.5) * s;
        const py = oy + (pin.y + 0.5) * s;
        const isSel = selection?.kind === 'pin' && selection.pinId === pin.id;
        const isHl = highlightedPinIds.has(pin.id);
        const col = pin.kind === 'input' ? '#4ade80' : '#f472b6';

        ctx.fillStyle = col;
        ctx.strokeStyle = isSel ? '#f59e0b' : isHl ? '#ffffff' : '#091a2c';
        ctx.lineWidth = isSel || isHl ? 2.5 : 1.5;
        ctx.beginPath();
        ctx.arc(px, py, Math.max(4, s * 0.38), 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }

      if (layers.pinLabels) {
        drawSmartPinLabels(ctx, floorplan, ox, oy, s, {
          selectedPinId: selection?.kind === 'pin' ? selection.pinId : null,
          highlightedPinIds,
          theme: 'eda',
        });
      }
    }

    // DRC violation markers
    if (layers.drc && drc && drc.violations.length > 0) {
      for (const v of drc.violations) {
        const vx = ox + v.tx * s;
        const vy = oy + v.ty * s;
        ctx.strokeStyle = '#ef4444';
        ctx.fillStyle = 'rgba(239, 68, 68, 0.25)';
        ctx.lineWidth = 2;
        ctx.fillRect(vx - 2, vy - 2, s + 4, s + 4);
        ctx.strokeRect(vx - 2, vy - 2, s + 4, s + 4);
      }
    }

    // Live drag ghost preview
    if (dragPreview) {
      ctx.save();
      if (dragPreview.kind === 'macro' && dragPreview.x !== undefined && dragPreview.y !== undefined) {
        const gx = ox + dragPreview.x * s;
        const gy = oy + dragPreview.y * s;
        const gw = (dragPreview.w ?? 3) * s;
        const gh = (dragPreview.h ?? 3) * s;
        const dx1 = dragPreview.x;
        const dy1 = dragPreview.y;
        const dx2 = dx1 + (dragPreview.w ?? 3);
        const dy2 = dy1 + (dragPreview.h ?? 3);
        const overlaps = floorplan.macros.some(
          (pm) =>
            pm.id !== dragPreview.macroId &&
            dx1 < pm.x + pm.macro.width &&
            dx2 > pm.x &&
            dy1 < pm.y + pm.macro.height &&
            dy2 > pm.y,
        );

        ctx.strokeStyle = overlaps ? '#ef4444' : '#f59e0b';
        ctx.fillStyle = overlaps ? 'rgba(239, 68, 68, 0.28)' : 'rgba(245, 158, 11, 0.22)';
        ctx.lineWidth = 2;
        ctx.fillRect(gx, gy, gw, gh);
        ctx.strokeRect(gx, gy, gw, gh);

        const badge = `(${dx1}, ${dy1})${overlaps ? ' OVERLAP' : ''}`;
        ctx.font = '700 11px JetBrains Mono, monospace';
        const bw = ctx.measureText(badge).width + 10;
        ctx.fillStyle = overlaps ? '#7f1d1d' : '#0f172a';
        ctx.fillRect(gx, gy - 20, bw, 16);
        ctx.strokeStyle = overlaps ? '#ef4444' : '#f59e0b';
        ctx.lineWidth = 1;
        ctx.strokeRect(gx, gy - 20, bw, 16);
        ctx.fillStyle = overlaps ? '#fecaca' : '#fde68a';
        ctx.textAlign = 'left';
        ctx.fillText(badge, gx + 5, gy - 8);
      } else if (dragPreview.kind === 'pin' && dragPreview.edge) {
        // Dashed perimeter snap rails along all 4 die edges
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.45)';
        ctx.lineWidth = 1.6;
        ctx.strokeRect(ox + 0.5 * s, oy + 0.5 * s, (W - 1) * s, (H - 1) * s);

        // Bold highlight on currently snapped edge
        ctx.setLineDash([]);
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 2.6;
        ctx.beginPath();
        if (dragPreview.edge === 'W') {
          ctx.moveTo(ox + 0.5 * s, oy + 0.5 * s);
          ctx.lineTo(ox + 0.5 * s, oy + (H - 0.5) * s);
        } else if (dragPreview.edge === 'E') {
          ctx.moveTo(ox + (W - 0.5) * s, oy + 0.5 * s);
          ctx.lineTo(ox + (W - 0.5) * s, oy + (H - 0.5) * s);
        } else if (dragPreview.edge === 'N') {
          ctx.moveTo(ox + 0.5 * s, oy + 0.5 * s);
          ctx.lineTo(ox + (W - 0.5) * s, oy + 0.5 * s);
        } else {
          ctx.moveTo(ox + 0.5 * s, oy + (H - 0.5) * s);
          ctx.lineTo(ox + (W - 0.5) * s, oy + (H - 0.5) * s);
        }
        ctx.stroke();

        const off = dragPreview.offset ?? 1;
        const px =
          dragPreview.edge === 'W'
            ? 0
            : dragPreview.edge === 'E'
              ? W - 1
              : off;
        const py =
          dragPreview.edge === 'N'
            ? 0
            : dragPreview.edge === 'S'
              ? H - 1
              : off;
        const cx = ox + (px + 0.5) * s;
        const cy = oy + (py + 0.5) * s;
        ctx.fillStyle = 'rgba(245, 158, 11, 0.28)';
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, Math.max(6, s * 0.48), 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        const badge = `${dragPreview.edge} @ ${off}`;
        ctx.font = '700 11px JetBrains Mono, monospace';
        const bw = ctx.measureText(badge).width + 10;
        const bx = cx - bw / 2;
        const by = cy - Math.max(26, s * 0.8 + 14);
        ctx.fillStyle = '#0f172a';
        ctx.fillRect(bx, by, bw, 16);
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 1;
        ctx.strokeRect(bx, by, bw, 16);
        ctx.fillStyle = '#fde68a';
        ctx.textAlign = 'left';
        ctx.fillText(badge, bx + 5, by + 12);
      }
      ctx.restore();
    }

    ctx.restore();
  }, [
    cam,
    size,
    floorplan,
    entities,
    drc,
    sta,
    synthesis,
    layers,
    renderMode,
    altMode,
    assetVersion,
    assetTick,
    selection,
    highlightedNetIds,
    highlightedPinIds,
    dragPreview,
  ]);

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const nextScale = Math.max(3, Math.min(64, cam.scale * factor));
    const ratio = nextScale / cam.scale;
    setCam({
      scale: nextScale,
      x: mx - (mx - cam.x) * ratio,
      y: my - (my - cam.y) * ratio,
    });
  };

  const snapToEdge = (tx: number, ty: number, W: number, H: number) => {
    const dW = Math.abs(tx - 0);
    const dE = Math.abs(tx - (W - 1));
    const dN = Math.abs(ty - 0);
    const dS = Math.abs(ty - (H - 1));
    const minD = Math.min(dW, dE, dN, dS);
    if (minD === dW) return { edge: 'W' as const, offset: Math.max(1, Math.min(H - 2, ty)) };
    if (minD === dE) return { edge: 'E' as const, offset: Math.max(1, Math.min(H - 2, ty)) };
    if (minD === dN) return { edge: 'N' as const, offset: Math.max(1, Math.min(W - 2, tx)) };
    return { edge: 'S' as const, offset: Math.max(1, Math.min(W - 2, tx)) };
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    if (e.button === 1 || !floorplan) {
      setIsDragging(true);
      dragRef.current = {
        mode: 'pan',
        startX: sx,
        startY: sy,
        origCamX: cam.x,
        origCamY: cam.y,
        movedPx: 0,
      };
      return;
    }

    const { tx, ty } = screenToTile(sx, sy);

    // 1. Check hit on perimeter pin (within 0.9 tile radius)
    const hitPin = floorplan.pins.find(
      (p) => Math.abs(p.x + 0.5 - (sx - cam.x) / cam.scale) < 0.9 &&
             Math.abs(p.y + 0.5 - (sy - cam.y) / cam.scale) < 0.9,
    );
    if (hitPin) {
      onSelect({ kind: 'pin', pinId: hitPin.id });
      setIsDragging(true);
      dragRef.current = {
        mode: 'pin',
        pin: hitPin,
        previewEdge: hitPin.edge,
        previewOffset: hitPin.offset,
      };
      setDragPreview({
        kind: 'pin',
        edge: hitPin.edge,
        offset: hitPin.offset,
      });
      return;
    }

    // 2. Check hit on macro bounding box
    const hitMacro = floorplan.macros.find(
      (m) => tx >= m.x && tx < m.x + m.macro.width && ty >= m.y && ty < m.y + m.macro.height,
    );
    if (hitMacro) {
      onSelect({ kind: 'macro', macroId: hitMacro.id });
      setIsDragging(true);
      dragRef.current = {
        mode: 'macro',
        macro: hitMacro,
        offsetTileX: tx - hitMacro.x,
        offsetTileY: ty - hitMacro.y,
        previewX: hitMacro.x,
        previewY: hitMacro.y,
      };
      setDragPreview({
        kind: 'macro',
        macroId: hitMacro.id,
        x: hitMacro.x,
        y: hitMacro.y,
        w: hitMacro.macro.width,
        h: hitMacro.macro.height,
        label: hitMacro.macro.label,
      });
      return;
    }

    // Defer clear/net selection until mouseup so pan vs click can be distinguished cleanly
    setIsDragging(true);
    dragRef.current = {
      mode: 'pan',
      startX: sx,
      startY: sy,
      origCamX: cam.x,
      origCamY: cam.y,
      movedPx: 0,
    };
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    const drag = dragRef.current;
    if (drag) {
      if (drag.mode === 'pan') {
        drag.movedPx = Math.max(drag.movedPx, Math.hypot(sx - drag.startX, sy - drag.startY));
        setCam((prev) => ({
          ...prev,
          x: drag.origCamX + (sx - drag.startX),
          y: drag.origCamY + (sy - drag.startY),
        }));
      } else if (drag.mode === 'pin' && floorplan) {
        const { tx, ty } = screenToTile(sx, sy);
        const snapped = snapToEdge(tx, ty, floorplan.width, floorplan.height);
        drag.previewEdge = snapped.edge;
        drag.previewOffset = snapped.offset;
        setDragPreview({ kind: 'pin', edge: snapped.edge, offset: snapped.offset });
      } else if (drag.mode === 'macro' && floorplan) {
        const { tx, ty } = screenToTile(sx, sy);
        const nx = Math.max(
          2,
          Math.min(floorplan.width - drag.macro.macro.width - 2, tx - drag.offsetTileX),
        );
        const ny = Math.max(
          2,
          Math.min(floorplan.height - drag.macro.macro.height - 2, ty - drag.offsetTileY),
        );
        drag.previewX = nx;
        drag.previewY = ny;
        setDragPreview({
          kind: 'macro',
          macroId: drag.macro.id,
          x: nx,
          y: ny,
          w: drag.macro.macro.width,
          h: drag.macro.macro.height,
        });
      }
      return;
    }

    if (!floorplan) {
      setHover(null);
      return;
    }
    const { tx, ty } = screenToTile(sx, sy);
    if (tx < -1 || ty < -1 || tx > floorplan.width || ty > floorplan.height) {
      setHover(null);
      return;
    }

    const lines: string[] = [`Tile (${tx}, ${ty})`];
    const hitPin = floorplan.pins.find((p) => p.x === tx && p.y === ty);
    if (hitPin) {
      lines.push(
        `PIN ${hitPin.kind.toUpperCase()}: ${getItemMeta(hitPin.item).name} (${(hitPin.ratePerSec * 60).toFixed(1)}/min)`,
      );
    }
    const hitEnt = entities.find(
      (en) => tx >= en.tx && tx < en.tx + en.w && ty >= en.ty && ty < en.ty + en.h,
    );
    if (hitEnt) {
      lines.push(`Entity: ${hitEnt.name}`);
      if (hitEnt.recipe) lines.push(`Recipe: ${hitEnt.recipe}`);
      if (hitEnt.laneItems) lines.push(`Dual-Lane: ${hitEnt.laneItems.join(' + ')}`);
      else if (hitEnt.item) lines.push(`Item: ${hitEnt.item}`);
      if (hitEnt.netId && sta) {
        const st = sta.nets.find((n) => n.netId === hitEnt.netId);
        if (st) {
          lines.push(
            `Rate: ${st.ratePerSec.toFixed(2)}/s (${(st.utilization * 100).toFixed(0)}% of ${st.beltTier}) — click to trace`,
          );
        }
      }
    }
    setHover({ tx, ty, screenX: sx, screenY: sy, lines });
  };

  const handleMouseUp = (allowClick = true) => {
    const drag = dragRef.current;
    dragRef.current = null;
    setDragPreview(null);
    setIsDragging(false);
    if (!drag) return;

    if (drag.mode === 'pan') {
      if (allowClick && drag.movedPx < 4 && floorplan) {
        const { tx, ty } = screenToTile(drag.startX, drag.startY);
        const hitEnt =
          entities.find(
            (en) =>
              en.netId &&
              (en.role === 'belt-route' || en.role === 'ug-route') &&
              tx >= en.tx &&
              tx < en.tx + en.w &&
              ty >= en.ty &&
              ty < en.ty + en.h,
          ) ??
          entities.find(
            (en) =>
              en.netId &&
              tx >= en.tx &&
              tx < en.tx + en.w &&
              ty >= en.ty &&
              ty < en.ty + en.h,
          );
        if (hitEnt?.netId) {
          onSelect({ kind: 'net', netId: hitEnt.netId });
        } else {
          onSelect(null);
        }
      }
    } else if (drag.mode === 'pin') {
      if (drag.previewEdge !== drag.pin.edge || drag.previewOffset !== drag.pin.offset) {
        onMovePin(drag.pin.id, drag.previewEdge, drag.previewOffset);
      }
    } else if (drag.mode === 'macro') {
      if (drag.previewX !== drag.macro.x || drag.previewY !== drag.macro.y) {
        onMoveMacro(drag.macro.id, drag.previewX, drag.previewY);
      }
    }
  };

  void route;
  const zoomPct = Math.round((cam.scale / 18) * 100);

  return (
    <div
      ref={containerRef}
      style={{ position: 'relative', flex: 1, minHeight: 0, overflow: 'hidden' }}
    >
      <canvas
        ref={canvasRef}
        style={{
          width: '100%',
          height: '100%',
          display: 'block',
          cursor: isDragging ? 'grabbing' : 'grab',
        }}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={() => handleMouseUp(true)}
        onMouseLeave={() => {
          handleMouseUp(false);
          setHover(null);
        }}
      />

      {/* Bottom-left Help & Shortcuts toggle */}
      <div
        style={{
          position: 'absolute',
          bottom: 12,
          left: 12,
          zIndex: 15,
        }}
      >
        <button
          type="button"
          className={`btn btn-sm ${helpOpen ? 'btn-cyan' : ''}`}
          onClick={() => setHelpOpen((o) => !o)}
          title="Canvas Controls & Keyboard Shortcuts"
          aria-expanded={helpOpen}
        >
          <HelpCircle size={13} /> Help
        </button>

        {helpOpen && (
          <div className="canvas-help-card">
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
              <strong style={{ color: 'var(--bp-cyan)', fontSize: 12 }}>
                Controls &amp; Shortcuts
              </strong>
              <button
                type="button"
                className="btn btn-sm"
                style={{ padding: '2px 5px' }}
                onClick={() => setHelpOpen(false)}
                aria-label="Close help"
              >
                <X size={12} />
              </button>
            </div>
            <div className="canvas-help-grid">
              <span className="mono kbd-tag">Drag Pin/Macro</span>
              <span>Move &amp; lock floorplan override</span>
              <span className="mono kbd-tag">Drag Empty</span>
              <span>Pan camera</span>
              <span className="mono kbd-tag">Scroll</span>
              <span>Zoom to cursor</span>
              <span className="mono kbd-tag">Click Belt</span>
              <span>Highlight &amp; inspect net</span>
              <span className="mono kbd-tag">R / F</span>
              <span>Rotate / Flip selected macro</span>
              <span className="mono kbd-tag">A</span>
              <span>Toggle Factorio Alt-Mode icons</span>
              <span className="mono kbd-tag">Space / 0</span>
              <span>Fit blueprint to view</span>
              <span className="mono kbd-tag">Ctrl+Z / Y</span>
              <span>Undo / Redo manual edit</span>
              <span className="mono kbd-tag">Esc</span>
              <span>Clear selection</span>
            </div>
            <div
              style={{
                marginTop: 8,
                paddingTop: 7,
                borderTop: '1px solid var(--bp-border)',
                fontSize: 11,
                color: 'var(--bp-text-muted)',
                lineHeight: 1.4,
              }}
            >
              Factorio Import: click <strong style={{ color: '#e2eef9' }}>Copy Blueprint</strong>,
              then press <span className="mono kbd-tag">Ctrl+V</span> or click{' '}
              <em>Import String</em> in Factorio 2.0.
            </div>
          </div>
        )}
      </div>

      {/* Floating camera controls */}
      <div
        style={{
          position: 'absolute',
          bottom: 12,
          right: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          background: 'rgba(13, 35, 58, 0.9)',
          border: '1px solid var(--bp-border)',
          borderRadius: 6,
          padding: 4,
        }}
      >
        {selection?.kind === 'macro' && (
          <>
            <button
              className="btn btn-sm btn-cyan"
              onClick={() => onRotateMacro(selection.macroId)}
              title="Rotate selected macro 90° (R)"
            >
              <RotateCw size={13} /> Rotate (R)
            </button>
            <button
              className="btn btn-sm btn-cyan"
              onClick={() => onFlipMacro(selection.macroId)}
              title="Mirror selected macro vertically (F)"
            >
              <ArrowUpDown size={13} /> Flip (F)
            </button>
          </>
        )}
        <button
          className="btn btn-sm"
          onClick={() => setCam((c) => ({ ...c, scale: Math.max(3, c.scale / 1.25) }))}
          title="Zoom out"
        >
          <ZoomOut size={13} />
        </button>
        <span
          className="mono"
          style={{
            fontSize: 11,
            color: 'var(--bp-text-muted)',
            minWidth: 38,
            textAlign: 'center',
          }}
          title="Current zoom scale"
        >
          {zoomPct}%
        </span>
        <button
          className="btn btn-sm"
          onClick={() => setCam((c) => ({ ...c, scale: Math.min(64, c.scale * 1.25) }))}
          title="Zoom in"
        >
          <ZoomIn size={13} />
        </button>
        <button className="btn btn-sm" onClick={fitToView} title="Fit die to view (Space)">
          <Maximize2 size={13} /> Fit
        </button>
      </div>

      {/* Hover Tooltip */}
      {hover && hover.lines.length > 1 && !dragPreview && (
        <div
          style={{
            position: 'absolute',
            left: Math.min(size.w - 250, hover.screenX + 14),
            top: Math.min(size.h - 90, Math.max(8, hover.screenY - 12)),
            pointerEvents: 'none',
            background: 'rgba(9, 24, 40, 0.94)',
            border: '1px solid var(--bp-border-bright)',
            borderRadius: 5,
            padding: '6px 9px',
            fontSize: 11,
            fontFamily: 'var(--font-mono)',
            lineHeight: 1.45,
            boxShadow: '0 6px 18px rgba(0,0,0,0.45)',
          }}
        >
          {hover.lines.map((l, i) => (
            <div key={i} style={{ color: i === 0 ? 'var(--bp-cyan)' : 'var(--bp-text)' }}>
              {l}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
