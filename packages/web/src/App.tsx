import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BELT_SPECS,
  BUILTIN_PRESETS,
  BalancerTemplate,
  BeaconMode,
  BeaconModuleName,
  BeltStackSize,
  BeltTier,
  DesignSpec,
  DrcReport,
  Edge,
  EntityInstance,
  FloorplanResult,
  INPUT_PRESET_LIST,
  InputPreset,
  InserterTier,
  ModuleName,
  OptimizationLevel,
  PIPE_SPEC,
  PerimeterHeaderMode,
  PipelineProgress,
  PipelineResult,
  PoleTier,
  PortMarkerMode,
  QUALITY_SPECS,
  QualityTier,
  RawCatalog,
  Rot90,
  RouteResult,
  StaReport,
  SynthesisResult,
  TargetSpec,
  applyInputOverride,
  collectLayoutEntities,
  computeRecipeThroughputPerMachine,
  decodeSpecFromUrlHash,
  defaultOptimizationConfig,
  edgeToInwardDir,
  edgeToOutwardDir,
  effectiveBeltCapacity,
  encodeSpecToUrlHash,
  getCatalog,
  getDefaultCatalogRaw,
  getItemMeta,
  inspectInputBoundary,
  isFluidItem,
  loadCustomCatalog,
  mirrorMacroY,
  pipelineResultToBlueprintBookString,
  renderLayoutToSvg,
  resetDefaultCatalog,
  rotateMacro,
} from '@factorio-eda/core';
import {
  AlertTriangle,
  ArrowUpDown,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  Cpu,
  Crosshair,
  Download,
  FileCode2,
  FolderOpen,
  GitBranch,
  Layers,
  Loader2,
  Lock,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Plus,
  Redo2,
  RotateCcw,
  RotateCw,
  Share2,
  SlidersHorizontal,
  Trash2,
  Undo2,
  Unlock,
  Upload,
  Wrench,
  X,
} from 'lucide-react';
import {
  BlueprintCanvas,
  CanvasLayers,
  RenderMode,
  SelectionTarget,
} from './components/BlueprintCanvas';
import { formatEntityLabel, ItemIcon } from './components/ItemIcon';
import { ItemPicker } from './components/ItemPicker';
import { InputMaterialsPanel } from './components/InputMaterialsPanel';
import { NumericInput } from './components/NumericInput';
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
  const [catalogVersion, setCatalogVersion] = useState(0);
  const [customCatalogInfo, setCustomCatalogInfo] = useState<{
    filename: string;
    items: number;
    recipes: number;
  } | null>(null);
  const customCatalogRawRef = useRef<RawCatalog | null>(null);
  const catalogInputRef = useRef<HTMLInputElement | null>(null);

  const catalog = useMemo(() => getCatalog(), [catalogVersion]);
  const initial = useMemo(() => getInitialSpecState(), []);
  const [spec, setSpec] = useState<DesignSpec>(initial.spec);
  const specRef = useRef<DesignSpec>(initial.spec);
  specRef.current = spec;

  const setSpecSynced = useCallback((next: DesignSpec) => {
    specRef.current = next;
    setSpec(next);
  }, []);

  const targetOptions = useMemo(
    () =>
      [...catalog.allTargets].sort((a, b) => a.name.localeCompare(b.name)),
    [catalog],
  );
  const [activePresetId, setActivePresetId] = useState<string>(initial.presetId);
  const [lastRunSpecSig, setLastRunSpecSig] = useState<string>(() => JSON.stringify(initial.spec));

  const [sectionsOpen, setSectionsOpen] = useState({
    targets: true,
    inputs: true,
    pdk: true,
    floorplan: true,
    catalog: true,
  });
  const toggleSection = useCallback((key: keyof typeof sectionsOpen) => {
    setSectionsOpen((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const [historyPast, setHistoryPast] = useState<DesignSpec[]>([]);
  const [historyFuture, setHistoryFuture] = useState<DesignSpec[]>([]);

  const [leftOpen, setLeftOpen] = useState<boolean>(
    () => typeof window === 'undefined' || window.innerWidth >= 960,
  );
  const [rightOpen, setRightOpen] = useState<boolean>(
    () => typeof window === 'undefined' || window.innerWidth >= 1180,
  );
  const [targetUnit, setTargetUnit] = useState<'perMin' | 'perSec' | 'belts' | 'machines'>(() =>
    initial.spec.targets.some((t) => (t.machines ?? 0) > 0) ? 'machines' : 'perMin',
  );
  const [stepsMenuOpen, setStepsMenuOpen] = useState(false);
  const [layersMenuOpen, setLayersMenuOpen] = useState(false);

  const stepsMenuRef = useRef<HTMLDivElement | null>(null);
  const layersMenuRef = useRef<HTMLDivElement | null>(null);

  const [activeTab, setActiveTab] = useState<'layout' | 'netlist' | 'yaml'>('layout');
  const [balancerModalOpen, setBalancerModalOpen] = useState(false);
  const [staListTab, setStaListTab] = useState<'nets' | 'macros'>('nets');

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

  const flushFocusedNumericInput = useCallback(() => {
    const active = document.activeElement;
    if (active instanceof HTMLInputElement && active.closest('.numeric-input')) {
      active.blur();
    }
  }, []);

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
    setHistoryFuture((fut) => [structuredClone(specRef.current), ...fut.slice(0, 29)]);
    setSpecSynced(target);
    setActivePresetId('custom');
    setSelection(null);
    runFull(target);
  }, [historyPast, setSpecSynced, runFull]);

  const handleRedo = useCallback(() => {
    if (historyFuture.length === 0) return;
    const target = historyFuture[0];
    setHistoryFuture((fut) => fut.slice(1));
    setHistoryPast((past) => [...past.slice(-29), structuredClone(specRef.current)]);
    setSpecSynced(target);
    setActivePresetId('custom');
    setSelection(null);
    runFull(target);
  }, [historyFuture, setSpecSynced, runFull]);

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

  const createWorker = useCallback(() => {
    const worker = new Worker(new URL('./worker/eda.worker.ts', import.meta.url), {
      type: 'module',
    });
    if (customCatalogRawRef.current) {
      worker.postMessage({
        type: 'set-catalog',
        raw: customCatalogRawRef.current,
      } satisfies WorkerRequest);
    }
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
          specRef.current,
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
    workerRef.current = worker;
    return worker;
  }, []);

  const handleCancelRun = useCallback(() => {
    jobIdRef.current++;
    if (workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }
    createWorker();
    setRunning(false);
    setProgress({ stage: 'done', message: 'Cancelled' });
  }, [createWorker]);

  useEffect(() => {
    const worker = createWorker();

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

  const updateSpec = useCallback(
    (updater: (prev: DesignSpec) => DesignSpec, autoRun = false) => {
      setActivePresetId('custom');
      const rawNext = updater(specRef.current);
      // Keep ratePerMin synchronized with any machine-count target under current PDK
      const syncedTargets = rawNext.targets.map((t) => {
        if (t.machines && t.machines > 0) {
          const info = computeRecipeThroughputPerMachine(t.item, rawNext.pdk, t.machines);
          if (info) {
            const nextPerMin = Math.max(0.5, Number((t.machines * info.itemsPerMin).toFixed(2)));
            if (Math.abs(nextPerMin - t.ratePerMin) > 1e-3) {
              return { ...t, ratePerMin: nextPerMin };
            }
          }
        }
        return t;
      });
      const next =
        syncedTargets.some((t, i) => t !== rawNext.targets[i])
          ? { ...rawNext, targets: syncedTargets }
          : rawNext;
      specRef.current = next;
      setSpec(next);
      if (autoRun) runFull(next);
      return next;
    },
    [runFull],
  );

  const handleTargetUnitChange = useCallback(
    (nextUnit: 'perMin' | 'perSec' | 'belts' | 'machines') => {
      setTargetUnit(nextUnit);
      if (nextUnit === 'machines') {
        updateSpec((prev) => ({
          ...prev,
          targets: prev.targets.map((t) => {
            const existing = t.machines && t.machines > 0 ? Math.round(t.machines) : undefined;
            const probe = computeRecipeThroughputPerMachine(t.item, prev.pdk, existing ?? 1);
            const count =
              existing ?? Math.max(1, Math.round(t.ratePerMin / (probe?.itemsPerMin ?? 60)));
            const info = computeRecipeThroughputPerMachine(t.item, prev.pdk, count);
            return {
              ...t,
              machines: count,
              ratePerMin: info ? Number((count * info.itemsPerMin).toFixed(2)) : t.ratePerMin,
            };
          }),
        }));
      } else {
        updateSpec((prev) => {
          if (!prev.targets.some((t) => t.machines !== undefined)) return prev;
          return {
            ...prev,
            targets: prev.targets.map(({ machines: _m, ...rest }) => rest),
          };
        });
      }
    },
    [updateSpec],
  );

  const applyTargetRate = useCallback(
    (idx: number, inputVal: number) =>
      updateSpec((prev) => ({
        ...prev,
        targets: prev.targets.map((item, i) => {
          if (i !== idx) return item;
          if (targetUnit === 'machines') {
            const count = Math.max(1, Math.round(inputVal));
            const info = computeRecipeThroughputPerMachine(item.item, prev.pdk, count);
            const nextPerMin = info ? Number((count * info.itemsPerMin).toFixed(2)) : item.ratePerMin;
            return {
              ...item,
              machines: count,
              ratePerMin: Math.max(0.5, nextPerMin),
            };
          }
          const isFluid = isFluidItem(item.item);
          const capPerMin = isFluid
            ? PIPE_SPEC.capacityPerSec * 60
            : effectiveBeltCapacity(prev.pdk.defaultBeltTier, prev.pdk) * 60;
          let nextPerMin = inputVal;
          if (targetUnit === 'perSec') nextPerMin = inputVal * 60;
          else if (targetUnit === 'belts') nextPerMin = inputVal * capPerMin;
          const clamped = Math.max(0.5, Math.round(nextPerMin * 100) / 100);
          return { item: item.item, ratePerMin: clamped };
        }),
      })),
    [targetUnit, updateSpec],
  );

  const handleMovePin = useCallback(
    (pinId: string, edge: Edge, offset: number) => {
      const curSpec = specRef.current;
      pushHistory(curSpec);
      setActivePresetId('custom');
      const nextSpec: DesignSpec = {
        ...curSpec,
        pins: [
          ...curSpec.pins.filter((p) => p.id !== pinId),
          { id: pinId, edge, offset, locked: true },
        ],
      };
      setSpecSynced(nextSpec);

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
    [synthesis, floorplan, pushHistory, setSpecSynced, runReroute, runFull],
  );

  const handleMoveMacro = useCallback(
    (macroId: string, x: number, y: number) => {
      const curSpec = specRef.current;
      pushHistory(curSpec);
      setActivePresetId('custom');
      const existingOv = curSpec.macroOverrides[macroId] ?? {};
      const nextSpec: DesignSpec = {
        ...curSpec,
        macroOverrides: {
          ...curSpec.macroOverrides,
          [macroId]: { ...existingOv, x, y, locked: true },
        },
      };
      setSpecSynced(nextSpec);

      if (synthesis && floorplan) {
        const nextMacros = floorplan.macros.map((m) =>
          m.id === macroId ? { ...m, x, y, locked: true } : m,
        );
        const nextFloorplan: FloorplanResult = { ...floorplan, macros: nextMacros };
        setFloorplan(nextFloorplan);
        runReroute(nextSpec, synthesis, nextFloorplan);
      }
    },
    [synthesis, floorplan, pushHistory, setSpecSynced, runReroute],
  );

  const handleRotateMacro = useCallback(
    (macroId: string) => {
      if (!floorplan) return;
      const pm = floorplan.macros.find((m) => m.id === macroId);
      if (!pm) return;
      const curSpec = specRef.current;
      pushHistory(curSpec);
      setActivePresetId('custom');
      const nextRot = (((pm.macro.rotation + 1) % 4) as Rot90);
      const baseVariant =
        pm.variants.find((v) => v.rows === pm.macro.rows) ?? pm.variants[0];
      const flipped = pm.macro.flippedY ? mirrorMacroY(baseVariant) : baseVariant;
      const rotated = rotateMacro(flipped, nextRot);
      const nx = Math.max(2, Math.min(floorplan.width - rotated.width - 2, pm.x));
      const ny = Math.max(2, Math.min(floorplan.height - rotated.height - 2, pm.y));

      const existingOv = curSpec.macroOverrides[macroId] ?? {};
      const nextSpec: DesignSpec = {
        ...curSpec,
        macroOverrides: {
          ...curSpec.macroOverrides,
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
      setSpecSynced(nextSpec);

      if (synthesis) {
        const nextMacros = floorplan.macros.map((m) =>
          m.id === macroId ? { ...m, x: nx, y: ny, macro: rotated, locked: true } : m,
        );
        const nextFloorplan: FloorplanResult = { ...floorplan, macros: nextMacros };
        setFloorplan(nextFloorplan);
        runReroute(nextSpec, synthesis, nextFloorplan);
      }
    },
    [floorplan, synthesis, pushHistory, setSpecSynced, runReroute],
  );

  const handleFlipMacro = useCallback(
    (macroId: string) => {
      if (!floorplan) return;
      const pm = floorplan.macros.find((m) => m.id === macroId);
      if (!pm) return;
      const curSpec = specRef.current;
      pushHistory(curSpec);
      setActivePresetId('custom');
      const nextFlip = !pm.macro.flippedY;
      const baseVariant =
        pm.variants.find((v) => v.rows === pm.macro.rows) ?? pm.variants[0];
      const oriented = rotateMacro(
        nextFlip ? mirrorMacroY(baseVariant) : baseVariant,
        pm.macro.rotation,
      );

      const existingOv = curSpec.macroOverrides[macroId] ?? {};
      const nextSpec: DesignSpec = {
        ...curSpec,
        macroOverrides: {
          ...curSpec.macroOverrides,
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
      setSpecSynced(nextSpec);

      if (synthesis) {
        const nextMacros = floorplan.macros.map((m) =>
          m.id === macroId ? { ...m, macro: oriented, locked: true } : m,
        );
        const nextFloorplan: FloorplanResult = { ...floorplan, macros: nextMacros };
        setFloorplan(nextFloorplan);
        runReroute(nextSpec, synthesis, nextFloorplan);
      }
    },
    [floorplan, synthesis, pushHistory, setSpecSynced, runReroute],
  );

  const handleCopyBlueprint = async () => {
    if (!fullResult?.blueprintString) return;
    await navigator.clipboard.writeText(fullResult.blueprintString);
    showToast(
      `Copied Factorio 2.0 blueprint string (${allEntities.length} entities)!`,
    );
  };

  const handleCopyBook = async () => {
    if (!fullResult?.blueprintString) return;
    const { bookString, labels } = pipelineResultToBlueprintBookString(fullResult);
    await navigator.clipboard.writeText(bookString);
    showToast(`Copied Factorio 2.0 Blueprint Book (${labels.length} blueprints)!`);
  };

  const focusOnNet = useCallback(
    (netId: string) => {
      setSelection({ kind: 'net', netId });
      setActiveTab('layout');
      const routed = route?.routedNets.find((r) => r.netId === netId);
      if (routed && routed.tiles.length > 0) {
        const mid = routed.tiles[Math.floor(routed.tiles.length / 2)];
        setFocusTile({ tx: mid.tx, ty: mid.ty, nonce: Date.now() });
        return;
      }
      const net = synthesis?.nets.find((n) => n.id === netId);
      if (net && floorplan) {
        const info = resolveNetEndpointInfo(net.source, floorplan);
        setFocusTile({ tx: info.tx, ty: info.ty, nonce: Date.now() });
      }
    },
    [route, synthesis, floorplan],
  );

  const focusOnMacro = useCallback(
    (macroId: string) => {
      setSelection({ kind: 'macro', macroId });
      setActiveTab('layout');
      const pm = floorplan?.macros.find((m) => m.id === macroId);
      if (pm) {
        setFocusTile({
          tx: Math.round(pm.x + pm.macro.width / 2),
          ty: Math.round(pm.y + pm.macro.height / 2),
          nonce: Date.now(),
        });
      }
    },
    [floorplan],
  );

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

  const beltCapacity = effectiveBeltCapacity(spec.pdk.defaultBeltTier, spec.pdk) * 60;
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

  const formatTargetInputValue = (t: TargetSpec): number => {
    if (targetUnit === 'machines') {
      if (t.machines && t.machines > 0) return t.machines;
      const info = computeRecipeThroughputPerMachine(t.item, spec.pdk, 1);
      return Math.max(1, Math.round(t.ratePerMin / (info?.itemsPerMin ?? 60)));
    }
    if (targetUnit === 'perSec') return Number((t.ratePerMin / 60).toFixed(2));
    if (targetUnit === 'belts') {
      const cap = isFluidItem(t.item) ? PIPE_SPEC.capacityPerSec * 60 : beltCapacity;
      const raw = t.ratePerMin / cap;
      return raw < 0.05 ? Number(raw.toFixed(3)) : Number(raw.toFixed(2));
    }
    return Math.round(t.ratePerMin * 100) / 100;
  };

  const firstTarget = spec.targets[0];
  const targetsSummary = `${spec.targets.length} ${spec.targets.length === 1 ? 'target' : 'targets'} · ${
    firstTarget?.machines && firstTarget.machines > 0
      ? `${firstTarget.machines} mach`
      : `${Math.round(firstTarget?.ratePerMin ?? 0)}/m`
  }`;
  const boundaryPreview = useMemo(() => inspectInputBoundary(spec), [spec, catalogVersion]);
  const activeInputPresetShort =
    INPUT_PRESET_LIST.find((p) => p.id === spec.inputPreset)?.shortLabel ?? spec.inputPreset;
  const inputsSummary = `${activeInputPresetShort}${
    boundaryPreview.overrideCount > 0 ? ` +${boundaryPreview.overrideCount}` : ''
  } · ${boundaryPreview.activeInputs.length} in`;
  const beltShort =
    spec.pdk.defaultBeltTier[0].toUpperCase() + spec.pdk.defaultBeltTier.slice(1);
  const pdkSummary = `${beltShort} · Asm${spec.pdk.defaultAssemblerTier}${spec.pdk.spaceAgeBuildings ? ' · SA' : ''}`;
  const optLvl = spec.optimization?.level ?? 'compact';
  const floorplanSummary = `${
    spec.floorplan.mode === 'fixed'
      ? `${spec.floorplan.width ?? floorplan?.width ?? 60}×${spec.floorplan.height ?? floorplan?.height ?? 45}`
      : 'Auto'
  } · ${optLvl[0].toUpperCase() + optLvl.slice(1)}`;

  return (
    <div className="studio-shell">
      {/* Top EDA Toolbar */}
      <header className="top-bar">
        <div className="toolbar-group">
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
            <Cpu size={17} color="#f59e0b" />
            <span>BeltROAD</span>
            <span className="brand-badge">2.0 EDA</span>
          </div>

          <select
            className="select preset-select"
            value={activePresetId}
            aria-label="Design preset"
            onChange={(e) => {
              const p = BUILTIN_PRESETS.find((pr) => pr.id === e.target.value);
              if (p) {
                pushHistory(specRef.current);
                const cloned = structuredClone(p.spec);
                setTargetUnit(
                  cloned.targets.some((t) => (t.machines ?? 0) > 0) ? 'machines' : 'perMin',
                );
                setSpecSynced(cloned);
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
        </div>

        <div className="toolbar-divider" aria-hidden="true" />

        {/* Execution Controls & Undo/Redo */}
        <div className="toolbar-group">
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
                    flushFocusedNumericInput();
                    runSynthOnly(specRef.current);
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
                    flushFocusedNumericInput();
                    runPlaceOnly(specRef.current);
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
                    flushFocusedNumericInput();
                    if (synthesis && floorplan) runReroute(specRef.current, synthesis, floorplan);
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
            onClick={() => {
              flushFocusedNumericInput();
              runFull(specRef.current);
            }}
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
          {running && (
            <button
              type="button"
              className="btn btn-sm btn-danger-outline"
              onClick={handleCancelRun}
              title="Terminate the running P&R worker"
            >
              <X size={13} /> Cancel
            </button>
          )}
        </div>

        {(progress || fullResult?.tiling) && (
          <>
            <div className="toolbar-divider" aria-hidden="true" />
            <div className="toolbar-group">
              {progress && (
                <span className="pill pill-info">
                  {running && <Loader2 size={11} className="spin" />}
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
            </div>
          </>
        )}

        <div style={{ marginLeft: 'auto' }} className="toolbar-group">
          <div className="toolbar-divider" aria-hidden="true" />
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
          <button
            type="button"
            className="btn btn-sm"
            disabled={!fullResult?.blueprintString}
            onClick={handleCopyBook}
            title="Copy multi-entry Factorio 2.0 Blueprint Book (Full + 1x Tile + No-Markers)"
          >
            <BookOpen size={13} /> Copy Book
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
        <div className="error-banner" role="alert">
          <AlertTriangle size={14} style={{ flexShrink: 0 }} />
          <span>Engine Error: {errorMsg}</span>
        </div>
      )}

      {/* Main 3-Column EDA Workbench */}
      <div
        className={`workspace-grid ${leftOpen ? '' : 'left-collapsed'} ${rightOpen ? '' : 'right-collapsed'}`}
      >
        {/* Left Panel: Spec & PDK */}
        <aside className={`side-panel ${leftOpen ? '' : 'collapsed'}`}>
          <section className="accordion-section">
            <button
              type="button"
              className="accordion-header"
              aria-expanded={sectionsOpen.targets}
              onClick={() => toggleSection('targets')}
            >
              <span className="accordion-header-left">
                {sectionsOpen.targets ? (
                  <ChevronDown size={13} className="accordion-chevron" />
                ) : (
                  <ChevronRight size={13} className="accordion-chevron" />
                )}
                <span className="accordion-title">Design Targets</span>
              </span>
              <span className="accordion-summary">{targetsSummary}</span>
            </button>

            {sectionsOpen.targets && (
              <div className="accordion-body">
                <div className="targets-toolbar">
                  <div className="unit-toggle" role="group" aria-label="Target rate unit">
                    <button
                      type="button"
                      className={`unit-btn ${targetUnit === 'perMin' ? 'active' : ''}`}
                      onClick={() => handleTargetUnitChange('perMin')}
                    >
                      /min
                    </button>
                    <button
                      type="button"
                      className={`unit-btn ${targetUnit === 'perSec' ? 'active' : ''}`}
                      onClick={() => handleTargetUnitChange('perSec')}
                    >
                      /s
                    </button>
                    <button
                      type="button"
                      className={`unit-btn ${targetUnit === 'belts' ? 'active' : ''}`}
                      onClick={() => handleTargetUnitChange('belts')}
                    >
                      belts
                    </button>
                    <button
                      type="button"
                      className={`unit-btn ${targetUnit === 'machines' ? 'active' : ''}`}
                      onClick={() => handleTargetUnitChange('machines')}
                      title="Target exact number of machines at 100% full throughput"
                    >
                      mach
                    </button>
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() =>
                      updateSpec((prev) => ({
                        ...prev,
                        targets: [
                          ...prev.targets,
                          targetUnit === 'machines'
                            ? { item: 'iron-gear-wheel', ratePerMin: 360, machines: 4 }
                            : { item: 'iron-gear-wheel', ratePerMin: 60 },
                        ],
                        pins: [],
                        macroOverrides: {},
                      }))
                    }
                  >
                    <Plus size={12} /> Add
                  </button>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                  {spec.targets.map((t, idx) => {
                    const isFluidTarget = isFluidItem(t.item);
                    const pipeCapPerMin = PIPE_SPEC.capacityPerSec * 60;
                    return (
                    <div key={idx} className="target-card">
                      <div className="row">
                        <ItemPicker
                          value={t.item}
                          options={targetOptions}
                          onChange={(val) => {
                            const rec = catalog.recipesByOutput[val]?.[0];
                            const needsFluids = Boolean(
                              isFluidItem(val) ||
                                rec?.hasFluid ||
                                rec?.category === 'chemistry' ||
                                rec?.category === 'metallurgy' ||
                                rec?.category === 'electromagnetics' ||
                                rec?.category === 'cryogenics' ||
                                val === 'chemical-science-pack' ||
                                val === 'utility-science-pack',
                            );
                            const needsSpaceAge = rec?.group === 'space-age';
                            updateSpec((prev) => ({
                              ...prev,
                              pdk: {
                                ...prev.pdk,
                                enableFluids: needsFluids ? true : prev.pdk.enableFluids,
                                spaceAgeBuildings: needsSpaceAge
                                  ? true
                                  : prev.pdk.spaceAgeBuildings,
                              },
                              targets: prev.targets.map((item, i) => {
                                if (i !== idx) return item;
                                if (targetUnit === 'machines' || (item.machines ?? 0) > 0) {
                                  const count = Math.max(1, Math.round(item.machines ?? 1));
                                  return { ...item, item: val, machines: count };
                                }
                                return { ...item, item: val };
                              }),
                              pins: [],
                              macroOverrides: {},
                            }));
                          }}
                        />
                        {spec.targets.length > 1 && (
                          <button
                            type="button"
                            className="btn btn-sm"
                            aria-label={`Remove ${getItemMeta(t.item).name}`}
                            onClick={() =>
                              updateSpec((prev) => ({
                                ...prev,
                                targets: prev.targets.filter((_, i) => i !== idx),
                                pins: [],
                                macroOverrides: {},
                              }))
                            }
                          >
                            <Trash2 size={12} />
                          </button>
                        )}
                      </div>
                      <div className="target-rate-row">
                        <div className="target-rate-input-wrap">
                          <NumericInput
                            aria-label={`Target rate for ${getItemMeta(t.item).name}`}
                            integer={targetUnit === 'machines'}
                            min={
                              targetUnit === 'machines'
                                ? 1
                                : targetUnit === 'perMin'
                                  ? 0.5
                                  : 0.001
                            }
                            step={
                              targetUnit === 'machines'
                                ? 1
                                : targetUnit === 'perMin'
                                  ? 15
                                  : targetUnit === 'perSec'
                                    ? 1
                                    : 0.25
                            }
                            precision={
                              targetUnit === 'machines' ? 0 : targetUnit === 'belts' ? 3 : 2
                            }
                            suffix={
                              targetUnit === 'machines'
                                ? 'mach'
                                : targetUnit === 'perMin'
                                  ? '/min'
                                  : targetUnit === 'perSec'
                                    ? '/s'
                                    : isFluidTarget
                                      ? 'pipes'
                                      : 'belts'
                            }
                            showSteppers
                            value={formatTargetInputValue(t)}
                            onValidChange={(val) => applyTargetRate(idx, val)}
                            onCommit={(val) => applyTargetRate(idx, val)}
                          />
                        </div>
                        <span className="target-rate-meta">
                          {targetUnit === 'machines'
                            ? `${Math.round(t.ratePerMin)}/m (${(t.ratePerMin / 60).toFixed(1)}/s)`
                            : isFluidTarget
                              ? targetUnit === 'belts'
                                ? `${Math.round(t.ratePerMin)}/min`
                                : `${(t.ratePerMin / pipeCapPerMin).toFixed(2)} pipes`
                              : targetUnit === 'belts'
                                ? `${Math.round(t.ratePerMin)}/min`
                                : `${(t.ratePerMin / beltCapacity).toFixed(2)} belts`}
                        </span>
                      </div>
                    </div>
                  );
                  })}
                </div>
              </div>
            )}
          </section>

          {/* Input Materials & Multi-Level Supply Chain Boundary */}
          <section className="accordion-section">
            <button
              type="button"
              className="accordion-header"
              aria-expanded={sectionsOpen.inputs}
              onClick={() => toggleSection('inputs')}
            >
              <span className="accordion-header-left">
                {sectionsOpen.inputs ? (
                  <ChevronDown size={13} className="accordion-chevron" />
                ) : (
                  <ChevronRight size={13} className="accordion-chevron" />
                )}
                <GitBranch size={12} style={{ color: 'var(--status-pass)', flexShrink: 0 }} />
                <span className="accordion-title">Input Materials</span>
              </span>
              <span className="accordion-summary">{inputsSummary}</span>
            </button>

            {sectionsOpen.inputs && (
              <div className="accordion-body">
                <InputMaterialsPanel
                  spec={spec}
                  activeByproducts={synthesis?.byproducts}
                  onSelectPreset={(preset) =>
                    updateSpec((prev) => ({
                      ...prev,
                      inputPreset: preset,
                      inputOverrides: {},
                      pins: [],
                    }))
                  }
                  onChangeByproductPolicy={(byproductPolicy) =>
                    updateSpec((prev) => ({
                      ...prev,
                      byproductPolicy,
                      pins: [],
                    }))
                  }
                  onToggleItem={(item, nextMode, ancestorChain) =>
                    updateSpec((prev) => ({
                      ...applyInputOverride(prev, item, nextMode, ancestorChain),
                      pins: [],
                    }))
                  }
                  onResetOverrides={() =>
                    updateSpec((prev) => ({
                      ...prev,
                      inputOverrides: {},
                      pins: [],
                    }))
                  }
                />
              </div>
            )}
          </section>

          {/* PDK / SDK Configuration */}
          <section className="accordion-section">
            <button
              type="button"
              className="accordion-header"
              aria-expanded={sectionsOpen.pdk}
              onClick={() => toggleSection('pdk')}
            >
              <span className="accordion-header-left">
                {sectionsOpen.pdk ? (
                  <ChevronDown size={13} className="accordion-chevron" />
                ) : (
                  <ChevronRight size={13} className="accordion-chevron" />
                )}
                <Wrench size={12} style={{ color: 'var(--accent-brass)', flexShrink: 0 }} />
                <span className="accordion-title">PDK / Technology SDK</span>
              </span>
              <span className="accordion-summary">{pdkSummary}</span>
            </button>

            {sectionsOpen.pdk && (
              <div className="accordion-body">
                <div className="field-grid field-grid-pdk-top">
                  <div>
                    <label className="field-label" htmlFor="pdk-belt-tier">
                      Belt Tier
                    </label>
                    <select
                      id="pdk-belt-tier"
                      className="select"
                      value={spec.pdk.defaultBeltTier}
                      onChange={(e) => {
                        const tier = e.target.value as BeltTier;
                        updateSpec((prev) => ({
                          ...prev,
                          pdk: {
                            ...prev.pdk,
                            defaultBeltTier: tier,
                            allowedBeltTiers: prev.pdk.allowedBeltTiers.includes(tier)
                              ? prev.pdk.allowedBeltTiers
                              : [...prev.pdk.allowedBeltTiers, tier],
                          },
                        }));
                      }}
                    >
                      <option value="yellow">Yellow (15/s)</option>
                      <option value="red">Red Fast (30/s)</option>
                      <option value="blue">Blue Express (45/s)</option>
                      <option value="turbo">Turbo Green (60/s)</option>
                    </select>
                  </div>
                  <div>
                    <label className="field-label" htmlFor="pdk-assembler-tier">
                      Assembler Tier
                    </label>
                    <select
                      id="pdk-assembler-tier"
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
                </div>

                <div className="field-grid field-grid-pdk-inserter" style={{ marginTop: 8 }}>
                  <div>
                    <label className="field-label" htmlFor="pdk-inserter-tier">
                      Default Inserter
                    </label>
                    <select
                      id="pdk-inserter-tier"
                      className="select"
                      value={spec.pdk.defaultInserterTier}
                      onChange={(e) => {
                        const tier = e.target.value as InserterTier;
                        updateSpec((prev) => ({
                          ...prev,
                          pdk: {
                            ...prev.pdk,
                            defaultInserterTier: tier,
                            allowedInserterTiers: prev.pdk.allowedInserterTiers.includes(tier)
                              ? prev.pdk.allowedInserterTiers
                              : [...prev.pdk.allowedInserterTiers, tier],
                          },
                        }));
                      }}
                    >
                      <option value="yellow">Yellow Inserter</option>
                      <option value="fast">Fast Inserter</option>
                      <option value="bulk">Bulk Inserter</option>
                      <option value="stack">Stack Inserter (16/s)</option>
                    </select>
                  </div>
                  <div>
                    <label className="field-label" htmlFor="pdk-pole-tier">
                      Power Pole
                    </label>
                    <select
                      id="pdk-pole-tier"
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

                <div className="field-grid" style={{ marginTop: 8 }}>
                  <div>
                    <label className="field-label" htmlFor="pdk-belt-stacking">
                      Belt Stacking (2.0)
                    </label>
                    <select
                      id="pdk-belt-stacking"
                      className="select"
                      value={spec.pdk.beltStackSize ?? 1}
                      onChange={(e) => {
                        const stackSize = Number(e.target.value) as BeltStackSize;
                        updateSpec((prev) => ({
                          ...prev,
                          pdk: {
                            ...prev.pdk,
                            beltStackSize: stackSize,
                            allowedInserterTiers:
                              stackSize > 1 && !prev.pdk.allowedInserterTiers.includes('stack')
                                ? [...prev.pdk.allowedInserterTiers, 'stack']
                                : prev.pdk.allowedInserterTiers,
                          },
                        }));
                      }}
                    >
                      <option value={1}>1× (Unstacked)</option>
                      <option value={2}>2× Stacked Belt</option>
                      <option value={4}>4× Full Stack (2.0)</option>
                    </select>
                  </div>
                  <div>
                    <label className="field-label" htmlFor="pdk-machine-quality">
                      Machine Quality
                    </label>
                    <select
                      id="pdk-machine-quality"
                      className="select"
                      value={spec.pdk.machineQuality ?? 'normal'}
                      onChange={(e) => {
                        const q = e.target.value as QualityTier;
                        updateSpec((prev) => ({
                          ...prev,
                          pdk: { ...prev.pdk, machineQuality: q },
                        }));
                      }}
                    >
                      {(Object.keys(QUALITY_SPECS) as QualityTier[]).map((q) => (
                        <option key={q} value={q}>
                          {QUALITY_SPECS[q].label} ({QUALITY_SPECS[q].speedMultiplier}×)
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div style={{ marginTop: 8 }}>
                  <label className="field-label" htmlFor="pdk-global-modules">
                    In-Machine Modules (fill slots)
                  </label>
                  <select
                    id="pdk-global-modules"
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
                            global: mod ? Array.from({ length: 8 }, () => mod) : [],
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

                <div className="field-grid field-grid-pdk-beacon" style={{ marginTop: 8 }}>
                  <div>
                    <label className="field-label" htmlFor="pdk-beacon-mode">
                      Beacon Rows (2.0)
                    </label>
                    <select
                      id="pdk-beacon-mode"
                      className="select"
                      value={spec.pdk.beaconMode ?? 'none'}
                      onChange={(e) => {
                        const bm = e.target.value as BeaconMode;
                        updateSpec((prev) => ({
                          ...prev,
                          pdk: {
                            ...prev.pdk,
                            beaconMode: bm,
                            beaconModules:
                              prev.pdk.beaconModules && prev.pdk.beaconModules.length > 0
                                ? prev.pdk.beaconModules
                                : ['speed-module-3', 'speed-module-3'],
                          },
                        }));
                      }}
                    >
                      <option value="none">None (Unbeaconed)</option>
                      <option value="row-4">4-Beacon Rows</option>
                      <option value="row-8">8-Beacon Sandwich</option>
                    </select>
                  </div>
                  <div>
                    <label className="field-label" htmlFor="pdk-beacon-modules">
                      Beacon Modules (2×)
                    </label>
                    <select
                      id="pdk-beacon-modules"
                      className="select"
                      disabled={(spec.pdk.beaconMode ?? 'none') === 'none'}
                      value={spec.pdk.beaconModules?.[0] ?? 'speed-module-3'}
                      onChange={(e) => {
                        const mod = e.target.value as BeaconModuleName;
                        updateSpec((prev) => ({
                          ...prev,
                          pdk: {
                            ...prev.pdk,
                            beaconModules: [mod, mod],
                          },
                        }));
                      }}
                    >
                      <option value="speed-module-3">Speed 3 (+100%)</option>
                      <option value="speed-module-2">Speed 2 (+60%)</option>
                      <option value="speed-module">Speed 1 (+40%)</option>
                      <option value="efficiency-module-3">Eff 3 (-100% pwr)</option>
                    </select>
                  </div>
                </div>

                <div style={{ marginTop: 8 }}>
                  <label className="field-label" htmlFor="pdk-port-markers">
                    Port Markers
                  </label>
                  <select
                    id="pdk-port-markers"
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

                <div className="checkbox-list">
                  <label className="checkbox-row">
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
                    <span>Downsize low-rate belts</span>
                  </label>
                  <label
                    className="checkbox-row"
                    title="Prefer 4x4/5x5 Space Age Foundry, Electromagnetic Plant (+50% prod), and Cryogenic Plant"
                  >
                    <input
                      type="checkbox"
                      checked={spec.pdk.spaceAgeBuildings ?? false}
                      onChange={(e) =>
                        updateSpec((prev) => ({
                          ...prev,
                          pdk: { ...prev.pdk, spaceAgeBuildings: e.target.checked },
                        }))
                      }
                    />
                    <span>Space Age buildings</span>
                  </label>
                  <label
                    className="checkbox-row"
                    title="Synthesize fluid-dependent recipes (Plastic, Sulfur, Battery, Processing Unit, Blue & Yellow Science) with Chemical Plants and dedicated pipe routing"
                  >
                    <input
                      type="checkbox"
                      checked={spec.pdk.enableFluids ?? false}
                      onChange={(e) =>
                        updateSpec((prev) => ({
                          ...prev,
                          pdk: { ...prev.pdk, enableFluids: e.target.checked },
                        }))
                      }
                    />
                    <span>Enable fluids &amp; chemical plants</span>
                  </label>
                </div>

                <div style={{ marginTop: 10 }}>
                  <button
                    type="button"
                    className="btn btn-sm"
                    style={{ width: '100%', justifyContent: 'center' }}
                    onClick={() => setBalancerModalOpen(true)}
                  >
                    <Layers size={12} /> Balancer IP Library ({spec.customBalancers?.length ?? 0} custom)
                  </button>
                </div>
              </div>
            )}
          </section>

          {/* Floorplan / Die */}
          <section className="accordion-section">
            <button
              type="button"
              className="accordion-header"
              aria-expanded={sectionsOpen.floorplan}
              onClick={() => toggleSection('floorplan')}
            >
              <span className="accordion-header-left">
                {sectionsOpen.floorplan ? (
                  <ChevronDown size={13} className="accordion-chevron" />
                ) : (
                  <ChevronRight size={13} className="accordion-chevron" />
                )}
                <span className="accordion-title">Die &amp; Floorplan</span>
              </span>
              <span className="accordion-summary">{floorplanSummary}</span>
            </button>

            {sectionsOpen.floorplan && (
              <div className="accordion-body">
                <div className="field-grid">
                  <div>
                    <label className="field-label" htmlFor="floorplan-die-mode">
                      Die Mode
                    </label>
                    <select
                      id="floorplan-die-mode"
                      className="select"
                      value={spec.floorplan.mode}
                      onChange={(e) => {
                        const nextMode = e.target.value as 'auto' | 'fixed';
                        const initW = floorplan?.width ?? spec.floorplan.width ?? 60;
                        const initH = floorplan?.height ?? spec.floorplan.height ?? 45;
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
                      <label className="field-label" htmlFor="floorplan-aspect-ratio">
                        Aspect Ratio
                      </label>
                      <NumericInput
                        id="floorplan-aspect-ratio"
                        aria-label="Aspect Ratio"
                        min={0.2}
                        max={5.0}
                        step={0.1}
                        precision={2}
                        showSteppers
                        value={spec.floorplan.aspectRatio ?? 1.35}
                        onValidChange={(val) =>
                          updateSpec((prev) => ({
                            ...prev,
                            floorplan: { ...prev.floorplan, aspectRatio: val },
                          }))
                        }
                        onCommit={(val) =>
                          updateSpec((prev) => ({
                            ...prev,
                            floorplan: { ...prev.floorplan, aspectRatio: val },
                          }))
                        }
                        onEnterCommit={(val) => {
                          const next = updateSpec((prev) => ({
                            ...prev,
                            floorplan: { ...prev.floorplan, aspectRatio: val },
                          }));
                          runFull(next);
                        }}
                      />
                    </div>
                  ) : (
                    <div className="field-grid">
                      <div>
                        <label className="field-label" htmlFor="floorplan-fixed-w">
                          W
                        </label>
                        <NumericInput
                          id="floorplan-fixed-w"
                          aria-label="Fixed Die Width"
                          integer
                          min={16}
                          step={1}
                          value={spec.floorplan.width ?? floorplan?.width ?? 60}
                          onValidChange={(val) =>
                            updateSpec((prev) => ({
                              ...prev,
                              floorplan: { ...prev.floorplan, width: val },
                            }))
                          }
                          onCommit={(val) =>
                            updateSpec((prev) => ({
                              ...prev,
                              floorplan: { ...prev.floorplan, width: val },
                            }))
                          }
                          onEnterCommit={(val) => {
                            const next = updateSpec((prev) => ({
                              ...prev,
                              floorplan: { ...prev.floorplan, width: val },
                            }));
                            runFull(next);
                          }}
                        />
                      </div>
                      <div>
                        <label className="field-label" htmlFor="floorplan-fixed-h">
                          H
                        </label>
                        <NumericInput
                          id="floorplan-fixed-h"
                          aria-label="Fixed Die Height"
                          integer
                          min={16}
                          step={1}
                          value={spec.floorplan.height ?? floorplan?.height ?? 45}
                          onValidChange={(val) =>
                            updateSpec((prev) => ({
                              ...prev,
                              floorplan: { ...prev.floorplan, height: val },
                            }))
                          }
                          onCommit={(val) =>
                            updateSpec((prev) => ({
                              ...prev,
                              floorplan: { ...prev.floorplan, height: val },
                            }))
                          }
                          onEnterCommit={(val) => {
                            const next = updateSpec((prev) => ({
                              ...prev,
                              floorplan: { ...prev.floorplan, height: val },
                            }));
                            runFull(next);
                          }}
                        />
                      </div>
                    </div>
                  )}
                </div>

                <div style={{ marginTop: 8 }}>
                  <label className="field-label" htmlFor="floorplan-opt-level">
                    Optimization Pass Level
                  </label>
                  <select
                    id="floorplan-opt-level"
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
                              directInsertion:
                                prev.optimization?.directInsertion ?? nextOpt.directInsertion,
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
                  <label className="field-label" htmlFor="floorplan-tiling">
                    Large-Factory Tiling
                  </label>
                  <select
                    id="floorplan-tiling"
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

                <div style={{ marginTop: 8 }}>
                  <label className="field-label" htmlFor="floorplan-header-mode">
                    Perimeter Header
                  </label>
                  <select
                    id="floorplan-header-mode"
                    className="select"
                    value={spec.floorplan.headerMode ?? 'none'}
                    onChange={(e) => {
                      const hm = e.target.value as PerimeterHeaderMode;
                      updateSpec(
                        (prev) => ({
                          ...prev,
                          floorplan: { ...prev.floorplan, headerMode: hm },
                        }),
                        true,
                      );
                    }}
                  >
                    <option value="none">None (Direct Edge Pins)</option>
                    <option value="bus-header">Main Bus Header (Grouped)</option>
                    <option value="train-station">Train Station Bay (Rail + Chests)</option>
                  </select>
                </div>

                <div className="checkbox-list">
                  <label
                    className="checkbox-row"
                    title="Route multi-bay interior trunks to the North outer edge so every pin sits on the die boundary"
                  >
                    <input
                      type="checkbox"
                      checked={spec.floorplan.requireEdgePins ?? true}
                      onChange={(e) =>
                        updateSpec(
                          (prev) => ({
                            ...prev,
                            floorplan: { ...prev.floorplan, requireEdgePins: e.target.checked },
                          }),
                          true,
                        )
                      }
                    />
                    <span>Keep all pins on outer edge</span>
                  </label>
                  <label
                    className="checkbox-row"
                    title="Fuse 3:2 Copper Cable -> Electronic Circuit, 1:2 Iron Stick -> Rail, and 1:1 EM Plant stages into direct-insertion compound macros"
                  >
                    <input
                      type="checkbox"
                      checked={spec.optimization?.directInsertion ?? false}
                      onChange={(e) =>
                        updateSpec(
                          (prev) => {
                            const base = prev.optimization ?? defaultOptimizationConfig('compact');
                            return {
                              ...prev,
                              optimization: {
                                ...base,
                                directInsertion: e.target.checked,
                              },
                            };
                          },
                          true,
                        )
                      }
                    />
                    <span>Direct-insertion macros (3:2 / 1:2)</span>
                  </label>
                </div>

                {(spec.pins.length > 0 || Object.keys(spec.macroOverrides).length > 0) && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    style={{ width: '100%', marginTop: 8, justifyContent: 'center' }}
                    onClick={() => {
                      pushHistory(specRef.current);
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
            )}
          </section>

          {/* Recipe Catalog Import / Template */}
          <section className="accordion-section">
            <button
              type="button"
              className="accordion-header"
              aria-expanded={sectionsOpen.catalog}
              onClick={() => toggleSection('catalog')}
            >
              <span className="accordion-header-left">
                {sectionsOpen.catalog ? (
                  <ChevronDown size={13} className="accordion-chevron" />
                ) : (
                  <ChevronRight size={13} className="accordion-chevron" />
                )}
                <span className="accordion-title">Recipe Catalog</span>
              </span>
              <span
                className="accordion-summary"
                style={
                  customCatalogInfo
                    ? { color: 'var(--accent-brass-hover)', borderColor: 'rgba(245, 158, 11, 0.45)' }
                    : undefined
                }
              >
                {customCatalogInfo ? 'Custom JSON' : `v${catalog.version}`}
              </span>
            </button>

            {sectionsOpen.catalog && (
              <div className="accordion-body">
                {customCatalogInfo ? (
                  <div
                    style={{
                      fontSize: 11,
                      color: '#fde68a',
                      background: 'rgba(245, 158, 11, 0.1)',
                      border: '1px solid rgba(245, 158, 11, 0.35)',
                      borderRadius: 5,
                      padding: '5px 7px',
                      marginBottom: 7,
                    }}
                  >
                    {customCatalogInfo.filename} ({customCatalogInfo.items} items ·{' '}
                    {customCatalogInfo.recipes} recipes)
                  </div>
                ) : (
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 7 }}>
                    Built-in Factorio 2.0 ({Object.keys(catalog.items).length} items ·{' '}
                    {Object.keys(catalog.recipesById).length} recipes)
                  </div>
                )}

                <input
                  ref={catalogInputRef}
                  type="file"
                  accept=".json,application/json"
                  style={{ display: 'none' }}
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (!file) return;
                    try {
                      const text = await file.text();
                      const parsed = JSON.parse(text) as RawCatalog;
                      const loaded = loadCustomCatalog(parsed);
                      customCatalogRawRef.current = parsed;
                      workerRef.current?.postMessage({
                        type: 'set-catalog',
                        raw: parsed,
                      } satisfies WorkerRequest);
                      setCatalogVersion((v) => v + 1);
                      setCustomCatalogInfo({
                        filename: file.name,
                        items: Object.keys(loaded.items).length,
                        recipes: Object.keys(loaded.recipesById).length,
                      });
                      setErrorMsg(null);
                      showToast(
                        `Loaded "${file.name}" (${Object.keys(loaded.recipesById).length} recipes)!`,
                      );
                      const curSpec = specRef.current;
                      const allTargetsValid = curSpec.targets.every(
                        (t) => (loaded.recipesByOutput[t.item]?.length ?? 0) > 0,
                      );
                      if (allTargetsValid) {
                        runFull(curSpec);
                      } else if (loaded.solidTargets.length > 0) {
                        const fallbackItem = loaded.solidTargets[0].outputItem;
                        const nextSpec: DesignSpec = {
                          ...curSpec,
                          targets: [{ item: fallbackItem, ratePerMin: curSpec.targets[0]?.ratePerMin ?? 60 }],
                          pins: [],
                          macroOverrides: {},
                        };
                        setSpecSynced(nextSpec);
                        setActivePresetId('custom');
                        runFull(nextSpec);
                      }
                    } catch (err) {
                      setErrorMsg(
                        `Custom catalog import failed: ${err instanceof Error ? err.message : String(err)}`,
                      );
                    }
                  }}
                />

                <div className="field-grid">
                  <button
                    type="button"
                    className="btn btn-sm"
                    style={{ justifyContent: 'center' }}
                    onClick={() => catalogInputRef.current?.click()}
                    title="Import custom Factorio or modded recipe catalog JSON"
                  >
                    <Upload size={12} /> Import JSON
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    style={{ justifyContent: 'center' }}
                    onClick={() => {
                      const raw = getDefaultCatalogRaw();
                      const blob = new Blob([JSON.stringify(raw, null, 2)], {
                        type: 'application/json;charset=utf-8',
                      });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = 'beltroad-recipes-template.json';
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                    title="Download built-in recipe catalog as editable JSON template"
                  >
                    <Download size={12} /> Template
                  </button>
                </div>

                {customCatalogInfo && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    style={{ width: '100%', marginTop: 6, justifyContent: 'center' }}
                    onClick={() => {
                      const restored = resetDefaultCatalog();
                      customCatalogRawRef.current = null;
                      workerRef.current?.postMessage({
                        type: 'set-catalog',
                        raw: null,
                      } satisfies WorkerRequest);
                      setCatalogVersion((v) => v + 1);
                      setCustomCatalogInfo(null);
                      setErrorMsg(null);
                      showToast('Restored built-in Factorio 2.0 recipe catalog.');
                      const curSpec = specRef.current;
                      if (curSpec.targets.every((t) => (restored.recipesByOutput[t.item]?.length ?? 0) > 0)) {
                        runFull(curSpec);
                      } else {
                        const presetSpec = structuredClone(BUILTIN_PRESETS[1].spec);
                        setSpecSynced(presetSpec);
                        setActivePresetId(BUILTIN_PRESETS[1].id);
                        runFull(presetSpec);
                      }
                    }}
                  >
                    <RotateCcw size={12} /> Reset Default Catalog
                  </button>
                )}
              </div>
            )}
          </section>
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
                pushHistory(specRef.current);
                updateSpec(
                  (prev) => ({
                    ...applyInputOverride(prev, item, nextMode),
                    pins: [],
                  }),
                  true,
                );
              }}
            />
          )}

          {activeTab === 'yaml' && (
            <YamlEditor
              spec={spec}
              onApplySpec={(next) => {
                pushHistory(specRef.current);
                setSpecSynced(next);
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
              <div className="section-header-row">
                <span className="section-title">
                  {selectedPin
                    ? 'Pin Inspector'
                    : selectedMacro
                      ? 'Macro Inspector'
                      : 'Net Inspector'}
                </span>
                <button type="button" className="btn btn-sm" onClick={() => setSelection(null)}>
                  Clear
                </button>
              </div>

              {selectedNet && (() => {
                const srcInfo = resolveNetEndpointInfo(selectedNet.source, floorplan);
                const snkInfo = resolveNetEndpointInfo(selectedNet.sink, floorplan);
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                    <div className="row" style={{ gap: 8 }}>
                      <ItemIcon itemId={selectedNet.item} size={22} />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>
                          {getItemMeta(selectedNet.item).name}
                        </div>
                        <div
                          className="mono"
                          style={{
                            fontSize: 10.5,
                            color: 'var(--text-secondary)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {selectedNet.id}
                        </div>
                      </div>
                    </div>

                    <div className="inspector-card">
                      <div>
                        <span style={{ color: 'var(--status-pass)', fontWeight: 600 }}>Source: </span>
                        <span className="mono">{srcInfo.label}</span>
                      </div>
                      <div>
                        <span style={{ color: '#f472b6', fontWeight: 600 }}>Sink: </span>
                        <span className="mono">{snkInfo.label}</span>
                      </div>
                      <div style={{ color: 'var(--text-secondary)' }}>
                        Throughput:{' '}
                        <strong className="mono" style={{ color: 'var(--text-primary)' }}>
                          {selectedNet.ratePerSec.toFixed(2)}/s
                        </strong>{' '}
                        <span className="mono">
                          ({(selectedNet.ratePerSec * 60).toFixed(0)}/min • {selectedNet.beltTier})
                        </span>
                      </div>
                      {selectedStaNet && (
                        <div>
                          <div className="row" style={{ justifyContent: 'space-between' }}>
                            <span style={{ color: 'var(--text-secondary)' }}>Belt Utilization</span>
                            <span className="mono">
                              {(selectedStaNet.utilization * 100).toFixed(1)}%
                            </span>
                          </div>
                          <div className="progress-track" style={{ marginTop: 3 }}>
                            <div
                              className="progress-fill"
                              style={{
                                width: `${Math.min(100, selectedStaNet.utilization * 100)}%`,
                                background:
                                  selectedStaNet.utilization > 1
                                    ? 'var(--status-fail)'
                                    : selectedStaNet.utilization > 0.8
                                      ? 'var(--accent-brass)'
                                      : 'var(--status-pass)',
                              }}
                            />
                          </div>
                          {selectedStaNet.leftRatePerSec !== undefined &&
                            selectedStaNet.rightRatePerSec !== undefined && (() => {
                              const halfCap = selectedStaNet.capacityPerSec * 0.5;
                              const lPct = halfCap > 0 ? (selectedStaNet.leftRatePerSec / halfCap) * 100 : 0;
                              const rPct = halfCap > 0 ? (selectedStaNet.rightRatePerSec / halfCap) * 100 : 0;
                              return (
                                <div
                                  className="mono"
                                  style={{
                                    fontSize: 10.5,
                                    color:
                                      (selectedStaNet.laneUtilization ?? 0) > 1
                                        ? 'var(--status-fail)'
                                        : 'var(--text-secondary)',
                                    marginTop: 4,
                                  }}
                                >
                                  L: {selectedStaNet.leftRatePerSec.toFixed(2)}/s ({lPct.toFixed(0)}%) • R:{' '}
                                  {selectedStaNet.rightRatePerSec.toFixed(2)}/s ({rPct.toFixed(0)}%)
                                </div>
                              );
                            })()}
                        </div>
                      )}
                      {selectedRoutedNet && (
                        <div className="mono" style={{ fontSize: 11, color: 'var(--accent-cyan)' }}>
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
                <div className="inspector-card">
                  <div className="row" style={{ gap: 8 }}>
                    <ItemIcon itemId={selectedPin.item} size={20} />
                    <div className="mono" style={{ fontWeight: 700, color: 'var(--text-primary)' }}>
                      {selectedPin.id}
                    </div>
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                    {getItemMeta(selectedPin.item).name} •{' '}
                    <span className="mono">
                      {(selectedPin.ratePerSec * 60).toFixed(1)}/min ({selectedPin.beltTier})
                    </span>
                  </div>
                  <div className="field-grid">
                    <div>
                      <label className="field-label" htmlFor="inspector-pin-edge">
                        Edge
                      </label>
                      <select
                        id="inspector-pin-edge"
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
                      <label className="field-label" htmlFor="inspector-pin-offset">
                        Offset
                      </label>
                      <NumericInput
                        key={`pin-offset-${selectedPin.id}`}
                        id="inspector-pin-offset"
                        aria-label="Pin Offset"
                        integer
                        min={1}
                        step={1}
                        value={selectedPin.offset}
                        onCommit={(val) => {
                          if (val !== selectedPin.offset) {
                            handleMovePin(selectedPin.id, selectedPin.edge, val);
                          }
                        }}
                      />
                    </div>
                  </div>
                </div>
              )}

              {selectedMacro && (
                <div className="inspector-card">
                  <div className="row" style={{ gap: 8 }}>
                    <ItemIcon itemId={selectedMacro.macro.outputItem} size={20} />
                    <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>
                      {selectedMacro.macro.label} ({selectedMacro.macro.sublabel})
                    </div>
                  </div>
                  <div className="mono" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                    {selectedMacro.id} • {selectedMacro.macro.width}×{selectedMacro.macro.height}
                  </div>
                  <div className="field-grid">
                    <div>
                      <label className="field-label" htmlFor="inspector-macro-x">
                        X
                      </label>
                      <NumericInput
                        key={`macro-x-${selectedMacro.id}`}
                        id="inspector-macro-x"
                        aria-label="Macro X"
                        integer
                        step={1}
                        value={selectedMacro.x}
                        onCommit={(val) => {
                          if (val !== selectedMacro.x) {
                            handleMoveMacro(selectedMacro.id, val, selectedMacro.y);
                          }
                        }}
                      />
                    </div>
                    <div>
                      <label className="field-label" htmlFor="inspector-macro-y">
                        Y
                      </label>
                      <NumericInput
                        key={`macro-y-${selectedMacro.id}`}
                        id="inspector-macro-y"
                        aria-label="Macro Y"
                        integer
                        step={1}
                        value={selectedMacro.y}
                        onCommit={(val) => {
                          if (val !== selectedMacro.y) {
                            handleMoveMacro(selectedMacro.id, selectedMacro.x, val);
                          }
                        }}
                      />
                    </div>
                  </div>
                  <div className="row" style={{ flexWrap: 'wrap', marginTop: 2 }}>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => handleRotateMacro(selectedMacro.id)}
                    >
                      <RotateCw size={12} /> Rotate ({selectedMacro.macro.rotation * 90}°)
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => handleFlipMacro(selectedMacro.id)}
                    >
                      <ArrowUpDown size={12} /> Flip Y{selectedMacro.macro.flippedY ? ' (On)' : ''}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => {
                        const curSpec = specRef.current;
                        pushHistory(curSpec);
                        const ov = curSpec.macroOverrides[selectedMacro.id] ?? {};
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
            <div className="section-header-row">
              <span className="section-title">Signoff Verification</span>
              <div className="pill-group">
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
              <div className="warning-banner">
                {floorplan.warnings.map((w, i) => (
                  <div key={i} className="warning-banner-item">
                    <AlertTriangle size={12} style={{ flexShrink: 0, marginTop: 1 }} />
                    <span>{w}</span>
                  </div>
                ))}
              </div>
            )}

            {drc && !drc.passed && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
                {drc.violations.slice(0, 12).map((v) => (
                  <button
                    type="button"
                    key={v.id}
                    className="btn btn-sm violation-btn"
                    onClick={() =>
                      setFocusTile({ tx: v.tx, ty: v.ty, nonce: Date.now() })
                    }
                  >
                    <span className="mono" style={{ color: 'var(--status-fail)' }}>
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
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                  Peak Net/Macro Utilization:{' '}
                  <strong className="mono" style={{ color: 'var(--text-primary)' }}>
                    {(sta.maxUtilization * 100).toFixed(1)}%
                  </strong>
                </div>
                {sta.bottlenecks.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    {sta.bottlenecks.map((b, i) => {
                      const netMatch = /Net "([^"]+)"/.exec(b);
                      const prefixMatch = /^([^:\s]+):/.exec(b);
                      const macroIdMatch =
                        prefixMatch && sta.macros.some((m) => m.macroId === prefixMatch[1])
                          ? prefixMatch[1]
                          : null;
                      return (
                        <button
                          key={i}
                          type="button"
                          className="btn btn-sm bottleneck-btn"
                          title="Click to focus canvas on bottleneck"
                          onClick={() => {
                            if (netMatch) {
                              focusOnNet(netMatch[1]);
                            } else if (macroIdMatch) {
                              focusOnMacro(macroIdMatch);
                            } else {
                              setLayers((l) => ({ ...l, heatmap: true }));
                              setActiveTab('layout');
                            }
                          }}
                        >
                          <Crosshair size={11} style={{ flexShrink: 0 }} />
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {b}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}

                <div className="unit-toggle" role="tablist" aria-label="STA view" style={{ width: '100%' }}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={staListTab === 'nets'}
                    className={`unit-btn ${staListTab === 'nets' ? 'active' : ''}`}
                    style={{ flex: 1 }}
                    onClick={() => setStaListTab('nets')}
                  >
                    Nets ({sta.nets.length})
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={staListTab === 'macros'}
                    className={`unit-btn ${staListTab === 'macros' ? 'active' : ''}`}
                    style={{ flex: 1 }}
                    onClick={() => setStaListTab('macros')}
                  >
                    Macros ({sta.macros.length})
                  </button>
                </div>

                {staListTab === 'nets' ? (
                  <div style={{ maxHeight: 175, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 3 }}>
                    {[...sta.nets]
                      .sort(
                        (a, b) =>
                          Math.max(b.utilization, b.laneUtilization ?? 0) -
                          Math.max(a.utilization, a.laneUtilization ?? 0),
                      )
                      .slice(0, 18)
                      .map((n) => {
                        const isNetActive =
                          selection?.kind === 'net' && selection.netId === n.netId;
                        const halfCap = Math.max(0.01, n.capacityPerSec * 0.5);
                        const lUtil = (n.leftRatePerSec ?? n.ratePerSec * 0.5) / halfCap;
                        const rUtil = (n.rightRatePerSec ?? n.ratePerSec * 0.5) / halfCap;
                        const effUtil = Math.max(n.utilization, n.laneUtilization ?? 0);
                        return (
                          <button
                            type="button"
                            key={n.netId}
                            className={`sta-net-row ${isNetActive ? 'active' : ''}`}
                            onClick={() => focusOnNet(n.netId)}
                            title={`Focus net ${n.netId} (L ${(lUtil * 100).toFixed(0)}% / R ${(rUtil * 100).toFixed(0)}%)`}
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
                              <span
                                className="mono"
                                style={{
                                  color: effUtil > 1 ? 'var(--status-fail)' : effUtil > 0.8 ? 'var(--accent-brass)' : undefined,
                                }}
                              >
                                {(effUtil * 100).toFixed(0)}%
                              </span>
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 1, width: '100%' }}>
                              {[lUtil, rUtil].map((lu, li) => (
                                <div
                                  key={li}
                                  className="progress-track progress-track-thin"
                                >
                                  <div
                                    className="progress-fill"
                                    style={{
                                      width: `${Math.min(100, lu * 100)}%`,
                                      background:
                                        lu > 1
                                          ? 'var(--status-fail)'
                                          : lu > 0.8
                                            ? 'var(--accent-brass)'
                                            : lu > 0.001
                                              ? 'var(--status-pass)'
                                              : 'transparent',
                                    }}
                                  />
                                </div>
                              ))}
                            </div>
                          </button>
                        );
                      })}
                  </div>
                ) : (
                  <div style={{ maxHeight: 175, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 3 }}>
                    {[...sta.macros]
                      .sort((a, b) => {
                        const aFail = a.inserterOk && a.laneOk ? 0 : 1;
                        const bFail = b.inserterOk && b.laneOk ? 0 : 1;
                        if (aFail !== bFail) return bFail - aFail;
                        return b.utilization - a.utilization;
                      })
                      .slice(0, 18)
                      .map((m) => {
                        const isMacroActive =
                          selection?.kind === 'macro' && selection.macroId === m.macroId;
                        const ok = m.inserterOk && m.laneOk;
                        return (
                          <button
                            type="button"
                            key={m.macroId}
                            className={`sta-net-row ${isMacroActive ? 'active' : ''}`}
                            onClick={() => focusOnMacro(m.macroId)}
                            title={`Focus macro ${m.macroId} (${m.exactMachines.toFixed(2)}/${m.machineCount} machines)`}
                          >
                            <div className="row" style={{ justifyContent: 'space-between', width: '100%' }}>
                              <span
                                style={{
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                  color: !ok ? 'var(--status-fail)' : undefined,
                                }}
                              >
                                {m.macroId} ({m.machineCount}m)
                              </span>
                              <span className="mono">{(m.utilization * 100).toFixed(0)}%</span>
                            </div>
                            <div className="progress-track">
                              <div
                                className="progress-fill"
                                style={{
                                  width: `${Math.min(100, m.utilization * 100)}%`,
                                  background: !ok
                                    ? 'var(--status-fail)'
                                    : m.utilization > 0.9
                                      ? 'var(--accent-brass)'
                                      : 'var(--status-pass)',
                                }}
                              />
                            </div>
                          </button>
                        );
                      })}
                  </div>
                )}
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
                  {floorplan ? (
                    <>
                      {floorplan.width}×{floorplan.height}
                      <span
                        style={{
                          fontSize: 10.5,
                          fontWeight: 400,
                          color: 'var(--text-secondary)',
                          marginLeft: 5,
                        }}
                      >
                        ({(floorplan.width / Math.max(1, floorplan.height)).toFixed(2)}:1)
                      </span>
                    </>
                  ) : (
                    '—'
                  )}
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
                        color: 'var(--text-secondary)',
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
                <div className="bom-list">
                  {Object.entries(fullResult.bom.entities)
                    .sort((a, b) => b[1] - a[1])
                    .map(([name, count]) => (
                      <div key={name} className="bom-row" title={name}>
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
                        <strong className="bom-count">{count}</strong>
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
