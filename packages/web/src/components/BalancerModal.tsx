import React, { useEffect, useState } from 'react';
import {
  BUILTIN_BALANCERS,
  BalancerTemplate,
  importBalancerBook,
} from '@factorio-eda/core';
import { Layers, Trash2, Upload, X } from 'lucide-react';

interface BalancerModalProps {
  open: boolean;
  customBalancers: BalancerTemplate[];
  onClose: () => void;
  onAddBalancers: (imported: BalancerTemplate[]) => void;
  onClearCustom: () => void;
}

export const BalancerModal: React.FC<BalancerModalProps> = ({
  open,
  customBalancers,
  onClose,
  onAddBalancers,
  onClearCustom,
}) => {
  const [bpInput, setBpInput] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const handleImport = () => {
    try {
      const res = importBalancerBook(bpInput);
      if (res.balancers.length === 0) {
        setError('No valid belt balancers found in the blueprint string.');
        setStatus(null);
        return;
      }
      onAddBalancers(res.balancers);
      setError(null);
      setStatus(
        `Imported ${res.balancers.length} balancer(s) (normalized to Factorio 2.0, skipped ${res.skipped}).`,
      );
      setBpInput('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus(null);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="balancer-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div className="row" style={{ gap: 8 }}>
            <Layers size={15} style={{ color: 'var(--accent-brass)' }} />
            <strong id="balancer-modal-title">PDK Balancer Hard-IP Library</strong>
          </div>
          <button
            type="button"
            className="btn btn-sm"
            onClick={onClose}
            aria-label="Close modal"
          >
            <X size={14} />
          </button>
        </div>

        <div style={{ padding: 16, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label className="field-label" htmlFor="balancer-bp-input">
              Paste Factorio Blueprint or Blueprint Book String (e.g. FactorioBin KafN8H7L — 1.1 &amp; 2.0 supported)
            </label>
            <textarea
              id="balancer-bp-input"
              className="input mono"
              rows={4}
              placeholder="0eNq..."
              value={bpInput}
              onChange={(e) => setBpInput(e.target.value)}
            />
            <div className="row" style={{ marginTop: 8 }}>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={handleImport}
                disabled={!bpInput.trim()}
              >
                <Upload size={13} /> Import to PDK
              </button>
              {customBalancers.length > 0 && (
                <button type="button" className="btn btn-sm" onClick={onClearCustom}>
                  <Trash2 size={13} /> Clear Custom ({customBalancers.length})
                </button>
              )}
            </div>
            {status && (
              <div style={{ marginTop: 6, color: 'var(--status-pass)', fontSize: 12 }}>{status}</div>
            )}
            {error && (
              <div style={{ marginTop: 6, color: 'var(--status-fail)', fontSize: 12 }}>{error}</div>
            )}
          </div>

          {customBalancers.length > 0 && (
            <div>
              <div className="section-title">Imported Custom Balancers ({customBalancers.length})</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(175px, 1fr))', gap: 6 }}>
                {customBalancers.map((b) => (
                  <div key={b.id} className="kpi-card">
                    <div style={{ fontWeight: 700, fontSize: 12 }}>{b.name}</div>
                    <div className="mono" style={{ fontSize: 11, color: 'var(--accent-cyan)' }}>
                      {b.inputs}×{b.outputs} • {b.width}×{b.height} • {b.beltTier}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div>
            <div className="section-title">
              Built-in Curated Balancers ({BUILTIN_BALANCERS.length} + Procedural Fallback)
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 6 }}>
              {BUILTIN_BALANCERS.map((b) => (
                <div key={b.id} className="kpi-card">
                  <div style={{ fontWeight: 600, fontSize: 12 }}>{b.name}</div>
                  <div className="mono" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                    {b.inputs}×{b.outputs} • {b.width}×{b.height}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
