import React, { useMemo } from 'react';
import { DagSummaryNode, DesignSpec, SynthesisResult, getItemMeta } from '@factorio-eda/core';
import { GitBranch } from 'lucide-react';
import { resolveIconUrl } from '../sprites/factorioAssets';

interface NetlistViewProps {
  synthesis: SynthesisResult | null;
  spec: DesignSpec;
  onToggleInputOverride: (item: string, nextMode: 'input' | 'synthesize' | 'auto') => void;
}

export const NetlistView: React.FC<NetlistViewProps> = ({
  synthesis,
  spec,
  onToggleInputOverride,
}) => {
  const layout = useMemo(() => {
    if (!synthesis) return null;

    // Assign topological column layers from input pins (col 0) to final targets
    const depth = new Map<string, number>();
    const nodeByItem = new Map<string, DagSummaryNode>();
    for (const d of synthesis.dag) {
      nodeByItem.set(d.item, d);
    }

    const computeDepth = (item: string, stack = new Set<string>()): number => {
      if (depth.has(item)) return depth.get(item)!;
      if (stack.has(item)) return 0;
      stack.add(item);
      const node = nodeByItem.get(item);
      if (!node || node.mode === 'input-pin' || node.ingredients.length === 0) {
        depth.set(item, 0);
        return 0;
      }
      const maxParent = Math.max(
        0,
        ...node.ingredients.map((ing) => computeDepth(ing.item, stack) + 1),
      );
      depth.set(item, maxParent);
      return maxParent;
    };

    for (const d of synthesis.dag) {
      computeDepth(d.item);
    }

    const columns = new Map<number, DagSummaryNode[]>();
    let maxCol = 0;
    for (const d of synthesis.dag) {
      const c = depth.get(d.item) ?? 0;
      maxCol = Math.max(maxCol, c);
      const list = columns.get(c) ?? [];
      list.push(d);
      columns.set(c, list);
    }

    const nodeW = 208;
    const nodeH = 64;
    const colGap = 72;
    const rowGap = 18;
    const padX = 28;
    const padY = 28;

    const pos = new Map<string, { x: number; y: number }>();
    let maxRows = 1;
    for (let c = 0; c <= maxCol; c++) {
      const list = columns.get(c) ?? [];
      maxRows = Math.max(maxRows, list.length);
      list.forEach((d, r) => {
        pos.set(d.item, {
          x: padX + c * (nodeW + colGap),
          y: padY + r * (nodeH + rowGap),
        });
      });
    }

    const svgW = Math.max(600, padX * 2 + (maxCol + 1) * nodeW + maxCol * colGap);
    const svgH = Math.max(420, padY * 2 + maxRows * nodeH + Math.max(0, maxRows - 1) * rowGap);

    return { pos, nodeW, nodeH, svgW, svgH, targetSet: new Set(spec.targets.map((t) => t.item)) };
  }, [synthesis, spec.targets]);

  if (!synthesis || !layout) {
    return (
      <div style={{ padding: 24, color: 'var(--text-secondary)' }}>
        Run Synthesis or Full P&amp;R to view the synthesized Netlist DAG.
      </div>
    );
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, background: 'transparent' }}>
      <div className="view-toolbar" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
        <span className="row" style={{ gap: 7 }}>
          <GitBranch size={13} style={{ color: 'var(--accent-cyan)', flexShrink: 0 }} />
          <span>
            Synthesized Item DAG — Click any intermediate node to toggle{' '}
            <strong style={{ color: 'var(--status-pass)' }}>External Input Pin</strong> vs{' '}
            <strong style={{ color: 'var(--accent-cyan)' }}>Synthesize Internally</strong>
          </span>
        </span>
        <span className="pill pill-info">{synthesis.nets.length} physical nets</span>
      </div>

      <div style={{ flex: 1, overflow: 'auto', position: 'relative' }}>
        <svg width={layout.svgW} height={layout.svgH}>
          <defs>
            <pattern id="netlist-dot-grid" width="16" height="16" patternUnits="userSpaceOnUse">
              <circle cx="1" cy="1" r="1" fill="rgba(56, 189, 248, 0.14)" />
            </pattern>
            <pattern id="netlist-major-grid" width="80" height="80" patternUnits="userSpaceOnUse">
              <rect width="80" height="80" fill="url(#netlist-dot-grid)" />
              <path
                d="M 80 0 L 0 0 0 80"
                fill="none"
                stroke="rgba(56, 189, 248, 0.05)"
                strokeWidth="1"
              />
            </pattern>
            <marker
              id="dag-arrow"
              markerWidth="8"
              markerHeight="8"
              refX="7"
              refY="4"
              orient="auto"
            >
              <path d="M0,1 L7,4 L0,7 Z" fill="#38bdf8" />
            </marker>
          </defs>

          <rect width={layout.svgW} height={layout.svgH} fill="url(#netlist-major-grid)" />

          {/* Edges */}
          {synthesis.dag.map((d) => {
            const dstPos = layout.pos.get(d.item);
            if (!dstPos) return null;
            return d.ingredients.map((ing) => {
              const srcPos = layout.pos.get(ing.item);
              if (!srcPos) return null;
              const x1 = srcPos.x + layout.nodeW;
              const y1 = srcPos.y + layout.nodeH / 2;
              const x2 = dstPos.x;
              const y2 = dstPos.y + layout.nodeH / 2;
              const cx = (x1 + x2) / 2;
              return (
                <g key={`${ing.item}->${d.item}`}>
                  <path
                    d={`M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`}
                    fill="none"
                    stroke="#4b586e"
                    strokeWidth={2}
                    markerEnd="url(#dag-arrow)"
                  />
                  <text
                    x={cx}
                    y={(y1 + y2) / 2 - 4}
                    fill="#7dd3fc"
                    fontSize="10"
                    textAnchor="middle"
                    fontFamily="var(--font-mono)"
                    style={{ fontVariantNumeric: 'tabular-nums' }}
                  >
                    {(ing.ratePerSec * 60).toFixed(0)}/m
                  </text>
                </g>
              );
            });
          })}

          {/* Nodes */}
          {synthesis.dag.map((d) => {
            const p = layout.pos.get(d.item);
            if (!p) return null;
            const meta = getItemMeta(d.item);
            const isTarget = layout.targetSet.has(d.item);
            const isInput = d.mode === 'input-pin';
            const lockedReason = d.forcedInputReason === 'no-recipe';
            const canToggle = !lockedReason && !isTarget;
            const borderColor = isTarget
              ? '#f59e0b'
              : isInput
                ? '#4ade80'
                : '#38bdf8';

            const handleToggle = () => {
              if (!canToggle) return;
              onToggleInputOverride(d.item, isInput ? 'synthesize' : 'input');
            };

            return (
              <g
                key={d.item}
                transform={`translate(${p.x}, ${p.y})`}
                style={{ cursor: canToggle ? 'pointer' : 'default', outline: 'none' }}
                role={canToggle ? 'button' : undefined}
                tabIndex={canToggle ? 0 : undefined}
                aria-label={
                  canToggle
                    ? `${meta.name}: currently ${isInput ? 'External Input Pin' : 'Synthesize Internally'}. Press Enter to toggle.`
                    : undefined
                }
                onClick={handleToggle}
                onKeyDown={(e) => {
                  if (canToggle && (e.key === 'Enter' || e.key === ' ')) {
                    e.preventDefault();
                    handleToggle();
                  }
                }}
              >
                <rect
                  width={layout.nodeW}
                  height={layout.nodeH}
                  rx={6}
                  fill="#1b212b"
                  stroke={borderColor}
                  strokeWidth={1.6}
                />
                <circle cx={20} cy={22} r={11} fill="#0e1116" stroke={meta.color} strokeWidth={1.3} />
                <image
                  href={resolveIconUrl(d.item)}
                  x={11}
                  y={13}
                  width={18}
                  height={18}
                  preserveAspectRatio="xMidYMid meet"
                />
                <text x={37} y={25} fill="#e6edf5" fontSize="12" fontWeight="700">
                  {meta.name.length > 17 ? meta.name.slice(0, 16) + '…' : meta.name}
                </text>
                <text
                  x={12}
                  y={46}
                  fill="#9aa8bc"
                  fontSize="10.5"
                  fontFamily="var(--font-mono)"
                  style={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  {d.demandPerMin.toFixed(1)}/min • {d.beltCount}b
                  {d.machineCount > 0 ? ` • ${d.machineCount}×` : ''}
                </text>
                <rect
                  x={layout.nodeW - 64}
                  y={36}
                  width={56}
                  height={18}
                  rx={4}
                  fill={
                    isTarget
                      ? 'rgba(245,158,11,0.18)'
                      : isInput
                        ? 'rgba(74,222,128,0.16)'
                        : 'rgba(56,189,248,0.16)'
                  }
                />
                <text
                  x={layout.nodeW - 36}
                  y={48}
                  fill={borderColor}
                  fontSize="9.5"
                  fontWeight="700"
                  textAnchor="middle"
                  fontFamily="var(--font-mono)"
                >
                  {isTarget
                    ? 'TARGET'
                    : isInput
                      ? d.forcedInputReason === 'fluid-v1'
                        ? 'FLUID PIN'
                        : 'IN PIN'
                      : 'SYNTH'}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
};
