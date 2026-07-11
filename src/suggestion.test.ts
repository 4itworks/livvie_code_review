import { describe, it, expect } from 'vitest';
vi.mock('@actions/core', () => ({
  info: vi.fn(),
  warning: vi.fn(),
  debug: vi.fn(),
  startGroup: vi.fn(),
  endGroup: vi.fn(),
}));

import { isSuggestionBalanced, validateSuggestion } from './suggestion.js';
import type { ReviewFinding } from './types.js';

describe('isSuggestionBalanced', () => {
  it('simple balanced code', () => {
    expect(isSuggestionBalanced('if (x) { return 1; }')).toBe(true);
  });

  it('nested balanced code', () => {
    expect(isSuggestionBalanced('function f() { if (x) { arr[0] = {a: 1}; } }')).toBe(true);
  });

  it('unbalanced missing closing brace', () => {
    expect(isSuggestionBalanced('if (x) {')).toBe(false);
  });

  it('unbalanced wrong closer', () => {
    expect(isSuggestionBalanced('if (x) { ]')).toBe(false);
  });

  it('empty string is balanced', () => {
    expect(isSuggestionBalanced('')).toBe(true);
  });

  it('brackets inside single-quoted string do not count', () => {
    expect(isSuggestionBalanced("'({['")).toBe(true);
  });

  it('brackets inside double-quoted string do not count', () => {
    expect(isSuggestionBalanced('"({["')).toBe(true);
  });

  it('single-line comment brackets do not count', () => {
    expect(isSuggestionBalanced('// {')).toBe(true);
  });

  it('multi-line comment brackets do not count', () => {
    expect(isSuggestionBalanced('/* { */')).toBe(true);
  });

  it('triple-quoted strings (Dart) brackets do not count', () => {
    expect(isSuggestionBalanced("'''{'''")).toBe(true);
  });

  it('escaped quotes inside string', () => {
    expect(isSuggestionBalanced("'\\''")).toBe(true);
  });

  it('mixed balanced with strings containing brackets', () => {
    expect(isSuggestionBalanced("fn(() { return '['; })")).toBe(true);
  });

  it('real Dart code balanced', () => {
    expect(isSuggestionBalanced('Widget build(BuildContext context) { return Container(); }')).toBe(true);
  });

  it('unbalanced Dart code', () => {
    expect(isSuggestionBalanced('Widget build(BuildContext context) { return Container(')).toBe(false);
  });

  it('only closers without openers is unbalanced', () => {
    expect(isSuggestionBalanced('}')).toBe(false);
  });

  it('multiple same-type openers without closers', () => {
    expect(isSuggestionBalanced('(((')).toBe(false);
  });

  it('mismatched types is unbalanced', () => {
    expect(isSuggestionBalanced('(]')).toBe(false);
  });

  it('properly nested different types', () => {
    expect(isSuggestionBalanced('([{a: (b + c)}])')).toBe(true);
  });
});

describe('validateSuggestion', () => {
  function makeFinding(overrides: Partial<ReviewFinding>): ReviewFinding {
    return {
      severity: 'medium',
      confidence: 'high',
      file: 'lib/main.dart',
      line: 10,
      description: 'Some issue found',
      suggestion: null,
      suggestionStartLine: null,
      perspective: 'security',
      foundBy: ['security'],
      ...overrides,
    };
  }

  it('balanced suggestion is returned as-is', () => {
    const finding = makeFinding({
      suggestion: 'Widget build(BuildContext context) { return Container(); }',
      suggestionStartLine: 5,
    });
    const result = validateSuggestion(finding);
    expect(result.suggestion).toBe(finding.suggestion);
    expect(result.suggestionStartLine).toBe(5);
  });

  it('unbalanced suggestion gets suggestion set to null', () => {
    const finding = makeFinding({
      suggestion: 'if (x) { return 1;',
      suggestionStartLine: 3,
    });
    const result = validateSuggestion(finding);
    expect(result.suggestion).toBeNull();
    expect(result.suggestionStartLine).toBeNull();
  });

  it('null suggestion is returned as-is', () => {
    const finding = makeFinding({
      suggestion: null,
      suggestionStartLine: null,
    });
    const result = validateSuggestion(finding);
    expect(result.suggestion).toBeNull();
    expect(result.suggestionStartLine).toBeNull();
  });

  it('does not mutate the original finding', () => {
    const finding = makeFinding({
      suggestion: 'if (x) {',
      suggestionStartLine: 2,
    });
    const result = validateSuggestion(finding);
    // Original should be untouched
    expect(finding.suggestion).toBe('if (x) {');
    expect(finding.suggestionStartLine).toBe(2);
    // Result should be stripped
    expect(result.suggestion).toBeNull();
    expect(result.suggestionStartLine).toBeNull();
  });
});
