import React, { useMemo } from 'react';
import { DagSummaryNode, DesignSpec, SynthesisResult, getItemMeta } from '@factorio-eda/core';

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

    const nodeW = 205;
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
      <div style={{ padding: 24, color: 'var(--bp-text-muted)' }}>
        Run Synthesis or Full P&amp;R to view the synthesized Netlist DAG.
      </div>
    );
  }

  return (
    <div style={{ flex: 1, overflow: 'auto', background: '#091b2e', position: 'relative' }}>
      <div
        style={{
          padding: '8px 14px',
          borderBottom: '1px solid var(--bp-border)',
          background: '#0d2238',
          fontSize: 12,
          color: 'var(--bp-text-muted)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span>
          Synthesized Item DAG — Click any intermediate node to toggle{' '}
          <strong style={{ color: '#4ade80' }}>External Input Pin</strong> vs{' '}
          <strong style={{ color: '#38bdf8' }}>Synthesize Internally</strong>
        </span>
        <span className="mono">{synthesis.nets.length} physical nets</span>
      </div>

      <svg width={layout.svgW} height={layout.svgH}>
        <defs>
          <marker
            id="dag-arrow"
            markerWidth="8"
            markerHeight="8"
            refX="7"
            refY="4"
            orient="auto"
          >
            <path d="M0,1 L7,4 L0,7 Z" fill="#60a5fa" />
          </marker>
        </defs>

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
                  stroke="#3b82c4"
                  strokeWidth={2}
                  markerEnd="url(#dag-arrow)"
                />
                <text
                  x={cx}
                  y={(y1 + y2) / 2 - 4}
                  fill="#93c5fd"
                  fontSize="10"
                  textAnchor="middle"
                  fontFamily="var(--font-mono)"
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
          const lockedReason =
            d.forcedInputReason === 'no-recipe' || d.forcedInputReason === 'fluid-v1';
          const borderColor = isTarget
            ? '#f59e0b'
            : isInput
              ? '#4ade80'
              : '#38bdf8';

          return (
            <g
              key={d.item}
              transform={`translate(${p.x}, ${p.y})`}
              style={{ cursor: lockedReason || isTarget ? 'default' : 'pointer' }}
              onClick={() => {
                if (lockedReason || isTarget) return;
                onToggleInputOverride(d.item, isInput ? 'synthesize' : 'input');
              }}
            >
              <rect
                width={layout.nodeW}
                height={layout.nodeH}
                rx={6}
                fill="#102a45"
                stroke={borderColor}
                strokeWidth={1.8}
              />
              <circle cx={18} cy={22} r={8} fill={meta.color} stroke="#091a2c" strokeWidth={1.2} />
              <text x={32} y={25} fill="#f8fafc" fontSize="12" fontWeight="700">
                {meta.name.length > 18 ? meta.name.slice(0, 17) + '…' : meta.name}
              </text>
              <text
                x={12}
                y={46}
                fill="#93c5fd"
                fontSize="10.5"
                fontFamily="var(--font-mono)"
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
                    ? 'rgba(245,158,11,0.2)'
                    : isInput
                      ? 'rgba(74,222,128,0.18)'
                      : 'rgba(56,189,248,0.18)'
                }
              />
              <text
                x={layout.nodeW - 36}
                y={48}
                fill={borderColor}
                fontSize="9.5"
                fontWeight="700"
                textAnchor="middle"
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
  );
};
