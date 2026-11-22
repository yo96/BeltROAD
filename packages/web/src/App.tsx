import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BELT_SPECS,
  BUILTIN_PRESETS,
  BalancerTemplate,
  DesignSpec,
  DrcReport,
  Edge,
  EntityInstance,
  FloorplanResult,
  InputPreset,
  ModuleName,
  OptimizationLevel,
  PipelineProgress,
  PipelineResult,
  PoleTier,
  PortMarkerMode,
  Rot90,
  RouteResult,
  StaReport,
  SynthesisResult,
  collectLayoutEntities,
  decodeSpecFromUrlHash,
  defaultOptimizationConfig,
  edgeToInwardDir,
  edgeToOutwardDir,
  encodeSpecToUrlHash,
  getCatalog,
  getItemMeta,
  mirrorMacroY,
  renderLayoutToSvg,
  rotateMacro,
} from '@factorio-eda/core';
import {
  AlertTriangle,
  ArrowUpDown,
  CheckCircle2,
  ChevronDown,
  ClipboardCopy,
  Cpu,
  Crosshair,
  Download,
  FileCode2,
  FolderOpen,
  GitBranch,
  Layers,
  Lock,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Plus,
  Redo2,
  RotateCw,
  Share2,
  SlidersHorizontal,
  Trash2,
  Undo2,
  Unlock,
  Wrench,
} from 'lucide-react';
import {
  BlueprintCanvas,
  CanvasLayers,
  RenderMode,
  SelectionTarget,
} from './components/BlueprintCanvas';
import { formatEntityLabel, ItemIcon } from './components/ItemIcon';
import { ItemPicker } from './components/ItemPicker';
import {
  clearLocalFactorioAssets,
  loadLocalFactorioFiles,
} from './sprites/factorioAssets';
import { NetlistView } from './components/NetlistView';
import { YamlEditor } from './components/YamlEditor';
import { BalancerModal } from './components/BalancerModal';
import type { WorkerRequest, WorkerResponse } from './worker/eda.worker';

const MODULE_OPTIONS: { value: '' | ModuleName; label: string }[] = [
  { value: '', label: 'None (No modules)' },
  { value: 'speed-module', label: 'Speed Module 1 (+20% spd)' },
  { value: 'speed-module-2', label: 'Speed Module 2 (+30% spd)' },
  { value: 'speed-module-3', label: 'Speed Module 3 (+50% spd)' },
  { value: 'productivity-module', label: 'Productivity 1 (+4% prod)' },
  { value: 'productivity-module-2', label: 'Productivity 2 (+6% prod)' },
  { value: 'productivity-module-3', label: 'Productivity 3 (+10% prod)' },
  { value: 'efficiency-module', label: 'Efficiency 1 (-30% pwr)' },
  { value: 'efficiency-module-2', label: 'Efficiency 2 (-40% pwr)' },
  { value: 'efficiency-module-3', label: 'Efficiency 3 (-50% pwr)' },
];

function getInitialSpecState(): { spec: DesignSpec; presetId: string } {
  try {
    if (typeof window !== 'undefined' && window.location.hash.includes('spec=')) {
      const decoded = decodeSpecFromUrlHash(window.location.hash);
      if (decoded) return { spec: decoded, presetId: 'custom' };
    }
  } catch {
    // Ignore malformed hash
  }
  return {
    spec: structuredClone(BUILTIN_PRESETS[1].spec),
    presetId: BUILTIN_PRESETS[1].id,
  };
}

function resolveNetEndpointInfo(
  ep: { nodeId: string; pinId: string },
  floorplan: FloorplanResult | null,
): { label: string; tx: number; ty: number } {
  if (ep.nodeId.startsWith('in:') || ep.nodeId.startsWith('out:')) {
    const pin = floorplan?.pins.find((p) => p.id === ep.nodeId);
    return {
      label: ep.nodeId,
      tx: pin?.x ?? 0,
      ty: pin?.y ?? 0,
    };
  }
  const pm = floorplan?.macros.find((m) => m.id === ep.nodeId);
  const mp = pm?.macro.pins.find((p) => p.id === ep.pinId);
  return {
    label: pm ? `${pm.macro.label} (${pm.id})` : ep.nodeId,
    tx: pm && mp ? pm.x + mp.x : pm ? pm.x : 0,
    ty: pm && mp ? pm.y + mp.y : pm ? pm.y : 0,
  };
}

export default function App() {
  const catalog = useMemo(() => getCatalog(), []);
  const targetOptions = useMemo(
    () => [...catalog.solidTargets].sort((a, b) => a.name.localeCompare(b.name)),
    [catalog],
  );

  const initial = useMemo(() => getInitialSpecState(), []);
  const [spec, setSpec] = useState<DesignSpec>(initial.spec);
  const [activePresetId, setActivePresetId] = useState<string>(initial.presetId);
  const [lastRunSpecSig, setLastRunSpecSig] = useState<string>(() => JSON.stringify(initial.spec));

  const [aspectDraft, setAspectDraft] = useState<string>(() =>
    String(initial.spec.floorplan.aspectRatio ?? 1.35),
  );
  const [widthDraft, setWidthDraft] = useState<string>(() =>
    String(initial.spec.floorplan.width ?? 60),
  );
  const [heightDraft, setHeightDraft] = useState<string>(() =>
    String(initial.spec.floorplan.height ?? 45),
  );

  useEffect(() => {
    setAspectDraft(String(spec.floorplan.aspectRatio ?? 1.35));
    if (spec.floorplan.width !== undefined) setWidthDraft(String(spec.floorplan.width));
    if (spec.floorplan.height !== undefined) setHeightDraft(String(spec.floorplan.height));
  }, [spec.floorplan.aspectRatio, spec.floorplan.width, spec.floorplan.height, spec.floorplan.mode]);

  const [historyPast, setHistoryPast] = useState<DesignSpec[]>([]);
  const [historyFuture, setHistoryFuture] = useState<DesignSpec[]>([]);

  const [leftOpen, setLeftOpen] = useState<boolean>(
    () => typeof window === 'undefined' || window.innerWidth >= 960,
  );
  const [rightOpen, setRightOpen] = useState<boolean>(
    () => typeof window === 'undefined' || window.innerWidth >= 1180,
  );
  const [targetUnit, setTargetUnit] = useState<'perMin' | 'perSec' | 'belts'>('perMin');
  const [stepsMenuOpen, setStepsMenuOpen] = useState(false);
  const [layersMenuOpen, setLayersMenuOpen] = useState(false);

  const stepsMenuRef = useRef<HTMLDivElement | null>(null);
  const layersMenuRef = useRef<HTMLDivElement | null>(null);

  const [activeTab, setActiveTab] = useState<'layout' | 'netlist' | 'yaml'>('layout');
  const [balancerModalOpen, setBalancerModalOpen] = useState(false);

  const [synthesis, setSynthesis] = useState<SynthesisResult | null>(null);
  const [floorplan, setFloorplan] = useState<FloorplanResult | null>(null);
  const [route, setRoute] = useState<RouteResult | null>(null);
  const [allEntities, setAllEntities] = useState<EntityInstance[]>([]);
  const [drc, setDrc] = useState<DrcReport | null>(null);
  const [sta, setSta] = useState<StaReport | null>(null);
  const [fullResult, setFullResult] = useState<PipelineResult | null>(null);

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<PipelineProgress | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [selection, setSelection] = useState<SelectionTarget>(null);
  const [focusTile, setFocusTile] = useState<{ tx: number; ty: number; nonce: number } | null>(null);

  const [layers, setLayers] = useState<CanvasLayers>({
    macros: true,
    belts: true,
    undergrounds: true,
    powerGrid: true,
    powerCoverage: false,
    flylines: false,
    heatmap: false,
    pinLabels: true,
    drc: true,
  });

  const [renderMode, setRenderMode] = useState<RenderMode>('factorio');
  const [altMode, setAltMode] = useState(true);
  const [localSpritesInfo, setLocalSpritesInfo] = useState<{
    icons: number;
    entities: number;
  } | null>(null);
  const [assetVersion, setAssetVersion] = useState(0);
  const spriteInputRef = useRef<HTMLInputElement | null>(null);

  const workerRef = useRef<Worker | null>(null);
  const jobIdRef = useRef(1);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => {
      setToast((cur) => (cur === msg ? null : cur));
    }, 2600);
  }, []);

  const postJob = useCallback((req: WorkerRequest) => {
    if (!workerRef.current) return;
    setRunning(true);
    setErrorMsg(null);
    workerRef.current.postMessage(req);
  }, []);

  const pushHistory = useCallback((prevSpec: DesignSpec) => {
    setHistoryPast((past) => [...past.slice(-29), structuredClone(prevSpec)]);
    setHistoryFuture([]);
  }, []);

  const runFull = useCallback(
    (targetSpec: DesignSpec) => {
      const jobId = ++jobIdRef.current;
      setLastRunSpecSig(JSON.stringify(targetSpec));
      postJob({ type: 'run-full', jobId, spec: targetSpec });
    },
    [postJob],
  );

  const commitFloorplanDrafts = useCallback(
    (curSpec: DesignSpec): DesignSpec => {
      const parsedAr = Number(aspectDraft);
      const nextAr = Number.isFinite(parsedAr)
        ? Math.round(Math.max(0.4, Math.min(3.0, parsedAr)) * 100) / 100
        : curSpec.floorplan.aspectRatio ?? 1.35;

      const parsedW = Number(widthDraft);
      const nextW = Number.isFinite(parsedW) && parsedW > 0
        ? Math.max(16, Math.round(parsedW))
        : curSpec.floorplan.width ?? floorplan?.width ?? 60;

      const parsedH = Number(heightDraft);
      const nextH = Number.isFinite(parsedH) && parsedH > 0
        ? Math.max(16, Math.round(parsedH))
        : curSpec.floorplan.height ?? floorplan?.height ?? 45;

      setAspectDraft(String(nextAr));
      if (curSpec.floorplan.mode === 'fixed') {
        setWidthDraft(String(nextW));
        setHeightDraft(String(nextH));
      }

      const nextSpec: DesignSpec = {
        ...curSpec,
        floorplan: {
          ...curSpec.floorplan,
          aspectRatio: nextAr,
          ...(curSpec.floorplan.mode === 'fixed' ? { width: nextW, height: nextH } : {}),
        },
      };
      if (JSON.stringify(nextSpec.floorplan) !== JSON.stringify(curSpec.floorplan)) {
        setSpec(nextSpec);
      }
      return nextSpec;
    },
    [aspectDraft, widthDraft, heightDraft, floorplan],
  );

  const runSynthOnly = useCallback(
    (targetSpec: DesignSpec) => {
      const jobId = ++jobIdRef.current;
      setLastRunSpecSig(JSON.stringify(targetSpec));
      postJob({ type: 'run-synth', jobId, spec: targetSpec });
    },
    [postJob],
  );

  const runPlaceOnly = useCallback(
    (targetSpec: DesignSpec) => {
      const jobId = ++jobIdRef.current;
      setLastRunSpecSig(JSON.stringify(targetSpec));
      postJob({ type: 'run-place', jobId, spec: targetSpec });
    },
    [postJob],
  );

  const runReroute = useCallback(
    (targetSpec: DesignSpec, curSynth: SynthesisResult, curFloorplan: FloorplanResult) => {
      const jobId = ++jobIdRef.current;
      setLastRunSpecSig(JSON.stringify(targetSpec));
      postJob({
        type: 'run-reroute',
        jobId,
        spec: targetSpec,
        synthesis: curSynth,
        floorplan: curFloorplan,
      });
    },
    [postJob],
  );

  const handleUndo = useCallback(() => {
    if (historyPast.length === 0) return;
    const target = historyPast[historyPast.length - 1];
    setHistoryPast((past) => past.slice(0, -1));
    setHistoryFuture((fut) => [structuredClone(spec), ...fut.slice(0, 29)]);
    setSpec(target);
    setActivePresetId('custom');
    setSelection(null);
    runFull(target);
  }, [historyPast, spec, runFull]);

  const handleRedo = useCallback(() => {
    if (historyFuture.length === 0) return;
    const target = historyFuture[0];
    setHistoryFuture((fut) => fut.slice(1));
    setHistoryPast((past) => [...past.slice(-29), structuredClone(spec)]);
    setSpec(target);
    setActivePresetId('custom');
    setSelection(null);
    runFull(target);
  }, [historyFuture, spec, runFull]);

  useEffect(() => {
    if (!stepsMenuOpen && !layersMenuOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (stepsMenuOpen && stepsMenuRef.current && !stepsMenuRef.current.contains(t)) {
        setStepsMenuOpen(false);
      }
      if (layersMenuOpen && layersMenuRef.current && !layersMenuRef.current.contains(t)) {
        setLayersMenuOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setStepsMenuOpen(false);
        setLayersMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [stepsMenuOpen, layersMenuOpen]);

  useEffect(() => {
    const worker = new Worker(new URL('./worker/eda.worker.ts', import.meta.url), {
      type: 'module',
    });
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const msg = event.data;
      if (msg.jobId !== jobIdRef.current) return;

      if (msg.type === 'progress') {
        setProgress(msg.progress);
        return;
      }
      if (msg.type === 'error') {
        setRunning(false);
        setErrorMsg(msg.message);
        return;
      }
      if (msg.type === 'synth-result') {
        setRunning(false);
        setSynthesis(msg.synthesis);
        setFloorplan(null);
        setRoute(null);
        setAllEntities([]);
        setDrc(null);
        setSta(null);
        setFullResult(null);
        setProgress({ stage: 'synth', message: `Synthesized ${msg.synthesis.nets.length} nets` });
        return;
      }
      if (msg.type === 'place-result') {
        setRunning(false);
        setSynthesis(msg.synthesis);
        setFloorplan(msg.floorplan);
        setRoute(null);
        setDrc(null);
        setSta(null);
        setFullResult(null);
        const macroEntities = collectLayoutEntities(
          msg.floorplan,
          {
            width: msg.floorplan.width,
            height: msg.floorplan.height,
            routedNets: [],
            entities: [],
            iterations: 0,
            conflictsRemaining: 0,
            elapsedMs: 0,
            autoExpandedCount: 0,
          },
          {
            entities: [],
            addedPoles: 0,
            totalPoles: 0,
            componentsBefore: 0,
            componentsAfter: 0,
          },
          spec,
        );
        setAllEntities(macroEntities);
        setProgress({
          stage: 'floorplan',
          message: `Placed ${msg.floorplan.macros.length} macros on ${msg.floorplan.width}×${msg.floorplan.height}`,
        });
        return;
      }
      if (msg.type === 'full-result') {
        setRunning(false);
        const r = msg.result;
        setFullResult(r);
        setSynthesis(r.synthesis);
        setFloorplan(r.floorplan);
        setRoute(r.route);
        setAllEntities(r.allEntities);
        setDrc(r.drc);
        setSta(r.sta);
        setProgress({
          stage: 'done',
          message: `Complete in ${r.elapsedMs}ms`,
          elapsedMs: r.elapsedMs,
        });
      }
    };

    // Initial run on mount
    const initJob = ++jobIdRef.current;
    setRunning(true);
    worker.postMessage({ type: 'run-full', jobId: initJob, spec } satisfies WorkerRequest);

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateSpec = (updater: (prev: DesignSpec) => DesignSpec, autoRun = false) => {
    setActivePresetId('custom');
    setSpec((prev) => {
      const next = updater(prev);
      if (autoRun) runFull(next);
      return next;
    });
  };

  const handleMovePin = useCallback(
    (pinId: string, edge: Edge, offset: number) => {
      pushHistory(spec);
      setActivePresetId('custom');
      const nextSpec: DesignSpec = {
        ...spec,
        pins: [
          ...spec.pins.filter((p) => p.id !== pinId),
          { id: pinId, edge, offset, locked: true },
        ],
      };
      setSpec(nextSpec);

      if (synthesis && floorplan) {
        const nextPins = floorplan.pins.map((p) => {
          if (p.id !== pinId) return p;
          const x = edge === 'W' ? 0 : edge === 'E' ? floorplan.width - 1 : offset;
          const y = edge === 'N' ? 0 : edge === 'S' ? floorplan.height - 1 : offset;
          const dir =
            p.kind === 'input' ? edgeToInwardDir(edge) : edgeToOutwardDir(edge);
          return { ...p, edge, offset, x, y, dir, locked: true };
        });
        const nextFloorplan: FloorplanResult = { ...floorplan, pins: nextPins };
        setFloorplan(nextFloorplan);
        runReroute(nextSpec, synthesis, nextFloorplan);
      } else {
        runFull(nextSpec);
      }
    },
    [spec, synthesis, floorplan, pushHistory, runReroute, runFull],
  );

  const handleMoveMacro = useCallback(
    (macroId: string, x: number, y: number) => {
      pushHistory(spec);
      setActivePresetId('custom');
      const existingOv = spec.macroOverrides[macroId] ?? {};
      const nextSpec: DesignSpec = {
        ...spec,
        macroOverrides: {
          ...spec.macroOverrides,
          [macroId]: { ...existingOv, x, y, locked: true },
        },
      };
      setSpec(nextSpec);

      if (synthesis && floorplan) {
        const nextMacros = floorplan.macros.map((m) =>
          m.id === macroId ? { ...m, x, y, locked: true } : m,
        );
        const nextFloorplan: FloorplanResult = { ...floorplan, macros: nextMacros };
        setFloorplan(nextFloorplan);
        runReroute(nextSpec, synthesis, nextFloorplan);
      }
    },
    [spec, synthesis, floorplan, pushHistory, runReroute],
  );

  const handleRotateMacro = useCallback(
    (macroId: string) => {
      if (!floorplan) return;
      const pm = floorplan.macros.find((m) => m.id === macroId);
      if (!pm) return;
      pushHistory(spec);
      setActivePresetId('custom');
      const nextRot = (((pm.macro.rotation + 1) % 4) as Rot90);
      const baseVariant =
        pm.variants.find((v) => v.rows === pm.macro.rows) ?? pm.variants[0];
      const flipped = pm.macro.flippedY ? mirrorMacroY(baseVariant) : baseVariant;
      const rotated = rotateMacro(flipped, nextRot);
      const nx = Math.max(2, Math.min(floorplan.width - rotated.width - 2, pm.x));
      const ny = Math.max(2, Math.min(floorplan.height - rotated.height - 2, pm.y));

      const existingOv = spec.macroOverrides[macroId] ?? {};
      const nextSpec: DesignSpec = {
        ...spec,
        macroOverrides: {
          ...spec.macroOverrides,
          [macroId]: {
            ...existingOv,
            x: nx,
            y: ny,
            rotation: nextRot,
            flipY: pm.macro.flippedY,
            locked: true,
          },
        },
      };
      setSpec(nextSpec);

      if (synthesis) {
        const nextMacros = floorplan.macros.map((m) =>
          m.id === macroId ? { ...m, x: nx, y: ny, macro: rotated, locked: true } : m,
        );
        const nextFloorplan: FloorplanResult = { ...floorplan, macros: nextMacros };
        setFloorplan(nextFloorplan);
        runReroute(nextSpec, synthesis, nextFloorplan);
      }
    },
    [floorplan, spec, synthesis, pushHistory, runReroute],
  );

  const handleFlipMacro = useCallback(
    (macroId: string) => {
      if (!floorplan) return;
      const pm = floorplan.macros.find((m) => m.id === macroId);
      if (!pm) return;
      pushHistory(spec);
      setActivePresetId('custom');
      const nextFlip = !pm.macro.flippedY;
      const baseVariant =
        pm.variants.find((v) => v.rows === pm.macro.rows) ?? pm.variants[0];
      const oriented = rotateMacro(
        nextFlip ? mirrorMacroY(baseVariant) : baseVariant,
        pm.macro.rotation,
      );

      const existingOv = spec.macroOverrides[macroId] ?? {};
      const nextSpec: DesignSpec = {
        ...spec,
        macroOverrides: {
          ...spec.macroOverrides,
          [macroId]: {
            ...existingOv,
            x: pm.x,
            y: pm.y,
            rotation: pm.macro.rotation,
            flipY: nextFlip,
            locked: true,
          },
        },
      };
      setSpec(nextSpec);

      if (synthesis) {
        const nextMacros = floorplan.macros.map((m) =>
          m.id === macroId ? { ...m, macro: oriented, locked: true } : m,
        );
        const nextFloorplan: FloorplanResult = { ...floorplan, macros: nextMacros };
        setFloorplan(nextFloorplan);
        runReroute(nextSpec, synthesis, nextFloorplan);
      }
    },
    [floorplan, spec, synthesis, pushHistory, runReroute],
  );

  const handleCopyBlueprint = async () => {
    if (!fullResult?.blueprintString) return;
    await navigator.clipboard.writeText(fullResult.blueprintString);
    showToast(
      `Copied Factorio 2.0 blueprint string (${allEntities.length} entities)!`,
    );
  };

  const handleCopyUnitTile = async () => {
    const t = fullResult?.tiling;
    if (!t?.unitBlueprintString) return;
    await navigator.clipboard.writeText(t.unitBlueprintString);
    showToast(
      `Copied 1× unit tile blueprint (${t.unitWidth}×${t.unitHeight}, ${t.unitMachines} machines)!`,
    );
  };

  const handleShareUrl = async () => {
    const hash = encodeSpecToUrlHash(spec);
    window.history.replaceState(null, '', hash);
    await navigator.clipboard.writeText(window.location.href);
    showToast('Copied shareable design URL to clipboard!');
  };

  const handleExportSvg = () => {
    if (!fullResult) return;
    const svg = renderLayoutToSvg(fullResult);
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${spec.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'layout'}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const beltCapacity = BELT_SPECS[spec.pdk.defaultBeltTier].itemsPerSec * 60;
  const currentGlobalModule = spec.pdk.modules.global[0] ?? '';

  const selectedPin =
    selection?.kind === 'pin'
      ? floorplan?.pins.find((p) => p.id === selection.pinId) ?? null
      : null;
  const selectedMacro =
    selection?.kind === 'macro'
      ? floorplan?.macros.find((m) => m.id === selection.macroId) ?? null
      : null;
  const selectedNet =
    selection?.kind === 'net'
      ? synthesis?.nets.find((n) => n.id === selection.netId) ?? null
      : null;
  const selectedRoutedNet =
    selection?.kind === 'net'
      ? route?.routedNets.find((r) => r.netId === selection.netId) ?? null
      : null;
  const selectedStaNet =
    selection?.kind === 'net'
      ? sta?.nets.find((n) => n.netId === selection.netId) ?? null
      : null;

  const selectedNetBends = useMemo(() => {
    if (!selectedRoutedNet || selectedRoutedNet.tiles.length < 2) return 0;
    let bends = 0;
    for (let i = 1; i < selectedRoutedNet.tiles.length; i++) {
      if (selectedRoutedNet.tiles[i].dir !== selectedRoutedNet.tiles[i - 1].dir) {
        bends++;
      }
    }
    return bends;
  }, [selectedRoutedNet]);

  const isSpecDirty = useMemo(
    () => !running && JSON.stringify(spec) !== lastRunSpecSig,
    [running, spec, lastRunSpecSig],
  );

  const activeLayerCount = Object.values(layers).filter(Boolean).length;

  const formatTargetInputValue = (ratePerMin: number): number => {
    if (targetUnit === 'perSec') return Number((ratePerMin / 60).toFixed(2));
    if (targetUnit === 'belts') return Number((ratePerMin / beltCapacity).toFixed(2));
    return Math.round(ratePerMin * 10) / 10;
  };

  return (
    <div className="studio-shell">
      {/* Top EDA Toolbar */}
      <header className="top-bar">
        <div className="row" style={{ gap: 6 }}>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setLeftOpen((o) => !o)}
            title={leftOpen ? 'Collapse Spec & PDK Panel' : 'Expand Spec & PDK Panel'}
            aria-label="Toggle Spec & PDK Panel"
          >
            {leftOpen ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
          </button>

          <div className="brand">
            <Cpu size={18} color="#f59e0b" />
            <span>BeltROAD</span>
            <span className="brand-badge">2.0 EDA</span>
          </div>
        </div>

        <select
          className="select"
          style={{ width: 215 }}
          value={activePresetId}
          aria-label="Design preset"
          onChange={(e) => {
            const p = BUILTIN_PRESETS.find((pr) => pr.id === e.target.value);
            if (p) {
              pushHistory(spec);
              const cloned = structuredClone(p.spec);
              setSpec(cloned);
              setActivePresetId(p.id);
              setSelection(null);
              runFull(cloned);
            }
          }}
        >
          <option value="custom" disabled>
            Custom Design
          </option>
          {BUILTIN_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>

        {/* Execution Controls & Undo/Redo */}
        <div className="row" style={{ gap: 4 }}>
          <button
            type="button"
            className="btn btn-sm"
            onClick={handleUndo}
            disabled={running || historyPast.length === 0}
            title="Undo last floorplan edit (Ctrl+Z)"
            aria-label="Undo"
          >
            <Undo2 size={13} />
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={handleRedo}
            disabled={running || historyFuture.length === 0}
            title="Redo floorplan edit (Ctrl+Y)"
            aria-label="Redo"
          >
            <Redo2 size={13} />
          </button>

          <div ref={stepsMenuRef} className="popover-anchor">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setStepsMenuOpen((o) => !o)}
              disabled={running}
              title="Run individual EDA pipeline stages"
              aria-expanded={stepsMenuOpen}
            >
              Steps <ChevronDown size={12} />
            </button>

            {stepsMenuOpen && (
              <div className="popover-menu left-align" style={{ minWidth: 215 }}>
                <button
                  type="button"
                  className="popover-item"
                  disabled={running}
                  onClick={() => {
                    setStepsMenuOpen(false);
                    runSynthOnly(spec);
                  }}
                >
                  1. Synthesize Only
                </button>
                <button
                  type="button"
                  className="popover-item"
                  disabled={running}
                  onClick={() => {
                    setStepsMenuOpen(false);
                    runPlaceOnly(commitFloorplanDrafts(spec));
                  }}
                >
                  2. Synth + Place
                </button>
                <button
                  type="button"
                  className="popover-item"
                  disabled={running || !synthesis || !floorplan}
                  onClick={() => {
                    setStepsMenuOpen(false);
                    if (synthesis && floorplan) runReroute(spec, synthesis, floorplan);
                  }}
                >
                  3. Re-Route Current Floorplan
                </button>
              </div>
            )}
          </div>

          <button
            type="button"
            className={`btn btn-primary btn-sm ${isSpecDirty ? 'btn-dirty' : ''}`}
            onClick={() => runFull(commitFloorplanDrafts(spec))}
            disabled={running}
            title={
              isSpecDirty
                ? 'Spec modified — click to re-run P&R'
                : 'Synthesize, Place, Route, PDN & Verify'
            }
          >
            <Play size={13} /> {running ? 'Running…' : 'Run Full P&R'}
            {isSpecDirty && <span className="dirty-dot" aria-label="Changes pending" />}
          </button>
        </div>

        {progress && (
          <span className="pill pill-info">
            {running ? '⏳ ' : ''}
            {progress.message}
          </span>
        )}
        {fullResult?.tiling && (
          <span
            className="pill pill-pass mono"
            title={`${fullResult.tiling.unitWidth}×${fullResult.tiling.unitHeight} unit tile stamped ${fullResult.tiling.tileCount}× (${fullResult.tiling.layout})`}
          >
            Tiled {fullResult.tiling.tileCount}× ({fullResult.tiling.cols}×{fullResult.tiling.rows})
          </span>
        )}

        <div style={{ marginLeft: 'auto' }} className="row">
          {fullResult?.tiling?.unitBlueprintString && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={handleCopyUnitTile}
              title={`Copy single 1× repeatable tile (${fullResult.tiling.unitWidth}×${fullResult.tiling.unitHeight}, ${fullResult.tiling.unitMachines} machines)`}
            >
              <ClipboardCopy size={13} /> Copy 1× Tile
            </button>
          )}
          <button
            type="button"
            className="btn btn-cyan btn-sm"
            disabled={!fullResult?.blueprintString}
            onClick={handleCopyBlueprint}
          >
            <ClipboardCopy size={13} /> Copy Blueprint
          </button>
          <button type="button" className="btn btn-sm" onClick={handleShareUrl}>
            <Share2 size={13} /> Share URL
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={!fullResult}
            onClick={handleExportSvg}
          >
            <Download size={13} /> Export SVG
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setRightOpen((o) => !o)}
            title={rightOpen ? 'Collapse Inspector & Signoff Panel' : 'Expand Inspector & Signoff Panel'}
            aria-label="Toggle Inspector & Signoff Panel"
          >
            {rightOpen ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
          </button>
        </div>
      </header>

      {errorMsg && (
        <div
          style={{
            background: 'rgba(248, 113, 113, 0.18)',
            borderBottom: '1px solid rgba(248, 113, 113, 0.5)',
            color: '#fecaca',
            padding: '6px 14px',
            fontSize: 12,
          }}
        >
          Engine Error: {errorMsg}
        </div>
      )}

      {/* Main 3-Column EDA Workbench */}
      <div
        className="workspace-grid"
        style={{
          gridTemplateColumns: [
            leftOpen ? '305px' : null,
            'minmax(0, 1fr)',
            rightOpen ? '315px' : null,
          ]
            .filter(Boolean)
            .join(' '),
        }}
      >
        {/* Left Panel: Spec & PDK */}
        <aside className={`side-panel ${leftOpen ? '' : 'collapsed'}`}>
          <div className="panel-section">
            <div className="section-title">
              <span>Design Targets</span>
              <div className="row" style={{ gap: 5 }}>
                <div className="unit-toggle" role="group" aria-label="Target rate unit">
                  <button
                    type="button"
                    className={`unit-btn ${targetUnit === 'perMin' ? 'active' : ''}`}
                    onClick={() => setTargetUnit('perMin')}
                  >
                    /min
                  </button>
                  <button
                    type="button"
                    className={`unit-btn ${targetUnit === 'perSec' ? 'active' : ''}`}
                    onClick={() => setTargetUnit('perSec')}
                  >
                    /s
                  </button>
                  <button
                    type="button"
                    className={`unit-btn ${targetUnit === 'belts' ? 'active' : ''}`}
                    onClick={() => setTargetUnit('belts')}
                  >
                    belts
                  </button>
                </div>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() =>
                    updateSpec((prev) => ({
                      ...prev,
                      targets: [...prev.targets, { item: 'iron-gear-wheel', ratePerMin: 60 }],
                    }))
                  }
                >
                  <Plus size={12} /> Add
                </button>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              {spec.targets.map((t, idx) => (
                <div
                  key={idx}
                  style={{
                    background: '#0b1e33',
                    border: '1px solid var(--bp-border)',
                    borderRadius: 5,
                    padding: 6,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 5,
                  }}
                >
                  <div className="row">
                    <ItemPicker
                      value={t.item}
                      options={targetOptions}
                      onChange={(val) => {
                        updateSpec((prev) => ({
                          ...prev,
                          targets: prev.targets.map((item, i) =>
                            i === idx ? { ...item, item: val } : item,
                          ),
                        }));
                      }}
                    />
                    {spec.targets.length > 1 && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() =>
                          updateSpec((prev) => ({
                            ...prev,
                            targets: prev.targets.filter((_, i) => i !== idx),
                          }))
                        }
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <div className="row" style={{ flex: 1 }}>
                      <input
                        type="number"
                        className="input mono"
                        min={targetUnit === 'perMin' ? 1 : 0.01}
                        step={
                          targetUnit === 'perMin' ? 15 : targetUnit === 'perSec' ? 1 : 0.25
                        }
                        value={formatTargetInputValue(t.ratePerMin)}
                        onChange={(e) => {
                          const raw = Number(e.target.value);
                          const num = Number.isFinite(raw) ? raw : 0;
                          let nextPerMin = num;
                          if (targetUnit === 'perSec') nextPerMin = num * 60;
                          else if (targetUnit === 'belts') nextPerMin = num * beltCapacity;
                          const clamped = Math.max(0.5, Math.round(nextPerMin * 100) / 100);
                          updateSpec((prev) => ({
                            ...prev,
                            targets: prev.targets.map((item, i) =>
                              i === idx ? { ...item, ratePerMin: clamped } : item,
                            ),
                          }));
                        }}
                      />
                      <span style={{ fontSize: 11, color: 'var(--bp-text-muted)' }}>
                        {targetUnit === 'perMin'
                          ? '/min'
                          : targetUnit === 'perSec'
                            ? '/s'
                            : 'belts'}
                      </span>
                    </div>
                    <span className="mono" style={{ fontSize: 11, color: 'var(--bp-cyan)' }}>
                      {targetUnit === 'belts'
                        ? `${Math.round(t.ratePerMin)}/min`
                        : `${(t.ratePerMin / beltCapacity).toFixed(2)} belts`}
                    </span>
                  </div>
                </div>
              ))}
            </div>

            <div style={{ marginTop: 10 }}>
              <label className="field-label">Input Pin Boundary Preset</label>
              <select
                className="select"
                value={spec.inputPreset}
                onChange={(e) =>
                  updateSpec(
                    (prev) => ({
                      ...prev,
                      inputPreset: e.target.value as InputPreset,
                      inputOverrides: {},
                    }),
                    true,
                  )
                }
              >
                <option value="plates">Plates &amp; Raw (Iron/Copper/Steel/Brick)</option>
                <option value="bus">Bus Intermediates (+ Green/Red Circuits, Plastic)</option>
                <option value="raw">Raw Ores Only (Include Electric Smelting)</option>
              </select>
            </div>
          </div>

          {/* PDK / SDK Configuration */}
          <div className="panel-section">
            <div className="section-title">
              <span>PDK / Technology SDK</span>
              <Wrench size={12} />
            </div>

            <div className="field-grid">
              <div>
                <label className="field-label">Belt Tier</label>
                <select
                  className="select"
                  value={spec.pdk.defaultBeltTier}
                  onChange={(e) => {
                    const tier = e.target.value as 'yellow' | 'red' | 'blue';
                    updateSpec((prev) => ({
                      ...prev,
                      pdk: { ...prev.pdk, defaultBeltTier: tier },
                    }));
                  }}
                >
                  <option value="yellow">Yellow (15/s)</option>
                  <option value="red">Red Fast (30/s)</option>
                  <option value="blue">Blue Express (45/s)</option>
                </select>
              </div>
              <div>
                <label className="field-label">Assembler Tier</label>
                <select
                  className="select"
                  value={spec.pdk.defaultAssemblerTier}
                  onChange={(e) => {
                    const tier = Number(e.target.value) as 1 | 2 | 3;
                    updateSpec((prev) => ({
                      ...prev,
                      pdk: { ...prev.pdk, defaultAssemblerTier: tier },
                    }));
                  }}
                >
                  <option value={1}>Assembler 1 (0.5×)</option>
                  <option value={2}>Assembler 2 (0.75×)</option>
                  <option value={3}>Assembler 3 (1.25×)</option>
                </select>
              </div>
              <div>
                <label className="field-label">Default Inserter</label>
                <select
                  className="select"
                  value={spec.pdk.defaultInserterTier}
                  onChange={(e) => {
                    const tier = e.target.value as 'yellow' | 'fast' | 'bulk';
                    updateSpec((prev) => ({
                      ...prev,
                      pdk: { ...prev.pdk, defaultInserterTier: tier },
                    }));
                  }}
                >
                  <option value="yellow">Yellow Inserter</option>
                  <option value="fast">Fast Inserter</option>
                  <option value="bulk">Bulk Inserter</option>
                </select>
              </div>
              <div>
                <label className="field-label">Power Pole</label>
                <select
                  className="select"
                  value={spec.pdk.defaultPoleTier}
                  onChange={(e) => {
                    const tier = e.target.value as PoleTier;
                    updateSpec((prev) => ({
                      ...prev,
                      pdk: { ...prev.pdk, defaultPoleTier: tier },
                    }));
                  }}
                >
                  <option value="small">Small Pole</option>
                  <option value="medium">Medium Pole</option>
                  <option value="substation">Substation (2×2)</option>
                </select>
              </div>
            </div>

            <div style={{ marginTop: 8 }}>
              <label className="field-label">In-Machine Modules (fill slots)</label>
              <select
                className="select"
                value={currentGlobalModule}
                onChange={(e) => {
                  const mod = e.target.value as '' | ModuleName;
                  updateSpec((prev) => ({
                    ...prev,
                    pdk: {
                      ...prev.pdk,
                      modules: {
                        ...prev.pdk.modules,
                        global: mod ? [mod, mod, mod, mod] : [],
                      },
                    },
                  }));
                }}
              >
                {MODULE_OPTIONS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="field-grid" style={{ marginTop: 8 }}>
              <div>
                <label className="field-label">Port Markers</label>
                <select
                  className="select"
                  value={spec.pdk.portMarkers}
                  onChange={(e) =>
                    updateSpec((prev) => ({
                      ...prev,
                      pdk: {
                        ...prev.pdk,
                        portMarkers: e.target.value as PortMarkerMode,
                      },
                    }))
                  }
                >
                  <option value="display-panel">Display Panel (2.0)</option>
                  <option value="constant-combinator">Const Combinator</option>
                  <option value="none">None</option>
                </select>
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 4 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 11.5 }}>
                  <input
                    type="checkbox"
                    checked={spec.pdk.downsizeLowRateBelts}
                    onChange={(e) =>
                      updateSpec((prev) => ({
                        ...prev,
                        pdk: { ...prev.pdk, downsizeLowRateBelts: e.target.checked },
                      }))
                    }
                  />
                  Downsize low-rate belts
                </label>
              </div>
            </div>

            <div style={{ marginTop: 10 }}>
              <button
                className="btn btn-sm"
                style={{ width: '100%', justifyContent: 'center' }}
                onClick={() => setBalancerModalOpen(true)}
              >
                Balancer IP Library ({spec.customBalancers?.length ?? 0} custom)
              </button>
            </div>
          </div>

          {/* Floorplan / Die */}
          <div className="panel-section">
            <div className="section-title">Die &amp; Floorplan</div>
            <div className="field-grid">
              <div>
                <label className="field-label">Die Mode</label>
                <select
                  className="select"
                  value={spec.floorplan.mode}
                  onChange={(e) => {
                    const nextMode = e.target.value as 'auto' | 'fixed';
                    const initW = floorplan?.width ?? spec.floorplan.width ?? 60;
                    const initH = floorplan?.height ?? spec.floorplan.height ?? 45;
                    if (nextMode === 'fixed') {
                      setWidthDraft(String(initW));
                      setHeightDraft(String(initH));
                    }
                    updateSpec((prev) => ({
                      ...prev,
                      floorplan: {
                        ...prev.floorplan,
                        mode: nextMode,
                        ...(nextMode === 'fixed' ? { width: initW, height: initH } : {}),
                      },
                    }));
                  }}
                >
                  <option value="auto">Auto-Compact</option>
                  <option value="fixed">Fixed W × H</option>
                </select>
              </div>
              {spec.floorplan.mode === 'auto' ? (
                <div>
                  <label className="field-label">Aspect Ratio</label>
                  <input
                    type="number"
                    className="input mono"
                    step={0.1}
                    min={0.4}
                    max={3.0}
                    value={aspectDraft}
                    onChange={(e) => {
                      const raw = e.target.value;
                      setAspectDraft(raw);
                      const v = Number(raw);
                      if (raw.trim() !== '' && Number.isFinite(v) && v >= 0.4 && v <= 3.0) {
                        updateSpec((prev) => ({
                          ...prev,
                          floorplan: {
                            ...prev.floorplan,
                            aspectRatio: Math.round(v * 100) / 100,
                          },
                        }));
                      }
                    }}
                    onBlur={() => {
                      const v = Number(aspectDraft);
                      const clamped =
                        aspectDraft.trim() !== '' && Number.isFinite(v)
                          ? Math.round(Math.max(0.4, Math.min(3.0, v)) * 100) / 100
                          : spec.floorplan.aspectRatio ?? 1.35;
                      setAspectDraft(String(clamped));
                      updateSpec((prev) => ({
                        ...prev,
                        floorplan: { ...prev.floorplan, aspectRatio: clamped },
                      }));
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') runFull(commitFloorplanDrafts(spec));
                    }}
                  />
                </div>
              ) : (
                <div className="row">
                  <div>
                    <label className="field-label">W</label>
                    <input
                      type="number"
                      className="input mono"
                      min={16}
                      value={widthDraft}
                      onChange={(e) => {
                        const raw = e.target.value;
                        setWidthDraft(raw);
                        const v = Number(raw);
                        if (raw.trim() !== '' && Number.isFinite(v) && v >= 1) {
                          updateSpec((prev) => ({
                            ...prev,
                            floorplan: { ...prev.floorplan, width: Math.round(v) },
                          }));
                        }
                      }}
                      onBlur={() => {
                        const v = Number(widthDraft);
                        const clamped =
                          widthDraft.trim() !== '' && Number.isFinite(v) && v > 0
                            ? Math.max(16, Math.round(v))
                            : spec.floorplan.width ?? floorplan?.width ?? 60;
                        setWidthDraft(String(clamped));
                        updateSpec((prev) => ({
                          ...prev,
                          floorplan: { ...prev.floorplan, width: clamped },
                        }));
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') runFull(commitFloorplanDrafts(spec));
                      }}
                    />
                  </div>
                  <div>
                    <label className="field-label">H</label>
                    <input
                      type="number"
                      className="input mono"
                      min={16}
                      value={heightDraft}
                      onChange={(e) => {
                        const raw = e.target.value;
                        setHeightDraft(raw);
                        const v = Number(raw);
                        if (raw.trim() !== '' && Number.isFinite(v) && v >= 1) {
                          updateSpec((prev) => ({
                            ...prev,
                            floorplan: { ...prev.floorplan, height: Math.round(v) },
                          }));
                        }
                      }}
                      onBlur={() => {
                        const v = Number(heightDraft);
                        const clamped =
                          heightDraft.trim() !== '' && Number.isFinite(v) && v > 0
                            ? Math.max(16, Math.round(v))
                            : spec.floorplan.height ?? floorplan?.height ?? 45;
                        setHeightDraft(String(clamped));
                        updateSpec((prev) => ({
                          ...prev,
                          floorplan: { ...prev.floorplan, height: clamped },
                        }));
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') runFull(commitFloorplanDrafts(spec));
                      }}
                    />
                  </div>
                </div>
              )}
            </div>
            <div style={{ marginTop: 8 }}>
              <label className="field-label">Optimization Pass Level</label>
              <select
                className="select"
                value={spec.optimization?.level ?? 'compact'}
                onChange={(e) => {
                  const lvl = e.target.value as OptimizationLevel;
                  updateSpec(
                    (prev) => {
                      const nextOpt = defaultOptimizationConfig(lvl);
                      return {
                        ...prev,
                        optimization: {
                          ...nextOpt,
                          tiling: prev.optimization?.tiling ?? nextOpt.tiling,
                          tileLayout: prev.optimization?.tileLayout ?? nextOpt.tileLayout,
                        },
                      };
                    },
                    true,
                  );
                }}
              >
                <option value="compact">Compact (Layered Bus + All Opts)</option>
                <option value="balanced">Balanced (Layered + Compact)</option>
                <option value="fast">Fast</option>
              </select>
            </div>
            <div style={{ marginTop: 8 }}>
              <label className="field-label">Large-Factory Tiling</label>
              <select
                className="select"
                value={
                  spec.optimization?.tiling === 'off'
                    ? 'off'
                    : spec.optimization?.tileLayout === 'twin'
                      ? 'twin'
                      : spec.optimization?.tileLayout === 'stack'
                        ? 'stack'
                        : 'auto'
                }
                onChange={(e) => {
                  const val = e.target.value as 'auto' | 'twin' | 'stack' | 'off';
                  updateSpec((prev) => {
                    const base = prev.optimization ?? defaultOptimizationConfig('compact');
                    return {
                      ...prev,
                      optimization: {
                        ...base,
                        tiling: val === 'off' ? 'off' : 'auto',
                        tileLayout: val === 'off' ? 'auto' : val,
                      },
                    };
                  }, true);
                }}
              >
                <option value="auto">Auto (Divide &amp; Conquer)</option>
                <option value="twin">Twin-Wing (2×R Mirrored)</option>
                <option value="stack">1D Bus Stack (1×K)</option>
                <option value="off">Off (Flat P&amp;R)</option>
              </select>
            </div>
            {(spec.pins.length > 0 || Object.keys(spec.macroOverrides).length > 0) && (
              <button
                className="btn btn-sm"
                style={{ width: '100%', marginTop: 8, justifyContent: 'center' }}
                onClick={() => {
                  pushHistory(spec);
                  updateSpec(
                    (prev) => ({ ...prev, pins: [], macroOverrides: {} }),
                    true,
                  );
                }}
              >
                Reset Pin &amp; Macro Overrides
              </button>
            )}
          </div>
        </aside>

        {/* Center: Tabs + Blueprint Canvas / Netlist / YAML */}
        <main className="center-stage">
          <div className="tab-strip">
            <div className="tab-buttons">
              <button
                className={`tab-btn ${activeTab === 'layout' ? 'active' : ''}`}
                onClick={() => setActiveTab('layout')}
              >
                <Layers size={14} /> Layout Canvas
              </button>
              <button
                className={`tab-btn ${activeTab === 'netlist' ? 'active' : ''}`}
                onClick={() => setActiveTab('netlist')}
              >
                <GitBranch size={14} /> Netlist DAG
              </button>
              <button
                className={`tab-btn ${activeTab === 'yaml' ? 'active' : ''}`}
                onClick={() => setActiveTab('yaml')}
              >
                <FileCode2 size={14} /> YAML Spec
              </button>
            </div>

            {activeTab === 'layout' && (
              <div className="layer-chips">
                <div className="mode-toggle" role="group" aria-label="Visualization mode">
                  <button
                    className={`mode-btn ${renderMode === 'eda' ? 'active' : ''}`}
                    onClick={() => setRenderMode('eda')}
                    title="Technical EDA Blueprint Schematic View"
                  >
                    EDA Schematic
                  </button>
                  <button
                    className={`mode-btn ${renderMode === 'factorio' ? 'active' : ''}`}
                    onClick={() => setRenderMode('factorio')}
                    title="Factorio 2.0 Game-Object & Icon View"
                  >
                    Factorio View
                  </button>
                </div>

                {renderMode === 'factorio' && (
                  <button
                    className={`chip ${altMode ? 'on' : ''}`}
                    onClick={() => setAltMode((a) => !a)}
                    title="Toggle Factorio Alt-Mode item & recipe icons (A)"
                  >
                    Alt-Mode
                  </button>
                )}

                <input
                  ref={spriteInputRef}
                  type="file"
                  multiple
                  {...({ webkitdirectory: '', directory: '' } as React.InputHTMLAttributes<HTMLInputElement>)}
                  style={{ display: 'none' }}
                  onChange={async (e) => {
                    const files = e.target.files;
                    if (!files || files.length === 0) return;
                    const stats = await loadLocalFactorioFiles(files);
                    setLocalSpritesInfo(stats);
                    setAssetVersion((v) => v + 1);
                    showToast(
                      `Loaded ${stats.entities} entity sheets & ${stats.icons} icons from local Factorio folder!`,
                    );
                    e.target.value = '';
                  }}
                />

                <div ref={layersMenuRef} className="popover-anchor">
                  <button
                    type="button"
                    className={`btn btn-sm ${layersMenuOpen ? 'btn-cyan' : ''}`}
                    onClick={() => setLayersMenuOpen((o) => !o)}
                    aria-expanded={layersMenuOpen}
                  >
                    <SlidersHorizontal size={12} /> Layers ({activeLayerCount}/9){' '}
                    <ChevronDown size={12} />
                  </button>

                  {layersMenuOpen && (
                    <div className="popover-menu" style={{ minWidth: 235 }}>
                      <div className="popover-group-title">Layout</div>
                      {(
                        [
                          ['macros', 'Macros & Labels'],
                          ['belts', 'Surface Belts & Splitters'],
                          ['undergrounds', 'Undergrounds & Spans'],
                          ['pinLabels', 'Pins & Labels'],
                        ] as const
                      ).map(([key, label]) => (
                        <label key={key} className="popover-item">
                          <input
                            type="checkbox"
                            checked={layers[key]}
                            onChange={() =>
                              setLayers((l) => ({ ...l, [key]: !l[key] }))
                            }
                          />
                          <span>{label}</span>
                        </label>
                      ))}

                      <div className="popover-divider" />
                      <div className="popover-group-title">Power Grid</div>
                      {(
                        [
                          ['powerGrid', 'Poles & Copper Wires'],
                          ['powerCoverage', 'Supply Area'],
                        ] as const
                      ).map(([key, label]) => (
                        <label key={key} className="popover-item">
                          <input
                            type="checkbox"
                            checked={layers[key]}
                            onChange={() =>
                              setLayers((l) => ({ ...l, [key]: !l[key] }))
                            }
                          />
                          <span>{label}</span>
                        </label>
                      ))}

                      <div className="popover-divider" />
                      <div className="popover-group-title">Overlays</div>
                      {(
                        [
                          ['heatmap', 'Util Heatmap'],
                          ['flylines', 'Flylines'],
                          ['drc', 'DRC Markers'],
                        ] as const
                      ).map(([key, label]) => (
                        <label key={key} className="popover-item">
                          <input
                            type="checkbox"
                            checked={layers[key]}
                            onChange={() =>
                              setLayers((l) => ({ ...l, [key]: !l[key] }))
                            }
                          />
                          <span>{label}</span>
                        </label>
                      ))}

                      {renderMode === 'factorio' && (
                        <>
                          <div className="popover-divider" />
                          <div className="popover-group-title">Sprites</div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '2px 4px' }}>
                            <button
                              type="button"
                              className="btn btn-sm"
                              style={{ justifyContent: 'center' }}
                              onClick={() => spriteInputRef.current?.click()}
                              title="Pick your local Factorio/data/base/graphics folder"
                            >
                              <FolderOpen size={12} />{' '}
                              {localSpritesInfo
                                ? `Local (${localSpritesInfo.entities}ent/${localSpritesInfo.icons}ico)`
                                : 'Load Local Factorio Sprites…'}
                            </button>
                            {localSpritesInfo && (
                              <button
                                type="button"
                                className="btn btn-sm"
                                style={{ justifyContent: 'center' }}
                                onClick={() => {
                                  clearLocalFactorioAssets();
                                  setLocalSpritesInfo(null);
                                  setAssetVersion((v) => v + 1);
                                }}
                              >
                                Revert to CDN Sprites
                              </button>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {activeTab === 'layout' && (
            <BlueprintCanvas
              synthesis={synthesis}
              floorplan={floorplan}
              route={route}
              entities={allEntities}
              drc={drc}
              sta={sta}
              layers={layers}
              renderMode={renderMode}
              altMode={altMode}
              assetVersion={assetVersion}
              selection={selection}
              focusTile={focusTile}
              onSelect={setSelection}
              onMovePin={handleMovePin}
              onMoveMacro={handleMoveMacro}
              onRotateMacro={handleRotateMacro}
              onFlipMacro={handleFlipMacro}
              onToggleAltMode={() => setAltMode((a) => !a)}
              onUndo={handleUndo}
              onRedo={handleRedo}
            />
          )}

          {activeTab === 'netlist' && (
            <NetlistView
              synthesis={synthesis}
              spec={spec}
              onToggleInputOverride={(item, nextMode) => {
                pushHistory(spec);
                updateSpec(
                  (prev) => {
                    const nextOverrides = { ...prev.inputOverrides };
                    if (nextMode === 'auto') {
                      delete nextOverrides[item];
                    } else {
                      nextOverrides[item] = nextMode;
                    }
                    return { ...prev, inputOverrides: nextOverrides };
                  },
                  true,
                );
              }}
            />
          )}

          {activeTab === 'yaml' && (
            <YamlEditor
              spec={spec}
              onApplySpec={(next) => {
                pushHistory(spec);
                setSpec(next);
                setActivePresetId('custom');
                setSelection(null);
                runFull(next);
              }}
            />
          )}
        </main>

        {/* Right Panel: Inspector, Signoff (DRC/STA), BOM */}
        <aside className={`side-panel right ${rightOpen ? '' : 'collapsed'}`}>
          {/* Inspector for Selected Pin, Macro, or Net */}
          {(selectedPin || selectedMacro || selectedNet) && (
            <div className="panel-section">
              <div className="section-title">
                <span>
                  {selectedPin
                    ? 'Pin Inspector'
                    : selectedMacro
                      ? 'Macro Inspector'
                      : 'Net Inspector'}
                </span>
                <button className="btn btn-sm" onClick={() => setSelection(null)}>
                  Clear
                </button>
              </div>

              {selectedNet && (() => {
                const srcInfo = resolveNetEndpointInfo(selectedNet.source, floorplan);
                const snkInfo = resolveNetEndpointInfo(selectedNet.sink, floorplan);
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div className="row" style={{ gap: 8 }}>
                      <ItemIcon itemId={selectedNet.item} size={22} />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 700, color: '#f8fafc' }}>
                          {getItemMeta(selectedNet.item).name}
                        </div>
                        <div
                          className="mono"
                          style={{
                            fontSize: 10.5,
                            color: 'var(--bp-text-muted)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {selectedNet.id}
                        </div>
                      </div>
                    </div>

                    <div
                      style={{
                        background: '#0b1e33',
                        border: '1px solid var(--bp-border)',
                        borderRadius: 5,
                        padding: '6px 8px',
                        fontSize: 11.5,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 4,
                      }}
                    >
                      <div>
                        <span style={{ color: '#4ade80', fontWeight: 600 }}>Source: </span>
                        <span className="mono">{srcInfo.label}</span>
                      </div>
                      <div>
                        <span style={{ color: '#f472b6', fontWeight: 600 }}>Sink: </span>
                        <span className="mono">{snkInfo.label}</span>
                      </div>
                      <div style={{ color: 'var(--bp-text-muted)' }}>
                        Throughput:{' '}
                        <strong className="mono" style={{ color: '#f8fafc' }}>
                          {selectedNet.ratePerSec.toFixed(2)}/s
                        </strong>{' '}
                        ({(selectedNet.ratePerSec * 60).toFixed(0)}/min •{' '}
                        {selectedNet.beltTier})
                      </div>
                      {selectedStaNet && (
                        <div>
                          <div className="row" style={{ justifyContent: 'space-between' }}>
                            <span style={{ color: 'var(--bp-text-muted)' }}>Belt Utilization</span>
                            <span className="mono">
                              {(selectedStaNet.utilization * 100).toFixed(1)}%
                            </span>
                          </div>
                          <div
                            style={{
                              height: 4,
                              background: '#091a2c',
                              borderRadius: 2,
                              overflow: 'hidden',
                              marginTop: 2,
                            }}
                          >
                            <div
                              style={{
                                width: `${Math.min(100, selectedStaNet.utilization * 100)}%`,
                                height: '100%',
                                background:
                                  selectedStaNet.utilization > 1
                                    ? '#ef4444'
                                    : selectedStaNet.utilization > 0.8
                                      ? '#f59e0b'
                                      : '#4ade80',
                              }}
                            />
                          </div>
                          {selectedStaNet.leftRatePerSec !== undefined &&
                            selectedStaNet.rightRatePerSec !== undefined && (
                              <div
                                className="mono"
                                style={{
                                  fontSize: 10.5,
                                  color:
                                    (selectedStaNet.laneUtilization ?? 0) > 1
                                      ? '#f87171'
                                      : 'var(--bp-text-muted)',
                                  marginTop: 3,
                                }}
                              >
                                L: {selectedStaNet.leftRatePerSec.toFixed(1)}/s • R:{' '}
                                {selectedStaNet.rightRatePerSec.toFixed(1)}/s
                              </div>
                            )}
                        </div>
                      )}
                      {selectedRoutedNet && (
                        <div className="mono" style={{ fontSize: 11, color: 'var(--bp-cyan)' }}>
                          {selectedRoutedNet.tiles.length} tiles •{' '}
                          {selectedRoutedNet.undergroundCount} UGs • {selectedNetBends} bends
                        </div>
                      )}
                    </div>

                    {floorplan && (
                      <div className="field-grid">
                        <button
                          type="button"
                          className="btn btn-sm"
                          style={{ justifyContent: 'center' }}
                          onClick={() => {
                            setActiveTab('layout');
                            setFocusTile({ tx: srcInfo.tx, ty: srcInfo.ty, nonce: Date.now() });
                          }}
                        >
                          <Crosshair size={12} /> Focus Source
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          style={{ justifyContent: 'center' }}
                          onClick={() => {
                            setActiveTab('layout');
                            setFocusTile({ tx: snkInfo.tx, ty: snkInfo.ty, nonce: Date.now() });
                          }}
                        >
                          <Crosshair size={12} /> Focus Sink
                        </button>
                      </div>
                    )}
                  </div>
                );
              })()}

              {selectedPin && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div className="row" style={{ gap: 8 }}>
                    <ItemIcon itemId={selectedPin.item} size={20} />
                    <div className="mono" style={{ fontWeight: 700, color: '#f8fafc' }}>
                      {selectedPin.id}
                    </div>
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--bp-text-muted)' }}>
                    {getItemMeta(selectedPin.item).name} •{' '}
                    {(selectedPin.ratePerSec * 60).toFixed(1)}/min ({selectedPin.beltTier})
                  </div>
                  <div className="field-grid">
                    <div>
                      <label className="field-label">Edge</label>
                      <select
                        className="select"
                        value={selectedPin.edge}
                        onChange={(e) =>
                          handleMovePin(
                            selectedPin.id,
                            e.target.value as Edge,
                            selectedPin.offset,
                          )
                        }
                      >
                        <option value="W">West (Left)</option>
                        <option value="E">East (Right)</option>
                        <option value="N">North (Top)</option>
                        <option value="S">South (Bottom)</option>
                      </select>
                    </div>
                    <div>
                      <label className="field-label">Offset</label>
                      <input
                        type="number"
                        className="input mono"
                        min={1}
                        value={selectedPin.offset}
                        onChange={(e) =>
                          handleMovePin(
                            selectedPin.id,
                            selectedPin.edge,
                            Math.max(1, Number(e.target.value) || 1),
                          )
                        }
                      />
                    </div>
                  </div>
                </div>
              )}

              {selectedMacro && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div className="row" style={{ gap: 8 }}>
                    <ItemIcon itemId={selectedMacro.macro.outputItem} size={20} />
                    <div style={{ fontWeight: 700, color: '#f8fafc' }}>
                      {selectedMacro.macro.label} ({selectedMacro.macro.sublabel})
                    </div>
                  </div>
                  <div className="mono" style={{ fontSize: 11, color: 'var(--bp-text-muted)' }}>
                    {selectedMacro.id} • {selectedMacro.macro.width}×{selectedMacro.macro.height}
                  </div>
                  <div className="field-grid">
                    <div>
                      <label className="field-label">X</label>
                      <input
                        type="number"
                        className="input mono"
                        value={selectedMacro.x}
                        onChange={(e) =>
                          handleMoveMacro(
                            selectedMacro.id,
                            Number(e.target.value) || 0,
                            selectedMacro.y,
                          )
                        }
                      />
                    </div>
                    <div>
                      <label className="field-label">Y</label>
                      <input
                        type="number"
                        className="input mono"
                        value={selectedMacro.y}
                        onChange={(e) =>
                          handleMoveMacro(
                            selectedMacro.id,
                            selectedMacro.x,
                            Number(e.target.value) || 0,
                          )
                        }
                      />
                    </div>
                  </div>
                  <div className="row" style={{ flexWrap: 'wrap' }}>
                    <button
                      className="btn btn-sm"
                      onClick={() => handleRotateMacro(selectedMacro.id)}
                    >
                      <RotateCw size={12} /> Rotate ({selectedMacro.macro.rotation * 90}°)
                    </button>
                    <button
                      className="btn btn-sm"
                      onClick={() => handleFlipMacro(selectedMacro.id)}
                    >
                      <ArrowUpDown size={12} /> Flip Y{selectedMacro.macro.flippedY ? ' (On)' : ''}
                    </button>
                    <button
                      className="btn btn-sm"
                      onClick={() => {
                        pushHistory(spec);
                        const ov = spec.macroOverrides[selectedMacro.id] ?? {};
                        const nextLocked = !selectedMacro.locked;
                        updateSpec((prev) => ({
                          ...prev,
                          macroOverrides: {
                            ...prev.macroOverrides,
                            [selectedMacro.id]: {
                              ...ov,
                              x: selectedMacro.x,
                              y: selectedMacro.y,
                              rotation: selectedMacro.macro.rotation,
                              flipY: selectedMacro.macro.flippedY,
                              locked: nextLocked,
                            },
                          },
                        }));
                        if (floorplan) {
                          setFloorplan({
                            ...floorplan,
                            macros: floorplan.macros.map((m) =>
                              m.id === selectedMacro.id ? { ...m, locked: nextLocked } : m,
                            ),
                          });
                        }
                      }}
                    >
                      {selectedMacro.locked ? <Lock size={12} /> : <Unlock size={12} />}
                      {selectedMacro.locked ? 'Locked' : 'Unlocked'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Signoff DRC & STA */}
          <div className="panel-section">
            <div className="section-title">
              <span>Signoff Verification</span>
              <div className="row">
                {drc && (
                  <span className={`pill ${drc.passed ? 'pill-pass' : 'pill-fail'}`}>
                    {drc.passed ? <CheckCircle2 size={11} /> : <AlertTriangle size={11} />}
                    DRC {drc.passed ? 'PASS' : `${drc.errorCount} ERR`}
                  </span>
                )}
                {sta && (
                  <span className={`pill ${sta.passed ? 'pill-pass' : 'pill-fail'}`}>
                    STA {sta.passed ? 'PASS' : 'FAIL'}
                  </span>
                )}
              </div>
            </div>

            {floorplan && floorplan.warnings.length > 0 && (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  marginBottom: 8,
                  padding: '6px 8px',
                  borderRadius: 6,
                  border: '1px solid rgba(245, 158, 11, 0.45)',
                  background: 'rgba(245, 158, 11, 0.12)',
                  color: '#fde68a',
                  fontSize: 11,
                }}
              >
                {floorplan.warnings.map((w, i) => (
                  <div key={i}>⚠ {w}</div>
                ))}
              </div>
            )}

            {drc && !drc.passed && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
                {drc.violations.slice(0, 12).map((v) => (
                  <button
                    key={v.id}
                    className="btn btn-sm"
                    style={{
                      justifyContent: 'flex-start',
                      textAlign: 'left',
                      borderColor: 'rgba(248,113,113,0.45)',
                      background: 'rgba(248,113,113,0.1)',
                    }}
                    onClick={() =>
                      setFocusTile({ tx: v.tx, ty: v.ty, nonce: Date.now() })
                    }
                  >
                    <span className="mono" style={{ color: 'var(--bp-red)' }}>
                      [{v.code}] ({v.tx},{v.ty})
                    </span>
                    <span style={{ fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {v.message}
                    </span>
                  </button>
                ))}
              </div>
            )}

            {sta && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <div style={{ fontSize: 11, color: 'var(--bp-text-muted)' }}>
                  Peak Net/Macro Utilization:{' '}
                  <strong className="mono" style={{ color: '#f8fafc' }}>
                    {(sta.maxUtilization * 100).toFixed(1)}%
                  </strong>
                </div>
                {sta.bottlenecks.length > 0 && (
                  <div style={{ fontSize: 11, color: 'var(--bp-red)' }}>
                    {sta.bottlenecks.map((b, i) => (
                      <div key={i}>• {b}</div>
                    ))}
                  </div>
                )}
                <div style={{ maxHeight: 165, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {sta.nets.slice(0, 14).map((n) => {
                    const isNetActive =
                      selection?.kind === 'net' && selection.netId === n.netId;
                    return (
                      <button
                        type="button"
                        key={n.netId}
                        className={`sta-net-row ${isNetActive ? 'active' : ''}`}
                        onClick={() => {
                          setSelection({ kind: 'net', netId: n.netId });
                          setActiveTab('layout');
                        }}
                        title={`Highlight net ${n.netId} on canvas`}
                      >
                        <div className="row" style={{ justifyContent: 'space-between', width: '100%' }}>
                          <span className="row" style={{ gap: 5, minWidth: 0 }}>
                            <ItemIcon itemId={n.item} size={14} />
                            <span
                              style={{
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {getItemMeta(n.item).name}
                            </span>
                          </span>
                          <span className="mono">{(n.utilization * 100).toFixed(0)}%</span>
                        </div>
                        <div
                          style={{
                            width: '100%',
                            height: 4,
                            background: '#091a2c',
                            borderRadius: 2,
                            overflow: 'hidden',
                          }}
                        >
                          <div
                            style={{
                              width: `${Math.min(100, n.utilization * 100)}%`,
                              height: '100%',
                              background:
                                n.utilization > 1
                                  ? '#ef4444'
                                  : n.utilization > 0.8
                                    ? '#f59e0b'
                                    : '#4ade80',
                            }}
                          />
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Physical Metrics & BOM */}
          <div className="panel-section">
            <div className="section-title">Physical Metrics &amp; BOM</div>
            <div className="kpi-grid">
              <div className="kpi-card">
                <div className="kpi-label">Die Size</div>
                <div className="kpi-val">
                  {floorplan ? `${floorplan.width}×${floorplan.height}` : '—'}
                </div>
              </div>
              <div className="kpi-card">
                <div className="kpi-label">Machines</div>
                <div className="kpi-val">
                  {fullResult?.bom.totalMachines ?? synthesis?.bom.totalMachines ?? '—'}
                </div>
              </div>
              <div className="kpi-card">
                <div className="kpi-label">Routed Nets</div>
                <div className="kpi-val">
                  {route
                    ? `${route.routedNets.filter((r) => r.routed).length}/${route.routedNets.length}`
                    : synthesis
                      ? `${synthesis.nets.length}`
                      : '—'}
                </div>
              </div>
              <div className="kpi-card">
                <div className="kpi-label">Est. Power</div>
                <div className="kpi-val">
                  {fullResult
                    ? `${(fullResult.bom.estimatedPowerKw / 1000).toFixed(2)} MW`
                    : synthesis
                      ? `${(synthesis.bom.estimatedPowerKw / 1000).toFixed(2)} MW`
                      : '—'}
                </div>
              </div>
              <div className="kpi-card">
                <div className="kpi-label">Die Density</div>
                <div className="kpi-val">
                  {floorplan && allEntities.length > 0
                    ? `${((allEntities.reduce((s, e) => s + (e.role === 'port-marker' ? 0 : e.w * e.h), 0) / (floorplan.width * floorplan.height)) * 100).toFixed(1)}%`
                    : '—'}
                </div>
              </div>
              <div className="kpi-card">
                <div className="kpi-label">Wirelength</div>
                <div className="kpi-val">
                  {route
                    ? `${route.entities.length}b / ${route.routedNets.reduce((s, r) => s + r.undergroundCount, 0)}ug`
                    : '—'}
                </div>
              </div>
              {fullResult?.tiling && (
                <div className="kpi-card" style={{ gridColumn: '1 / -1' }}>
                  <div className="kpi-label">Tiled Array ({fullResult.tiling.layout})</div>
                  <div className="kpi-val">
                    {fullResult.tiling.tileCount}× ({fullResult.tiling.cols}×{fullResult.tiling.rows})
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 400,
                        color: 'var(--bp-text-muted)',
                        marginLeft: 8,
                      }}
                    >
                      Unit Tile: {fullResult.tiling.unitWidth}×{fullResult.tiling.unitHeight} ·{' '}
                      {fullResult.tiling.unitMachines}m
                    </span>
                  </div>
                </div>
              )}
            </div>

            {fullResult && (
              <div style={{ marginTop: 10 }}>
                <div className="field-label">Entity Bill of Materials ({allEntities.length} total)</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 220, overflowY: 'auto' }}>
                  {Object.entries(fullResult.bom.entities)
                    .sort((a, b) => b[1] - a[1])
                    .map(([name, count]) => (
                      <div
                        key={name}
                        className="row"
                        title={name}
                        style={{
                          justifyContent: 'space-between',
                          fontSize: 11.5,
                          padding: '3px 6px',
                          background: '#0b1e33',
                          borderRadius: 3,
                        }}
                      >
                        <span className="row" style={{ gap: 6, minWidth: 0 }}>
                          <ItemIcon itemId={name} size={16} />
                          <span
                            style={{
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {formatEntityLabel(name)}
                          </span>
                        </span>
                        <strong className="mono" style={{ color: 'var(--bp-cyan)' }}>
                          {count}
                        </strong>
                      </div>
                    ))}
                </div>
              </div>
            )}
          </div>
        </aside>
      </div>

      <BalancerModal
        open={balancerModalOpen}
        customBalancers={spec.customBalancers ?? []}
        onClose={() => setBalancerModalOpen(false)}
        onAddBalancers={(imported: BalancerTemplate[]) => {
          updateSpec(
            (prev) => ({
              ...prev,
              customBalancers: [...(prev.customBalancers ?? []), ...imported],
            }),
            true,
          );
        }}
        onClearCustom={() => {
          updateSpec((prev) => ({ ...prev, customBalancers: [] }), true);
        }}
      />

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
