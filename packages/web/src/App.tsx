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
  CheckCircle2,
  ClipboardCopy,
  Cpu,
  Download,
  FileCode2,
  FolderOpen,
  GitBranch,
  Layers,
  Lock,
  Play,
  Plus,
  RotateCw,
  Share2,
  Trash2,
  Unlock,
  Wrench,
} from 'lucide-react';
import {
  BlueprintCanvas,
  CanvasLayers,
  RenderMode,
  SelectionTarget,
} from './components/BlueprintCanvas';
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

export default function App() {
  const catalog = useMemo(() => getCatalog(), []);
  const targetOptions = useMemo(
    () => [...catalog.solidTargets].sort((a, b) => a.name.localeCompare(b.name)),
    [catalog],
  );

  const [spec, setSpec] = useState<DesignSpec>(() => {
    try {
      if (typeof window !== 'undefined' && window.location.hash.includes('spec=')) {
        const decoded = decodeSpecFromUrlHash(window.location.hash);
        if (decoded) return decoded;
      }
    } catch {
      // Ignore malformed hash
    }
    return structuredClone(BUILTIN_PRESETS[1].spec);
  });

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

  const runFull = useCallback(
    (targetSpec: DesignSpec) => {
      const jobId = ++jobIdRef.current;
      postJob({ type: 'run-full', jobId, spec: targetSpec });
    },
    [postJob],
  );

  const runSynthOnly = useCallback(
    (targetSpec: DesignSpec) => {
      const jobId = ++jobIdRef.current;
      postJob({ type: 'run-synth', jobId, spec: targetSpec });
    },
    [postJob],
  );

  const runPlaceOnly = useCallback(
    (targetSpec: DesignSpec) => {
      const jobId = ++jobIdRef.current;
      postJob({ type: 'run-place', jobId, spec: targetSpec });
    },
    [postJob],
  );

  const runReroute = useCallback(
    (targetSpec: DesignSpec, curSynth: SynthesisResult, curFloorplan: FloorplanResult) => {
      const jobId = ++jobIdRef.current;
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
    setSpec((prev) => {
      const next = updater(prev);
      if (autoRun) runFull(next);
      return next;
    });
  };

  const handleMovePin = useCallback(
    (pinId: string, edge: Edge, offset: number) => {
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
    [spec, synthesis, floorplan, runReroute, runFull],
  );

  const handleMoveMacro = useCallback(
    (macroId: string, x: number, y: number) => {
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
    [spec, synthesis, floorplan, runReroute],
  );

  const handleRotateMacro = useCallback(
    (macroId: string) => {
      if (!floorplan) return;
      const pm = floorplan.macros.find((m) => m.id === macroId);
      if (!pm) return;
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
    [floorplan, spec, synthesis, runReroute],
  );

  const handleFlipMacro = useCallback(
    (macroId: string) => {
      if (!floorplan) return;
      const pm = floorplan.macros.find((m) => m.id === macroId);
      if (!pm) return;
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
    [floorplan, spec, synthesis, runReroute],
  );

  const handleCopyBlueprint = async () => {
    if (!fullResult?.blueprintString) return;
    await navigator.clipboard.writeText(fullResult.blueprintString);
    showToast(
      `Copied Factorio 2.0 blueprint string (${allEntities.length} entities)!`,
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

  return (
    <div className="studio-shell">
      {/* Top EDA Toolbar */}
      <header className="top-bar">
        <div className="brand">
          <Cpu size={18} color="#f59e0b" />
          <span>Factorio EDA</span>
          <span className="brand-badge">2.0 P&amp;R</span>
        </div>

        <select
          className="select"
          style={{ width: 225 }}
          value=""
          onChange={(e) => {
            const p = BUILTIN_PRESETS.find((pr) => pr.id === e.target.value);
            if (p) {
              const cloned = structuredClone(p.spec);
              setSpec(cloned);
              setSelection(null);
              runFull(cloned);
            }
          }}
        >
          <option value="" disabled>
            Load Benchmark Preset…
          </option>
          {BUILTIN_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>

        {/* Stage Stepper */}
        <div className="row" style={{ gap: 4 }}>
          <button
            className="btn btn-sm"
            onClick={() => runSynthOnly(spec)}
            disabled={running}
            title="Run Stage 1: Synthesis"
          >
            1. Synth
          </button>
          <button
            className="btn btn-sm"
            onClick={() => runPlaceOnly(spec)}
            disabled={running}
            title="Run Stages 1-2: Synth + Macro Placement"
          >
            2. Place
          </button>
          <button
            className="btn btn-sm"
            onClick={() => synthesis && floorplan && runReroute(spec, synthesis, floorplan)}
            disabled={running || !synthesis || !floorplan}
            title="Run Stages 3-4: Route + PDN + Signoff preserving current Floorplan"
          >
            3. Re-Route
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => runFull(spec)}
            disabled={running}
          >
            <Play size={13} /> {running ? 'Running…' : 'Run Full P&R'}
          </button>
        </div>

        {progress && (
          <span className="pill pill-info">
            {running ? '⏳ ' : ''}
            {progress.message}
          </span>
        )}

        <div style={{ marginLeft: 'auto' }} className="row">
          <button
            className="btn btn-cyan btn-sm"
            disabled={!fullResult?.blueprintString}
            onClick={handleCopyBlueprint}
          >
            <ClipboardCopy size={13} /> Copy Blueprint
          </button>
          <button className="btn btn-sm" onClick={handleShareUrl}>
            <Share2 size={13} /> Share URL
          </button>
          <button
            className="btn btn-sm"
            disabled={!fullResult}
            onClick={handleExportSvg}
          >
            <Download size={13} /> Export SVG
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
      <div className="workspace-grid">
        {/* Left Panel: Spec & PDK */}
        <aside className="side-panel">
          <div className="panel-section">
            <div className="section-title">
              <span>Design Targets</span>
              <button
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
                    <select
                      className="select"
                      value={t.item}
                      onChange={(e) => {
                        const val = e.target.value;
                        updateSpec((prev) => ({
                          ...prev,
                          targets: prev.targets.map((item, i) =>
                            i === idx ? { ...item, item: val } : item,
                          ),
                        }));
                      }}
                    >
                      {targetOptions.map((r) => (
                        <option key={r.id} value={r.outputItem}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                    {spec.targets.length > 1 && (
                      <button
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
                        min={1}
                        step={15}
                        value={t.ratePerMin}
                        onChange={(e) => {
                          const v = Math.max(1, Number(e.target.value) || 1);
                          updateSpec((prev) => ({
                            ...prev,
                            targets: prev.targets.map((item, i) =>
                              i === idx ? { ...item, ratePerMin: v } : item,
                            ),
                          }));
                        }}
                      />
                      <span style={{ fontSize: 11, color: 'var(--bp-text-muted)' }}>/min</span>
                    </div>
                    <span className="mono" style={{ fontSize: 11, color: 'var(--bp-cyan)' }}>
                      {(t.ratePerMin / beltCapacity).toFixed(2)} belts
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
                  onChange={(e) =>
                    updateSpec((prev) => ({
                      ...prev,
                      floorplan: {
                        ...prev.floorplan,
                        mode: e.target.value as 'auto' | 'fixed',
                        width: prev.floorplan.width ?? floorplan?.width ?? 60,
                        height: prev.floorplan.height ?? floorplan?.height ?? 45,
                      },
                    }))
                  }
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
                    min={0.6}
                    max={2.5}
                    value={spec.floorplan.aspectRatio}
                    onChange={(e) =>
                      updateSpec((prev) => ({
                        ...prev,
                        floorplan: {
                          ...prev.floorplan,
                          aspectRatio: Number(e.target.value) || 1.35,
                        },
                      }))
                    }
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
                      value={spec.floorplan.width ?? 60}
                      onChange={(e) =>
                        updateSpec((prev) => ({
                          ...prev,
                          floorplan: {
                            ...prev.floorplan,
                            width: Math.max(16, Number(e.target.value) || 60),
                          },
                        }))
                      }
                    />
                  </div>
                  <div>
                    <label className="field-label">H</label>
                    <input
                      type="number"
                      className="input mono"
                      min={16}
                      value={spec.floorplan.height ?? 45}
                      onChange={(e) =>
                        updateSpec((prev) => ({
                          ...prev,
                          floorplan: {
                            ...prev.floorplan,
                            height: Math.max(16, Number(e.target.value) || 45),
                          },
                        }))
                      }
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
                    (prev) => ({
                      ...prev,
                      optimization: defaultOptimizationConfig(lvl),
                    }),
                    true,
                  );
                }}
              >
                <option value="compact">Compact (Layered Bus + All Opts)</option>
                <option value="balanced">Balanced (Layered + Compact)</option>
                <option value="fast">Fast</option>
              </select>
            </div>
            {(spec.pins.length > 0 || Object.keys(spec.macroOverrides).length > 0) && (
              <button
                className="btn btn-sm"
                style={{ width: '100%', marginTop: 8, justifyContent: 'center' }}
                onClick={() =>
                  updateSpec(
                    (prev) => ({ ...prev, pins: [], macroOverrides: {} }),
                    true,
                  )
                }
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
                    title="Toggle Factorio Alt-Mode item & recipe icons"
                  >
                    Alt-Mode
                  </button>
                )}

                {(
                  [
                    ['macros', 'Macros'],
                    ['belts', 'Belts'],
                    ['undergrounds', 'Undergrounds'],
                    ['powerGrid', 'Power'],
                    ['powerCoverage', 'Supply Area'],
                    ['flylines', 'Flylines'],
                    ['heatmap', 'Util Heatmap'],
                    ['pinLabels', 'Pins'],
                    ['drc', 'DRC'],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    className={`chip ${layers[key] ? 'on' : ''}`}
                    onClick={() => setLayers((l) => ({ ...l, [key]: !l[key] }))}
                  >
                    {label}
                  </button>
                ))}

                {renderMode === 'factorio' && (
                  <>
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
                    <button
                      className="btn btn-sm"
                      onClick={() => spriteInputRef.current?.click()}
                      title="Optional: pick your local Factorio/data/base/graphics folder to render native game entity spritesheets 100% locally"
                    >
                      <FolderOpen size={12} />{' '}
                      {localSpritesInfo
                        ? `Local (${localSpritesInfo.entities}ent/${localSpritesInfo.icons}ico)`
                        : 'Load Local Sprites'}
                    </button>
                    {localSpritesInfo && (
                      <button
                        className="chip"
                        onClick={() => {
                          clearLocalFactorioAssets();
                          setLocalSpritesInfo(null);
                          setAssetVersion((v) => v + 1);
                        }}
                        title="Revert to built-in Factorio CDN icons & vector buildings"
                      >
                        ×
                      </button>
                    )}
                  </>
                )}
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
            />
          )}

          {activeTab === 'netlist' && (
            <NetlistView
              synthesis={synthesis}
              spec={spec}
              onToggleInputOverride={(item, nextMode) => {
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
                setSpec(next);
                setSelection(null);
                runFull(next);
              }}
            />
          )}
        </main>

        {/* Right Panel: Inspector, Signoff (DRC/STA), BOM */}
        <aside className="side-panel right">
          {/* Inspector for Selected Pin or Macro */}
          {(selectedPin || selectedMacro) && (
            <div className="panel-section">
              <div className="section-title">
                <span>{selectedPin ? 'Pin Inspector' : 'Macro Inspector'}</span>
                <button className="btn btn-sm" onClick={() => setSelection(null)}>
                  Clear
                </button>
              </div>

              {selectedPin && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div className="mono" style={{ fontWeight: 700, color: '#f8fafc' }}>
                    {selectedPin.id}
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
                  <div style={{ fontWeight: 700, color: '#f8fafc' }}>
                    {selectedMacro.macro.label} ({selectedMacro.macro.sublabel})
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
                      ⇅ Flip Y{selectedMacro.macro.flippedY ? ' (On)' : ''}
                    </button>
                    <button
                      className="btn btn-sm"
                      onClick={() => {
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
                <div style={{ maxHeight: 150, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {sta.nets.slice(0, 12).map((n) => (
                    <div key={n.netId} style={{ fontSize: 11 }}>
                      <div className="row" style={{ justifyContent: 'space-between' }}>
                        <span>{n.item}</span>
                        <span className="mono">{(n.utilization * 100).toFixed(0)}%</span>
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
                    </div>
                  ))}
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
                        style={{
                          justifyContent: 'space-between',
                          fontSize: 11.5,
                          padding: '2px 4px',
                          background: '#0b1e33',
                          borderRadius: 3,
                        }}
                      >
                        <span className="mono">{name}</span>
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
