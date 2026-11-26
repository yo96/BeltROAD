import React, { useMemo, useState } from 'react';
import {
  ByproductPolicy,
  DesignSpec,
  INPUT_PRESET_LIST,
  InputBoundaryTreeNode,
  InputPreset,
  getItemMeta,
  inspectInputBoundary,
} from '@factorio-eda/core';
import { ChevronDown, ChevronRight, RotateCcw, Search, X } from 'lucide-react';
import { ItemIcon } from './ItemIcon';

interface InputMaterialsPanelProps {
  spec: DesignSpec;
  activeByproducts?: Array<{ item: string; ratePerSec: number; policy: ByproductPolicy }>;
  onSelectPreset: (preset: InputPreset) => void;
  onChangeByproductPolicy: (policy: ByproductPolicy) => void;
  onToggleItem: (
    item: string,
    nextMode: 'input' | 'synthesize' | 'auto',
    ancestorChain?: string[],
  ) => void;
  onResetOverrides: () => void;
}

export const InputMaterialsPanel: React.FC<InputMaterialsPanelProps> = ({
  spec,
  activeByproducts,
  onSelectPreset,
  onChangeByproductPolicy,
  onToggleItem,
  onResetOverrides,
}) => {
  const [query, setQuery] = useState('');
  const [viewMode, setViewMode] = useState<'tree' | 'flat'>('tree');
  const [expandState, setExpandState] = useState<Record<string, boolean>>({});

  const inspection = useMemo(() => inspectInputBoundary(spec), [spec]);

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    const candidates = inspection.allItems.filter((it) => it.mode !== 'target');
    if (!q) return candidates;
    return candidates.filter((it) => {
      if (it.name.toLowerCase().includes(q) || it.item.toLowerCase().includes(q)) {
        return true;
      }
      if (it.category.toLowerCase().includes(q)) return true;
      if ((q.includes('liquid') || q.includes('fluid')) && (it.isFluid || it.hasFluidRecipe)) {
        return true;
      }
      if (q === 'raw' && !it.hasRecipe) return true;
      if ((q === 'in' || q === 'pin') && it.mode === 'input') return true;
      if ((q === 'build' || q === 'synth') && it.mode === 'synthesize') return true;
      return false;
    });
  }, [inspection.allItems, query]);

  const isNodeExpanded = (node: InputBoundaryTreeNode): boolean => {
    if (node.pathKey in expandState) return expandState[node.pathKey];
    if (node.depth === 0) return true;
    return node.status === 'synthesize' && node.depth <= 2;
  };

  const toggleExpand = (pathKey: string, currentlyOpen: boolean) => {
    setExpandState((prev) => ({ ...prev, [pathKey]: !currentlyOpen }));
  };

  const renderTreeNode = (node: InputBoundaryTreeNode): React.ReactNode => {
    const hasChildren = node.children.length > 0;
    const expanded = hasChildren && isNodeExpanded(node);
    const isBehind = node.status === 'behind-input';
    const isTarget = node.status === 'target';
    const isInput = node.status === 'input';
    const isSynth = node.status === 'synthesize';

    const statusTooltip = isTarget
      ? 'Design Target'
      : !node.hasRecipe
        ? 'Raw resource (no crafting recipe — always an input pin)'
        : isBehind
          ? `Behind external input pin (${node.ancestorChain[node.ancestorChain.length - 1] ?? 'parent'}). Click IN or BUILD to customize this level.`
          : node.reason === 'fluid-disabled'
            ? 'Fluid/chem recipe (clicking BUILD auto-enables fluids in PDK)'
            : `${node.name} — ${isInput ? 'External Input Pin' : 'Synthesized On-Site'}`;

    return (
      <React.Fragment key={node.pathKey}>
        <div
          className={`input-tree-row ${isTarget ? 'is-target' : ''} ${isBehind ? 'is-behind' : ''}`}
          style={{ paddingLeft: 6 + node.depth * 11 }}
          title={statusTooltip}
        >
          {hasChildren ? (
            <button
              type="button"
              className="input-tree-chevron"
              aria-label={expanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
              onClick={() => toggleExpand(node.pathKey, expanded)}
            >
              {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            </button>
          ) : (
            <span className="input-tree-chevron-spacer" aria-hidden="true" />
          )}

          <ItemIcon itemId={node.item} size={14} />

          <span className="input-tree-label">
            {node.name}
            {node.isOverridden && (
              <span className="input-override-dot" title="Custom override" aria-label="Overridden" />
            )}
          </span>

          {isTarget ? (
            <span className="input-role-tag target">TARGET</span>
          ) : !node.hasRecipe ? (
            <span className="input-role-tag raw">RAW</span>
          ) : (
            <div className="mode-seg" role="group" aria-label={`Mode for ${node.name}`}>
              <button
                type="button"
                className={`mode-seg-btn in ${isInput ? 'active' : ''}`}
                onClick={() => onToggleItem(node.item, 'input', node.ancestorChain)}
                title="Treat as external perimeter input pin"
              >
                IN
              </button>
              <button
                type="button"
                className={`mode-seg-btn build ${isSynth ? 'active' : ''}`}
                onClick={() => onToggleItem(node.item, 'synthesize', node.ancestorChain)}
                title="Synthesize on-site from its ingredients"
              >
                BUILD
              </button>
            </div>
          )}
        </div>
        {expanded && node.children.map((child) => renderTreeNode(child))}
      </React.Fragment>
    );
  };

  const showFlatList = viewMode === 'flat' || query.trim().length > 0;
  const activePresetMeta = INPUT_PRESET_LIST.find((p) => p.id === spec.inputPreset);

  return (
    <div className="input-materials-panel">
      {/* Preset Strip */}
      <div className="input-subhead-row">
        <span className="field-label" style={{ margin: 0 }}>
          Boundary Preset
        </span>
        {inspection.overrideCount > 0 && (
          <div className="row" style={{ gap: 5 }}>
            <span className="input-custom-badge">
              +{inspection.overrideCount} custom
            </span>
            <button
              type="button"
              className="btn-link-reset"
              onClick={onResetOverrides}
              title="Clear custom material overrides and revert to preset"
            >
              <RotateCcw size={10} /> Reset
            </button>
          </div>
        )}
      </div>

      <div className="input-preset-grid" role="group" aria-label="Input boundary presets">
        {INPUT_PRESET_LIST.map((preset) => {
          const isActive = spec.inputPreset === preset.id;
          return (
            <button
              key={preset.id}
              type="button"
              className={`input-preset-btn ${isActive ? 'active' : ''}`}
              title={preset.description}
              onClick={() => onSelectPreset(preset.id)}
            >
              {preset.shortLabel}
            </button>
          );
        })}
      </div>

      {activePresetMeta && (
        <div className="input-preset-hint">{activePresetMeta.description}</div>
      )}

      {/* Active External Input Pins Strip */}
      <div className="input-subhead-row" style={{ marginTop: 9 }}>
        <span className="field-label" style={{ margin: 0 }}>
          Active Input Pins ({inspection.activeInputs.length})
        </span>
        <span className="input-subhead-hint">click pin to expand</span>
      </div>

      <div className="input-pins-strip">
        {inspection.activeInputs.length === 0 ? (
          <span className="input-pins-empty">No external inputs</span>
        ) : (
          inspection.activeInputs.map((pinItem) => (
            <button
              key={pinItem.item}
              type="button"
              disabled={!pinItem.canSynthesize}
              className={`input-pin-chip ${pinItem.canSynthesize ? 'craftable' : 'raw'} ${
                pinItem.isOverridden ? 'overridden' : ''
              }`}
              title={
                pinItem.canSynthesize
                  ? `${pinItem.name}: External Input Pin — click to build on-site instead`
                  : `${pinItem.name}: Raw resource (no crafting recipe)`
              }
              onClick={() => {
                if (pinItem.canSynthesize) {
                  onToggleItem(pinItem.item, 'synthesize');
                }
              }}
            >
              <ItemIcon itemId={pinItem.item} size={13} />
              <span className="input-pin-chip-name">{pinItem.name}</span>
              {pinItem.isFluid && <span className="input-pin-fluid-dot" title="Liquid / Gas" />}
              {!pinItem.canSynthesize && <span className="input-pin-raw-tag">raw</span>}
            </button>
          ))
        )}
      </div>

      {/* Side-Product Handling Policy */}
      <div className="input-subhead-row" style={{ marginTop: 9 }}>
        <span className="field-label" style={{ margin: 0 }}>
          Side Products
        </span>
        <div className="unit-toggle" role="group" aria-label="Side product policy">
          <button
            type="button"
            className={`unit-btn ${(spec.byproductPolicy ?? 'auto-consume') === 'auto-consume' ? 'active' : ''}`}
            title="Automatically crack/convert co-products toward demanded outputs when beneficial"
            onClick={() => onChangeByproductPolicy('auto-consume')}
          >
            Auto-Crack
          </button>
          <button
            type="button"
            className={`unit-btn ${spec.byproductPolicy === 'export' ? 'active' : ''}`}
            title="Export co-products directly on dedicated BYP perimeter pins without cracking"
            onClick={() => onChangeByproductPolicy('export')}
          >
            Export Pins
          </button>
        </div>
      </div>

      {activeByproducts && activeByproducts.length > 0 && (
        <div className="input-pins-strip" style={{ marginTop: 4 }}>
          {activeByproducts.map((bp) => {
            const meta = getItemMeta(bp.item);
            return (
              <span
                key={bp.item}
                className="input-pin-chip byproduct"
                title={`Exported side product (${(bp.ratePerSec * 60).toFixed(1)}/min) on perimeter BYP pin`}
              >
                <ItemIcon itemId={bp.item} size={13} />
                <span className="input-pin-chip-name">{meta.name}</span>
                <span className="input-pin-byp-tag">
                  +{Math.round(bp.ratePerSec * 60)}/m
                </span>
              </span>
            );
          })}
        </div>
      )}

      {/* Multi-level Tree & Search */}
      <div className="input-subhead-row" style={{ marginTop: 9 }}>
        <span className="field-label" style={{ margin: 0 }}>
          Supply Chain Levels
        </span>
        <div className="unit-toggle" role="group" aria-label="Supply chain view mode">
          <button
            type="button"
            className={`unit-btn ${viewMode === 'tree' ? 'active' : ''}`}
            onClick={() => setViewMode('tree')}
          >
            Tree
          </button>
          <button
            type="button"
            className={`unit-btn ${viewMode === 'flat' ? 'active' : ''}`}
            onClick={() => setViewMode('flat')}
          >
            All Levels
          </button>
        </div>
      </div>

      <div className="input-tree-box">
        <div className="input-tree-search-wrap">
          <Search size={12} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
          <input
            type="text"
            className="input-tree-search"
            aria-label="Filter supply chain materials"
            placeholder="Filter any level (e.g. gear, cable, circuit)…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button
              type="button"
              className="input-tree-clear"
              aria-label="Clear filter"
              onClick={() => setQuery('')}
            >
              <X size={11} />
            </button>
          )}
        </div>

        <div className="input-tree-scroll">
          {showFlatList ? (
            filteredItems.length === 0 ? (
              <div className="input-tree-empty">No materials match "{query}"</div>
            ) : (
              filteredItems.map((it) => {
                const isBehind = it.mode === 'behind-input';
                const isInput = it.mode === 'input';
                const isSynth = it.mode === 'synthesize';
                return (
                  <div
                    key={it.item}
                    className={`input-tree-row ${isBehind ? 'is-behind' : ''}`}
                    style={{ paddingLeft: 7 }}
                    title={
                      isBehind
                        ? `${it.name} (Level ${it.minDepth}, behind an upstream input pin). Click IN or BUILD to apply at this level.`
                        : `${it.name} (Level ${it.minDepth})`
                    }
                  >
                    <span className="input-depth-pill">L{it.minDepth}</span>
                    <ItemIcon itemId={it.item} size={14} />
                    <span className="input-tree-label">
                      {it.name}
                      {it.isOverridden && (
                        <span
                          className="input-override-dot"
                          title="Custom override"
                          aria-label="Overridden"
                        />
                      )}
                    </span>
                    {!it.hasRecipe ? (
                      <span className="input-role-tag raw">RAW</span>
                    ) : (
                      <div className="mode-seg" role="group" aria-label={`Mode for ${it.name}`}>
                        <button
                          type="button"
                          className={`mode-seg-btn in ${isInput ? 'active' : ''}`}
                          onClick={() => onToggleItem(it.item, 'input')}
                        >
                          IN
                        </button>
                        <button
                          type="button"
                          className={`mode-seg-btn build ${isSynth ? 'active' : ''}`}
                          onClick={() => onToggleItem(it.item, 'synthesize')}
                        >
                          BUILD
                        </button>
                      </div>
                    )}
                  </div>
                );
              })
            )
          ) : (
            inspection.roots.map((root) => renderTreeNode(root))
          )}
        </div>
      </div>
    </div>
  );
};
