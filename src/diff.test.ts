import { describe, it, expect } from 'vitest';

import { isLineInDiff } from './diff.js';

// ---------------------------------------------------------------------------
// isLineInDiff
// ---------------------------------------------------------------------------
describe('isLineInDiff', () => {
  const patch = [
    '@@ -10,5 +10,7 @@',
    ' context',
    '+added line 1',
    '+added line 2',
    ' context',
    '@@ -20,3 +22,5 @@',
    ' context',
    '+added line 3',
    ' context',
  ].join('\n');

  // Hunk 1: @@ -10,5 +10,7 @@
  //   context at new line 10 → advance to 11
  //   + at 11 → added, advance to 12
  //   + at 12 → added, advance to 13
  //   context at 13 → advance to 14
  // Hunk 2: @@ -20,3 +22,5 @@
  //   context at new line 22 → advance to 23
  //   + at 23 → added, advance to 24
  //   context at 24 → advance to 25

  it('line in added section → true', () => {
    expect(isLineInDiff(patch, 11)).toBe(true);
  });

  it('line not in diff → false', () => {
    expect(isLineInDiff(patch, 50)).toBe(false);
  });

  it('line in context (not added) → false', () => {
    // Line 10 is a context line in hunk 1
    expect(isLineInDiff(patch, 10)).toBe(false);
  });

  it('empty patch → false', () => {
    expect(isLineInDiff('', 11)).toBe(false);
  });

  it('multi-hunk patch: line in second hunk → true', () => {
    expect(isLineInDiff(patch, 23)).toBe(true);
  });

  it('line from removed section → false', () => {
    const removalPatch = [
      '@@ -5,4 +5,3 @@',
      ' context',
      '-removed line',
      ' context',
      ' context',
    ].join('\n');
    // Removed lines don't advance the new-file line counter,
    // so there's no new-file line corresponding to the removed line.
    expect(isLineInDiff(removalPatch, 5)).toBe(false);
  });

  it('first line of hunk → true if it is an added line', () => {
    // Hunk where the very first line in new file is added
    const addFirstPatch = [
      '@@ -0,0 +1,3 @@',
      '+first added',
      '+second added',
      '+third added',
    ].join('\n');
    expect(isLineInDiff(addFirstPatch, 1)).toBe(true);
  });

  it('multiple added lines each individually verified', () => {
    expect(isLineInDiff(patch, 11)).toBe(true);
    expect(isLineInDiff(patch, 12)).toBe(true);
    expect(isLineInDiff(patch, 13)).toBe(false); // context
    expect(isLineInDiff(patch, 22)).toBe(false); // context
    expect(isLineInDiff(patch, 23)).toBe(true);
    expect(isLineInDiff(patch, 24)).toBe(false); // context
  });
});