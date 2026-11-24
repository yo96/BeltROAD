import { describe, expect, it } from 'vitest';
import {
  clampAndRound,
  formatNumericDisplay,
  isNumericInRange,
  parseNumericDraft,
  resolveNumericCommit,
  stepNumericValue,
} from '../src/components/numericInputUtils';

describe('parseNumericDraft', () => {
  it('classifies empty and whitespace-only drafts as empty', () => {
    expect(parseNumericDraft('')).toEqual({
      status: 'empty',
      value: null,
      commitValue: null,
    });
    expect(parseNumericDraft('   \t ')).toEqual({
      status: 'empty',
      value: null,
      commitValue: null,
    });
  });

  it('classifies intermediate decimal prefixes as incomplete without mutating or failing', () => {
    expect(parseNumericDraft('-')).toEqual({
      status: 'incomplete',
      value: null,
      commitValue: null,
    });
    expect(parseNumericDraft('+')).toEqual({
      status: 'incomplete',
      value: null,
      commitValue: null,
    });
    expect(parseNumericDraft('.')).toEqual({
      status: 'incomplete',
      value: null,
      commitValue: null,
    });
    expect(parseNumericDraft('-.')).toEqual({
      status: 'incomplete',
      value: null,
      commitValue: null,
    });
    expect(parseNumericDraft('+.')).toEqual({
      status: 'incomplete',
      value: null,
      commitValue: null,
    });
  });

  it('treats trailing-decimal drafts like "1." as incomplete with commitValue', () => {
    expect(parseNumericDraft('1.')).toEqual({
      status: 'incomplete',
      value: null,
      commitValue: 1,
    });
    expect(parseNumericDraft('0.')).toEqual({
      status: 'incomplete',
      value: null,
      commitValue: 0,
    });
    expect(parseNumericDraft('-12.')).toEqual({
      status: 'incomplete',
      value: null,
      commitValue: -12,
    });
    expect(parseNumericDraft('+3.')).toEqual({
      status: 'incomplete',
      value: null,
      commitValue: 3,
    });
  });

  it('parses valid decimals and normalizes -0 to 0', () => {
    expect(parseNumericDraft('20')).toEqual({
      status: 'valid',
      value: 20,
      commitValue: 20,
    });
    expect(parseNumericDraft('1.45')).toEqual({
      status: 'valid',
      value: 1.45,
      commitValue: 1.45,
    });
    expect(parseNumericDraft('.5')).toEqual({
      status: 'valid',
      value: 0.5,
      commitValue: 0.5,
    });
    expect(parseNumericDraft('-.25')).toEqual({
      status: 'valid',
      value: -0.25,
      commitValue: -0.25,
    });
    expect(parseNumericDraft('  42.5  ')).toEqual({
      status: 'valid',
      value: 42.5,
      commitValue: 42.5,
    });

    const negZero = parseNumericDraft('-0');
    expect(negZero.status).toBe('valid');
    expect(Object.is(negZero.value, 0)).toBe(true);
  });

  it('enforces strict integer mode while still permitting sign prefixes', () => {
    expect(parseNumericDraft('', { integer: true }).status).toBe('empty');
    expect(parseNumericDraft('-', { integer: true })).toEqual({
      status: 'incomplete',
      value: null,
      commitValue: null,
    });
    expect(parseNumericDraft('16', { integer: true })).toEqual({
      status: 'valid',
      value: 16,
      commitValue: 16,
    });
    expect(parseNumericDraft('-5', { integer: true })).toEqual({
      status: 'valid',
      value: -5,
      commitValue: -5,
    });
    expect(parseNumericDraft('.', { integer: true }).status).toBe('invalid');
    expect(parseNumericDraft('1.', { integer: true }).status).toBe('invalid');
    expect(parseNumericDraft('1.5', { integer: true }).status).toBe('invalid');
  });

  it('rejects non-numeric, multi-dot, scientific, and overflowing drafts as invalid', () => {
    for (const bad of [
      'abc',
      '12px',
      '1..2',
      '1.2.3',
      '--1',
      '1e5',
      'Infinity',
      'NaN',
      '1 2',
      '9'.repeat(400),
    ]) {
      expect(parseNumericDraft(bad)).toEqual({
        status: 'invalid',
        value: null,
        commitValue: null,
      });
    }
  });
});

describe('clampAndRound', () => {
  it('clamps to [min, max], single-sided bounds, and reversed bounds', () => {
    expect(clampAndRound(0.1, { min: 0.2, max: 5.0, precision: 2 })).toBe(0.2);
    expect(clampAndRound(9.9, { min: 0.2, max: 5.0, precision: 2 })).toBe(5);
    expect(clampAndRound(2.345, { min: 0.2, max: 5.0, precision: 2 })).toBe(2.35);
    expect(clampAndRound(5, { min: 16, integer: true })).toBe(16);
    expect(clampAndRound(100, { max: 80 })).toBe(80);
    expect(clampAndRound(-12, {})).toBe(-12);
    expect(clampAndRound(10, { min: 5, max: 2 })).toBe(5);
  });

  it('rounds boundary decimals cleanly without IEEE-754 drift or -0', () => {
    expect(clampAndRound(1.005, { precision: 2 })).toBe(1.01);
    expect(clampAndRound(2.675, { precision: 2 })).toBe(2.68);
    expect(clampAndRound(-1.005, { precision: 2 })).toBe(-1.01);
    const roundedZero = clampAndRound(-0.004, { precision: 2 });
    expect(Object.is(roundedZero, 0)).toBe(true);
  });

  it('rounds integers and preserves [min, max] invariant after rounding', () => {
    expect(clampAndRound(15.4, { min: 16, integer: true })).toBe(16);
    expect(clampAndRound(15.6, { min: 16, integer: true })).toBe(16);
    expect(clampAndRound(44.6, { integer: true })).toBe(45);
    expect(clampAndRound(0.25, { min: 0.24, max: 0.26, precision: 1 })).toBe(0.26);
  });

  it('handles non-finite values using fallback or clamped zero', () => {
    expect(clampAndRound(Number.NaN, { min: 0.2, max: 5, fallback: 1.35 })).toBe(1.35);
    expect(clampAndRound(Number.POSITIVE_INFINITY, { min: 16, integer: true })).toBe(16);
    expect(clampAndRound(Number.NEGATIVE_INFINITY, { max: -5 })).toBe(-5);
    expect(clampAndRound(Number.NaN)).toBe(0);
  });
});

describe('stepNumericValue', () => {
  it('steps cleanly by step and 10x with shiftKey', () => {
    expect(stepNumericValue(10, 1, { step: 15, min: 1 })).toBe(25);
    expect(stepNumericValue(10, 1, { step: 15, shiftKey: true, min: 1 })).toBe(160);
    expect(stepNumericValue(60, -1, { step: 1, shiftKey: true, min: 16, integer: true })).toBe(50);
    expect(stepNumericValue(10, 1, { step: 1, shiftKey: true, shiftMultiplier: 5 })).toBe(15);
  });

  it('eliminates IEEE-754 drift on decimal steps even without explicit precision', () => {
    expect(stepNumericValue(1.35, 1, { step: 0.1, min: 0.2, max: 5.0 })).toBe(1.45);
    expect(stepNumericValue(0.3, -1, { step: 0.1, min: 0.2, max: 5.0 })).toBe(0.2);
    expect(stepNumericValue(1.0, 1, { step: 0.07, shiftKey: true })).toBe(1.7);
    expect(stepNumericValue(0.5, 1, { step: 0.25, shiftKey: true })).toBe(3);
  });

  it('clamps steps at min and max boundaries', () => {
    expect(stepNumericValue(1, -1, { step: 15, min: 1 })).toBe(1);
    expect(stepNumericValue(4.8, 1, { step: 0.5, max: 5.0, precision: 2 })).toBe(5);
    expect(stepNumericValue(16, -1, { step: 1, min: 16, integer: true })).toBe(16);
  });

  it('uses fallback when current is non-finite', () => {
    expect(
      stepNumericValue(Number.NaN, 1, { step: 1, min: 16, integer: true, fallback: 60 }),
    ).toBe(61);
  });
});

describe('formatNumericDisplay', () => {
  it('formats numbers cleanly without trailing zeroes or float artifacts', () => {
    expect(formatNumericDisplay(60)).toBe('60');
    expect(formatNumericDisplay(60, { precision: 2 })).toBe('60');
    expect(formatNumericDisplay(1.5, { precision: 2 })).toBe('1.5');
    expect(formatNumericDisplay(1.4500000000000002)).toBe('1.45');
    expect(formatNumericDisplay(0.30000000000000004)).toBe('0.3');
    expect(formatNumericDisplay(15.6, { integer: true })).toBe('16');
    expect(formatNumericDisplay(-0)).toBe('0');
  });

  it('handles non-finite values safely', () => {
    expect(formatNumericDisplay(Number.NaN)).toBe('');
    expect(formatNumericDisplay(Number.POSITIVE_INFINITY, { emptyFallback: '0' })).toBe('0');
  });
});

describe('isNumericInRange and resolveNumericCommit', () => {
  it('checks inclusive range cleanly', () => {
    expect(isNumericInRange(0.2, 0.2, 5.0)).toBe(true);
    expect(isNumericInRange(5.0, 0.2, 5.0)).toBe(true);
    expect(isNumericInRange(0.19, 0.2, 5.0)).toBe(false);
    expect(isNumericInRange(8, 16, undefined)).toBe(false);
    expect(isNumericInRange(-10, undefined, undefined)).toBe(true);
    expect(isNumericInRange(Number.NaN, 0, 10)).toBe(false);
  });

  it('supports BeltROAD multi-step editing scenarios cleanly', () => {
    // Target rate: select all "10" -> "" -> "20" -> commit 20
    expect(parseNumericDraft('')).toEqual({ status: 'empty', value: null, commitValue: null });
    expect(resolveNumericCommit('', 10, { min: 0.5, precision: 2 })).toEqual({
      committed: false,
      value: 10,
    });
    expect(resolveNumericCommit('20', 10, { min: 0.5, precision: 2 })).toEqual({
      committed: true,
      value: 20,
    });

    // Aspect ratio: "1.35" -> "1." -> "1.45", and out-of-range "9" clamping to 5
    const dotStep = parseNumericDraft('1.');
    expect(dotStep.status).toBe('incomplete');
    expect(resolveNumericCommit('1.', 1.35, { min: 0.2, max: 5.0, precision: 2 })).toEqual({
      committed: true,
      value: 1,
    });
    expect(resolveNumericCommit('1.45', 1.35, { min: 0.2, max: 5.0, precision: 2 })).toEqual({
      committed: true,
      value: 1.45,
    });
    expect(resolveNumericCommit('9', 1.35, { min: 0.2, max: 5.0, precision: 2 })).toEqual({
      committed: true,
      value: 5,
    });
    expect(resolveNumericCommit('abc', 1.35, { min: 0.2, max: 5.0, precision: 2 })).toEqual({
      committed: false,
      value: 1.35,
    });

    // Fixed W x H: typing "8" stays uncommitted live (out of range), commits clamped 16 on blur; "80" commits 80
    expect(isNumericInRange(8, 16, undefined)).toBe(false);
    expect(resolveNumericCommit('8', 60, { min: 16, integer: true })).toEqual({
      committed: true,
      value: 16,
    });
    expect(resolveNumericCommit('80', 60, { min: 16, integer: true })).toEqual({
      committed: true,
      value: 80,
    });

    // Macro X/Y allows negative and zero integers; Pin Offset clamps >= 1
    expect(resolveNumericCommit('-5', 10, { integer: true })).toEqual({
      committed: true,
      value: -5,
    });
    expect(resolveNumericCommit('0', 4, { min: 1, integer: true })).toEqual({
      committed: true,
      value: 1,
    });
  });
});
