import React, { useEffect, useMemo, useRef, useState } from 'react';
import { RecipeDef, getItemMeta } from '@factorio-eda/core';
import { ChevronDown, Search } from 'lucide-react';
import { ItemIcon } from './ItemIcon';

interface ItemPickerProps {
  value: string;
  options: RecipeDef[];
  onChange: (itemId: string) => void;
}

export const ItemPicker: React.FC<ItemPickerProps> = ({ value, options, onChange }) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const selectedMeta = useMemo(() => getItemMeta(value), [value]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.outputItem.toLowerCase().includes(q),
    );
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    const curIdx = options.findIndex((o) => o.outputItem === value);
    setActiveIdx(curIdx >= 0 ? curIdx : 0);
    const id = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open, options, value]);

  useEffect(() => {
    setActiveIdx(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', onMouseDown);
    return () => window.removeEventListener('mousedown', onMouseDown);
  }, [open]);

  useEffect(() => {
    if (!open || !listRef.current) return;
    const activeEl = listRef.current.children[activeIdx] as HTMLElement | undefined;
    activeEl?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIdx]);

  const commit = (itemId: string) => {
    onChange(itemId);
    setOpen(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((idx) => Math.min(Math.max(0, filtered.length - 1), idx + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((idx) => Math.max(0, idx - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = filtered[activeIdx];
      if (target) commit(target.outputItem);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div ref={rootRef} className="item-picker">
      <button
        type="button"
        className="select item-picker-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="row" style={{ minWidth: 0, flex: 1 }}>
          <ItemIcon itemId={value} size={18} />
          <span className="item-picker-value">{selectedMeta.name}</span>
        </span>
        <ChevronDown size={13} style={{ flexShrink: 0, color: 'var(--bp-text-muted)' }} />
      </button>

      {open && (
        <div className="item-picker-menu" role="listbox">
          <div className="item-picker-search-wrap">
            <Search size={12} style={{ color: 'var(--bp-text-muted)', flexShrink: 0 }} />
            <input
              ref={searchRef}
              type="text"
              className="item-picker-search"
              placeholder="Search items…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
            />
          </div>

          <div ref={listRef} className="item-picker-list">
            {filtered.length === 0 ? (
              <div className="item-picker-empty">No matching items</div>
            ) : (
              filtered.map((r, idx) => {
                const isSelected = r.outputItem === value;
                const isActive = idx === activeIdx;
                return (
                  <button
                    key={r.id}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    className={`item-picker-option ${isSelected ? 'selected' : ''} ${
                      isActive ? 'active' : ''
                    }`}
                    onMouseEnter={() => setActiveIdx(idx)}
                    onClick={() => commit(r.outputItem)}
                  >
                    <ItemIcon itemId={r.outputItem} size={18} />
                    <span className="item-picker-option-text">
                      <span className="item-picker-option-name">{r.name}</span>
                      <span className="item-picker-option-id">{r.outputItem}</span>
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
};
