import React, { useEffect, useState } from 'react';
import { DesignSpec, parseSpecYaml, serializeSpecYaml } from '@factorio-eda/core';
import { AlertTriangle, Check, Download, Upload } from 'lucide-react';

interface YamlEditorProps {
  spec: DesignSpec;
  onApplySpec: (nextSpec: DesignSpec) => void;
}

export const YamlEditor: React.FC<YamlEditorProps> = ({ spec, onApplySpec }) => {
  const [text, setText] = useState(() => serializeSpecYaml(spec));
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setText(serializeSpecYaml(spec));
    setError(null);
    setDirty(false);
  }, [spec]);

  const handleApply = () => {
    try {
      const parsed = parseSpecYaml(text);
      setError(null);
      setDirty(false);
      onApplySpec(parsed);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDownload = () => {
    const blob = new Blob([text], { type: 'text/yaml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${spec.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'design'}.yaml`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const content = String(reader.result ?? '');
      setText(content);
      try {
        const parsed = parseSpecYaml(content);
        setError(null);
        setDirty(false);
        onApplySpec(parsed);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setDirty(true);
      }
    };
    reader.readAsText(file);
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div className="view-toolbar">
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <button
            type="button"
            className={`btn btn-primary btn-sm ${dirty ? 'btn-dirty' : ''}`}
            onClick={handleApply}
          >
            <Check size={13} /> Apply &amp; Run
          </button>
          <button type="button" className="btn btn-sm" onClick={handleDownload}>
            <Download size={13} /> Download .yaml
          </button>
          <label className="btn btn-sm" style={{ cursor: 'pointer' }}>
            <Upload size={13} /> Upload .yaml
            <input
              type="file"
              accept=".yaml,.yml,.json"
              style={{ display: 'none' }}
              onChange={handleUpload}
            />
          </label>
          {dirty && <span className="pill pill-warn">Modified</span>}
        </div>
        <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
          Compatible with <code className="mono">feda build spec.yaml</code> CLI
        </span>
      </div>

      {error && (
        <div className="error-banner mono" role="alert">
          <AlertTriangle size={14} style={{ flexShrink: 0 }} />
          <span>YAML Error: {error}</span>
        </div>
      )}

      <textarea
        className="yaml-textarea"
        aria-label="Design specification YAML"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setDirty(true);
        }}
        spellCheck={false}
      />
    </div>
  );
};
