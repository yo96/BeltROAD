import React, { useState } from 'react';
import {
  BUILTIN_BALANCERS,
  BalancerTemplate,
  importBalancerBook,
} from '@factorio-eda/core';
import { Trash2, Upload, X } from 'lucide-react';

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
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div
          style={{
            padding: '12px 16px',
            borderBottom: '1px solid var(--bp-border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <strong>PDK Balancer Hard-IP Library</strong>
          <button className="btn btn-sm" onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        <div style={{ padding: 16, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label className="field-label">
              Paste Factorio Blueprint or Blueprint Book String (e.g. FactorioBin KafN8H7L — 1.1 &amp; 2.0 supported)
            </label>
            <textarea
              className="input mono"
              rows={4}
              placeholder="0eNq..."
              value={bpInput}
              onChange={(e) => setBpInput(e.target.value)}
            />
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn btn-primary btn-sm" onClick={handleImport} disabled={!bpInput.trim()}>
                <Upload size={13} /> Import to PDK
              </button>
              {customBalancers.length > 0 && (
                <button className="btn btn-sm" onClick={onClearCustom}>
                  <Trash2 size={13} /> Clear Custom ({customBalancers.length})
                </button>
              )}
            </div>
            {status && (
              <div style={{ marginTop: 6, color: 'var(--bp-green)', fontSize: 12 }}>{status}</div>
            )}
            {error && (
              <div style={{ marginTop: 6, color: 'var(--bp-red)', fontSize: 12 }}>{error}</div>
            )}
          </div>

          {customBalancers.length > 0 && (
            <div>
              <div className="section-title">Imported Custom Balancers ({customBalancers.length})</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(175px, 1fr))', gap: 6 }}>
                {customBalancers.map((b) => (
                  <div key={b.id} className="kpi-card">
                    <div style={{ fontWeight: 700, fontSize: 12 }}>{b.name}</div>
                    <div className="mono" style={{ fontSize: 11, color: 'var(--bp-cyan)' }}>
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
                  <div className="mono" style={{ fontSize: 11, color: 'var(--bp-text-muted)' }}>
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
