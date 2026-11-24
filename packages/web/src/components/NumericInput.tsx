import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import {
  clampAndRound,
  formatNumericDisplay,
  isNumericInRange,
  parseNumericDraft,
  resolveNumericCommit,
  stepNumericValue,
} from './numericInputUtils';

export interface NumericInputProps {
  /** Committed numeric value displayed when not focused and used as fallback on revert. */
  value: number;
  /** Called on blur or Enter when a valid/committable numeric change is finalized. */
  onCommit: (value: number) => void;
  /**
   * Optional callback fired while typing or arrow-stepping ONLY when the draft
   * represents a valid finite number within [min, max], without mutating the draft text.
   */
  onValidChange?: (value: number) => void;
  /** Optional callback fired on Enter with the committed, clamped, rounded value. */
  onEnterCommit?: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Decimal precision applied on commit/formatting and live valid values (ignored when integer=true). */
  precision?: number;
  /** When true, switches inputMode to "numeric" and enforces integer rounding. */
  integer?: boolean;
  /** Optional compact inline unit suffix (e.g. "/min", "/s", "belts", "tiles"). */
  suffix?: string;
  /** Optional compact +/- stepper buttons (supports Shift+Click for 10x stepping). */
  showSteppers?: boolean;
  /** Multiplier applied when Shift is held on ArrowUp/ArrowDown or stepper click (default 10). */
  shiftMultiplier?: number;
  /** When true, ArrowUp/ArrowDown commit immediately in addition to updating draft (default false). */
  commitOnStep?: boolean;
  id?: string;
  name?: string;
  className?: string;
  inputClassName?: string;
  style?: React.CSSProperties;
  placeholder?: string;
  disabled?: boolean;
  readOnly?: boolean;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  title?: string;
  'data-testid'?: string;
}

export const NumericInput: React.FC<NumericInputProps> = ({
  value,
  onCommit,
  onValidChange,
  onEnterCommit,
  min,
  max,
  step = 1,
  precision,
  integer = false,
  suffix,
  showSteppers = false,
  shiftMultiplier = 10,
  commitOnStep = false,
  id,
  name,
  className,
  inputClassName,
  style,
  placeholder,
  disabled = false,
  readOnly = false,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  'aria-describedby': ariaDescribedBy,
  title,
  'data-testid': dataTestId,
}) => {
  const [isFocused, setIsFocused] = useState(false);
  const [draft, setDraft] = useState<string>(() =>
    formatNumericDisplay(value, { integer, precision }),
  );

  const isFocusedRef = useRef(false);
  const valueOnFocusRef = useRef<number>(value);

  // Sync local draft from prop `value` ONLY when not focused so typing is never clobbered.
  useEffect(() => {
    if (!isFocusedRef.current) {
      setDraft(formatNumericDisplay(value, { integer, precision }));
      valueOnFocusRef.current = value;
    }
  }, [value, integer, precision]);

  const draftState = useMemo(() => {
    const parsed = parseNumericDraft(draft, { integer });
    if (parsed.status === 'invalid') return 'invalid' as const;
    if (
      parsed.status === 'valid' &&
      parsed.value !== null &&
      !isNumericInRange(parsed.value, min, max)
    ) {
      return 'out-of-range' as const;
    }
    if (parsed.status === 'empty') return 'empty' as const;
    if (parsed.status === 'incomplete') return 'incomplete' as const;
    return 'valid' as const;
  }, [draft, integer, min, max]);

  const commitDraft = (trigger: 'blur' | 'enter') => {
    const resolved = resolveNumericCommit(draft, value, {
      min,
      max,
      precision,
      integer,
    });
    const formatted = formatNumericDisplay(resolved.value, { integer, precision });
    setDraft(formatted);

    const changedFromFocus = !Object.is(resolved.value, valueOnFocusRef.current);
    const changedFromProp = !Object.is(resolved.value, value);

    if (resolved.committed && (changedFromFocus || changedFromProp)) {
      onCommit(resolved.value);
    }
    if (trigger === 'enter') {
      onEnterCommit?.(resolved.value);
    }

    valueOnFocusRef.current = resolved.value;
  };

  const applyStep = (
    direction: 1 | -1,
    shiftKey: boolean,
    shouldCommit: boolean,
  ) => {
    if (disabled || readOnly) return;

    const parsed = parseNumericDraft(draft, { integer });
    let base: number;
    if (parsed.status === 'valid' && parsed.value !== null) {
      base = parsed.value;
    } else if (parsed.status === 'incomplete' && parsed.commitValue !== null) {
      base = parsed.commitValue;
    } else {
      base = Number.isFinite(value) ? value : clampAndRound(0, { min, max, precision, integer });
    }

    const nextVal = stepNumericValue(base, direction, {
      step,
      shiftKey,
      shiftMultiplier,
      min,
      max,
      precision,
      integer,
      fallback: value,
    });

    setDraft(formatNumericDisplay(nextVal, { integer, precision }));

    if (shouldCommit) {
      if (
        !Object.is(nextVal, value) ||
        !Object.is(nextVal, valueOnFocusRef.current)
      ) {
        onCommit(nextVal);
      }
      valueOnFocusRef.current = nextVal;
    } else if (!Object.is(nextVal, value)) {
      onValidChange?.(nextVal);
    }
  };

  const handleFocus = () => {
    isFocusedRef.current = true;
    setIsFocused(true);
    valueOnFocusRef.current = value;
  };

  const handleBlur = () => {
    isFocusedRef.current = false;
    setIsFocused(false);
    if (!readOnly) {
      commitDraft('blur');
    } else {
      setDraft(formatNumericDisplay(value, { integer, precision }));
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (disabled || readOnly) return;
    const raw = e.target.value;
    setDraft(raw);

    if (!onValidChange) return;
    const parsed = parseNumericDraft(raw, { integer });
    if (
      parsed.status === 'valid' &&
      parsed.value !== null &&
      isNumericInRange(parsed.value, min, max)
    ) {
      const normalized = clampAndRound(parsed.value, {
        min,
        max,
        precision,
        integer,
      });
      onValidChange(normalized);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (disabled || readOnly) return;

    if (e.key === 'Enter') {
      e.preventDefault();
      commitDraft('enter');
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      const revertVal = clampAndRound(valueOnFocusRef.current, {
        min,
        max,
        precision,
        integer,
        fallback: value,
      });
      setDraft(formatNumericDisplay(revertVal, { integer, precision }));
      if (!Object.is(revertVal, value)) {
        onValidChange?.(revertVal);
      }
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      applyStep(1, e.shiftKey, commitOnStep);
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      applyStep(-1, e.shiftKey, commitOnStep);
    }
  };

  const rootClasses = [
    'numeric-input',
    isFocused ? 'is-focused' : '',
    disabled ? 'is-disabled' : '',
    suffix ? 'has-suffix' : '',
    showSteppers ? 'has-steppers' : '',
    draftState === 'invalid' ? 'is-invalid' : '',
    draftState === 'out-of-range' ? 'is-out-of-range' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  const fieldClasses = ['numeric-input-field', 'mono', inputClassName ?? '']
    .filter(Boolean)
    .join(' ');

  const stepLabelBase = ariaLabel ?? 'value';

  return (
    <div
      className={rootClasses}
      style={style}
      title={title}
      data-focused={isFocused ? 'true' : undefined}
      data-disabled={disabled ? 'true' : undefined}
      data-state={draftState}
    >
      <input
        id={id}
        name={name}
        type="text"
        inputMode={integer ? 'numeric' : 'decimal'}
        autoComplete="off"
        spellCheck={false}
        className={fieldClasses}
        value={draft}
        placeholder={placeholder}
        disabled={disabled}
        readOnly={readOnly}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-describedby={ariaDescribedBy}
        aria-invalid={
          draftState === 'invalid' || draftState === 'out-of-range'
            ? true
            : undefined
        }
        data-testid={dataTestId}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
      />

      {suffix && (
        <span className="numeric-input-suffix" aria-hidden="true">
          {suffix}
        </span>
      )}

      {showSteppers && (
        <div className="numeric-input-steppers">
          <button
            type="button"
            tabIndex={-1}
            className="numeric-input-step-btn numeric-input-step-up"
            aria-label={`Increase ${stepLabelBase}`}
            title={`Increase (+${step}; Shift for +${step * shiftMultiplier})`}
            disabled={disabled || readOnly}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => applyStep(1, e.shiftKey, true)}
          >
            <ChevronUp size={10} strokeWidth={2.4} />
          </button>
          <button
            type="button"
            tabIndex={-1}
            className="numeric-input-step-btn numeric-input-step-down"
            aria-label={`Decrease ${stepLabelBase}`}
            title={`Decrease (-${step}; Shift for -${step * shiftMultiplier})`}
            disabled={disabled || readOnly}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => applyStep(-1, e.shiftKey, true)}
          >
            <ChevronDown size={10} strokeWidth={2.4} />
          </button>
        </div>
      )}
    </div>
  );
};
