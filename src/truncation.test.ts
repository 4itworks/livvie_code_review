import { describe, it, expect } from 'vitest';

import { extractChangedLines, truncateToWindow, progressiveTruncate } from './truncation.js';

// ---------------------------------------------------------------------------
// extractChangedLines
// ---------------------------------------------------------------------------
describe('extractChangedLines', () => {
  it('simple patch with one hunk → correct line numbers', () => {
    const patch = [
      '@@ -10,5 +10,7 @@',
      ' context',
      '+added line 1',
      '+added line 2',
      ' context',
      ' context',
    ].join('\n');

    const lines = extractChangedLines(patch);

    // Hunk starts at line 10 in the new file.
    // context line at 10 → advance to 11
    // +added line 1 at 11 → add, advance to 12
    // +added line 2 at 12 → add, advance to 13
    // context at 13 → advance to 14
    // context at 14 → advance to 15
    expect(lines.has(11)).toBe(true);
    expect(lines.has(12)).toBe(true);
    expect(lines.size).toBe(2);
  });

  it('multi-hunk patch → all changed lines', () => {
    const patch = [
      '@@ -10,5 +10,7 @@',
      ' context',
      '+added line 1',
      '+added line 2',
      ' context',
      ' context',
      '@@ -20,3 +22,5 @@',
      ' context',
      '+added line 3',
      ' context',
    ].join('\n');

    const lines = extractChangedLines(patch);

    // Hunk 1: starts at 10
    //   context at 10 → advance to 11
    //   + at 11 → add, advance to 12
    //   + at 12 → add, advance to 13
    //   context at 13 → advance to 14
    //   context at 14 → advance to 15
    // Hunk 2: starts at 22
    //   context at 22 → advance to 23
    //   + at 23 → add, advance to 24
    //   context at 24 → advance to 25
    expect(lines.has(11)).toBe(true);
    expect(lines.has(12)).toBe(true);
    expect(lines.has(23)).toBe(true);
    expect(lines.size).toBe(3);
  });

  it('empty patch → empty set', () => {
    const lines = extractChangedLines('');
    expect(lines.size).toBe(0);
  });

  it('patch with only removals → empty set', () => {
    const patch = [
      '@@ -10,5 +10,3 @@',
      ' context',
      '-removed line 1',
      '-removed line 2',
      ' context',
      ' context',
    ].join('\n');

    const lines = extractChangedLines(patch);
    expect(lines.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// truncateToWindow
// ---------------------------------------------------------------------------
describe('truncateToWindow', () => {
  // Helper: build numbered content for 200 lines
  const makeNumberedContent = (lineCount: number) =>
    Array.from({ length: lineCount }, (_, i) => `${i + 1}:line ${i + 1}`).join('\n');

  it('content that fits → not truncated', () => {
    const content = makeNumberedContent(10);
    const patch = '@@ -5,3 +5,3 @@\n context\n+added\n context';
    const result = truncateToWindow(content, patch, 1000);
    expect(result.truncated).toBe(false);
    expect(result.content).toBe(content);
  });

  it('large content with hunk in middle → truncated to window around hunk', () => {
    const content = makeNumberedContent(200);
    const patch = '@@ -100,3 +100,3 @@\n context\n+added\n context';
    const result = truncateToWindow(content, patch, 5);
    expect(result.truncated).toBe(true);
    // Should contain the lines around the hunk (around line 100)
    expect(result.content).toContain('100:line 100');
    // Should have truncation markers
    expect(result.content).toContain('truncated');
    // Should not contain line 1 (too far from hunk)
    expect(result.content).not.toMatch(/^1:line 1$/m);
  });

  it('empty content → not truncated', () => {
    const result = truncateToWindow('', '@@ -1,3 +1,3 @@\n+added', 100);
    expect(result.truncated).toBe(false);
    expect(result.content).toBe('');
  });

  it('empty patch → not truncated', () => {
    const content = '1:hello';
    const result = truncateToWindow(content, '', 100);
    expect(result.truncated).toBe(false);
    expect(result.content).toBe(content);
  });
});

// ---------------------------------------------------------------------------
// progressiveTruncate
// ---------------------------------------------------------------------------
describe('progressiveTruncate', () => {
  const makeNumberedContent = (lineCount: number) =>
    Array.from({ length: lineCount }, (_, i) => `${i + 1}:line ${i + 1}`).join('\n');

  it('content within token budget → strategy="full", not truncated', () => {
    const content = makeNumberedContent(5);
    const patch = '@@ -2,3 +2,3 @@\n+added';
    const result = progressiveTruncate(content, patch, 100000);
    expect(result.strategy).toBe('full');
    expect(result.truncated).toBe(false);
  });

  it('content exceeds budget → strategy is window-10, window-5, or diff-only', () => {
    const content = makeNumberedContent(500);
    const patch = '@@ -250,3 +250,3 @@\n context\n+added line\n context';
    // Very tight budget to force truncation
    const result = progressiveTruncate(content, patch, 20);
    expect(result.truncated).toBe(true);
    expect(['window-10', 'window-5', 'diff-only']).toContain(result.strategy);
  });
});