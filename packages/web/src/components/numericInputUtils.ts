export type NumericDraftStatus = 'empty' | 'incomplete' | 'valid' | 'invalid';

export interface ParsedNumericDraft {
  status: NumericDraftStatus;
  /** Finite parsed value when status === 'valid'; otherwise null. */
  value: number | null;
  /**
   * Finite candidate value usable on commit for trailing-decimal drafts like "1.";
   * null when the draft has no committable digits ("", ".", "-", "+", "-.", or invalid text).
   */
  commitValue: number | null;
}

export interface ParseNumericDraftOptions {
  integer?: boolean;
}

export interface ClampAndRoundOptions {
  min?: number;
  max?: number;
  precision?: number;
  integer?: boolean;
  fallback?: number;
}

export interface StepNumericOptions {
  step?: number;
  shiftKey?: boolean;
  shiftMultiplier?: number;
  min?: number;
  max?: number;
  precision?: number;
  integer?: boolean;
  fallback?: number;
}

export interface FormatNumericOptions {
  precision?: number;
  integer?: boolean;
  emptyFallback?: string;
}

export interface ResolvedNumericCommit {
  /** True when the draft carried a valid or trailing-dot numeric value. */
  committed: boolean;
  /** Clamped and rounded numeric result (or clamped/rounded fallback if not committed). */
  value: number;
}

const VALID_DECIMAL_RE = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;
const TRAILING_DOT_RE = /^[+-]?\d+\.$/;
const VALID_INTEGER_RE = /^[+-]?\d+$/;
const SIGN_ONLY_RE = /^[+-]$/;
const INCOMPLETE_DOT_RE = /^[+-]?\.$/;

function normalizeZero(n: number): number {
  return n === 0 ? 0 : n;
}

function normalizeBounds(
  min?: number,
  max?: number,
): { min: number | undefined; max: number | undefined } {
  let lo = min !== undefined && Number.isFinite(min) ? min : undefined;
  let hi = max !== undefined && Number.isFinite(max) ? max : undefined;
  if (lo !== undefined && hi !== undefined && lo > hi) {
    [lo, hi] = [hi, lo];
  }
  return { min: lo, max: hi };
}

function clampToBounds(
  value: number,
  min: number | undefined,
  max: number | undefined,
): number {
  let result = value;
  if (min !== undefined && result < min) result = min;
  if (max !== undefined && result > max) result = max;
  return normalizeZero(result);
}

function roundToPrecision(value: number, precision: number): number {
  const p = Math.max(0, Math.min(12, Math.trunc(precision)));
  if (p === 0) {
    const rounded = Math.sign(value) * Math.round(Math.abs(value));
    return normalizeZero(rounded);
  }

  const sign = value < 0 ? -1 : 1;
  const abs = Math.abs(value);
  const str = abs.toString();
  if (!str.includes('e') && !str.includes('E')) {
    const shifted = Number(`${str}e${p}`);
    if (Number.isFinite(shifted)) {
      const rounded = Number(`${Math.round(shifted)}e-${p}`);
      return normalizeZero(sign * rounded);
    }
  }
  const factor = 10 ** p;
  return normalizeZero((sign * Math.round(abs * factor)) / factor);
}

function countDecimals(n: number): number {
  if (!Number.isFinite(n) || Number.isInteger(n)) return 0;
  const s = n.toString();
  const expIdx = s.indexOf('e-');
  if (expIdx !== -1) {
    const exp = Number(s.slice(expIdx + 2));
    const mantissa = s.slice(0, expIdx);
    const dotIdx = mantissa.indexOf('.');
    const mantissaDec = dotIdx === -1 ? 0 : mantissa.length - dotIdx - 1;
    return Math.min(12, exp + mantissaDec);
  }
  const dotIdx = s.indexOf('.');
  return dotIdx === -1 ? 0 : Math.min(12, s.length - dotIdx - 1);
}

/**
 * Classifies a raw user-entered string draft without mutating or clamping it,
 * distinguishing empty drafts, intermediate typing prefixes ("-", ".", "1."),
 * valid finite numbers, and invalid text.
 */
export function parseNumericDraft(
  raw: string,
  options?: ParseNumericDraftOptions,
): ParsedNumericDraft {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return { status: 'empty', value: null, commitValue: null };
  }

  const integer = options?.integer ?? false;
  if (SIGN_ONLY_RE.test(trimmed)) {
    return { status: 'incomplete', value: null, commitValue: null };
  }

  if (integer) {
    if (VALID_INTEGER_RE.test(trimmed)) {
      const num = Number(trimmed);
      if (Number.isFinite(num)) {
        const clean = normalizeZero(num);
        return { status: 'valid', value: clean, commitValue: clean };
      }
    }
    return { status: 'invalid', value: null, commitValue: null };
  }

  if (INCOMPLETE_DOT_RE.test(trimmed)) {
    return { status: 'incomplete', value: null, commitValue: null };
  }

  if (TRAILING_DOT_RE.test(trimmed)) {
    const num = Number(trimmed);
    if (Number.isFinite(num)) {
      return { status: 'incomplete', value: null, commitValue: normalizeZero(num) };
    }
    return { status: 'invalid', value: null, commitValue: null };
  }

  if (VALID_DECIMAL_RE.test(trimmed)) {
    const num = Number(trimmed);
    if (Number.isFinite(num)) {
      const clean = normalizeZero(num);
      return { status: 'valid', value: clean, commitValue: clean };
    }
  }

  return { status: 'invalid', value: null, commitValue: null };
}

/**
 * Returns true if value is finite and within optional inclusive [min, max] bounds.
 */
export function isNumericInRange(value: number, min?: number, max?: number): boolean {
  if (!Number.isFinite(value)) return false;
  const bounds = normalizeBounds(min, max);
  if (bounds.min !== undefined && value < bounds.min) return false;
  if (bounds.max !== undefined && value > bounds.max) return false;
  return true;
}

/**
 * Clamps a numeric value to [min, max] and rounds to integer or fixed decimal precision.
 * Non-finite inputs fall back to options.fallback (or 0 clamped to [min, max]).
 */
export function clampAndRound(
  value: number,
  options?: ClampAndRoundOptions,
): number {
  const bounds = normalizeBounds(options?.min, options?.max);
  let num = value;

  if (!Number.isFinite(num)) {
    if (options?.fallback !== undefined && Number.isFinite(options.fallback)) {
      num = options.fallback;
    } else {
      num = clampToBounds(0, bounds.min, bounds.max);
    }
  }

  num = clampToBounds(num, bounds.min, bounds.max);

  if (options?.integer) {
    num = roundToPrecision(num, 0);
  } else if (
    options?.precision !== undefined &&
    Number.isFinite(options.precision)
  ) {
    num = roundToPrecision(num, options.precision);
  }

  return clampToBounds(num, bounds.min, bounds.max);
}

/**
 * Steps a numeric value up (+1) or down (-1) by step (10x when shiftKey is held),
 * suppressing IEEE-754 drift and clamping/rounding to configured constraints.
 */
export function stepNumericValue(
  current: number,
  direction: 1 | -1,
  options?: StepNumericOptions,
): number {
  const bounds = normalizeBounds(options?.min, options?.max);
  const base = Number.isFinite(current)
    ? current
    : options?.fallback !== undefined && Number.isFinite(options.fallback)
      ? options.fallback
      : clampToBounds(0, bounds.min, bounds.max);

  const baseStep =
    options?.step !== undefined &&
    Number.isFinite(options.step) &&
    options.step > 0
      ? options.step
      : 1;

  const mult = options?.shiftKey
    ? options.shiftMultiplier !== undefined &&
      Number.isFinite(options.shiftMultiplier) &&
      options.shiftMultiplier > 0
      ? options.shiftMultiplier
      : 10
    : 1;

  const rawNext = base + direction * baseStep * mult;

  const precision =
    options?.integer
      ? 0
      : options?.precision !== undefined && Number.isFinite(options.precision)
        ? options.precision
        : Math.max(countDecimals(base), countDecimals(baseStep));

  return clampAndRound(rawNext, {
    min: bounds.min,
    max: bounds.max,
    precision,
    integer: options?.integer,
    fallback: options?.fallback,
  });
}

/**
 * Formats a finite number cleanly for display without trailing zeroes or IEEE-754 noise.
 */
export function formatNumericDisplay(
  value: number,
  options?: FormatNumericOptions,
): string {
  if (!Number.isFinite(value)) {
    return options?.emptyFallback ?? '';
  }
  if (options?.integer) {
    return String(roundToPrecision(value, 0));
  }
  if (
    options?.precision !== undefined &&
    Number.isFinite(options.precision)
  ) {
    return String(roundToPrecision(value, options.precision));
  }
  if (Number.isInteger(value)) {
    return String(normalizeZero(value));
  }
  const cleaned = Number(value.toPrecision(12));
  return String(normalizeZero(cleaned));
}

/**
 * Resolves a draft string on blur or Enter into a committed clamped/rounded number,
 * falling back to fallbackValue when the draft is empty or has no committable digits.
 */
export function resolveNumericCommit(
  draft: string,
  fallbackValue: number,
  options?: ClampAndRoundOptions,
): ResolvedNumericCommit {
  const parsed = parseNumericDraft(draft, { integer: options?.integer });
  if (parsed.status === 'valid' && parsed.value !== null) {
    return {
      committed: true,
      value: clampAndRound(parsed.value, options),
    };
  }
  if (parsed.status === 'incomplete' && parsed.commitValue !== null) {
    return {
      committed: true,
      value: clampAndRound(parsed.commitValue, options),
    };
  }
  return {
    committed: false,
    value: clampAndRound(fallbackValue, { ...options, fallback: 0 }),
  };
}
