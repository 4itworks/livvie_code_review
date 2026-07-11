import { describe, it, expect, vi } from 'vitest';

vi.mock('@actions/core', () => ({
  info: vi.fn(),
  warning: vi.fn(),
  debug: vi.fn(),
  startGroup: vi.fn(),
  endGroup: vi.fn(),
}));

import {
  getPerspectives,
  parsePerspectivesInput,
  PERSPECTIVE_REGISTRY,
} from './perspectives.js';
import * as core from '@actions/core';

describe('getPerspectives', () => {
  it('["generalist"] → 1 perspective with id="generalist"', () => {
    const result = getPerspectives(['generalist']);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('generalist');
    expect(result[0].name).toBe('General Reviewer');
  });

  it('["security", "performance"] → 2 perspectives', () => {
    const result = getPerspectives(['security', 'performance']);
    expect(result).toHaveLength(2);
    expect(result.map((p) => p.id)).toEqual(['security', 'performance']);
  });

  it('["unknown"] → 0 perspectives (warning logged)', () => {
    const result = getPerspectives(['unknown']);
    expect(result).toHaveLength(0);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Unknown perspective "unknown"')
    );
  });

  it('empty array → []', () => {
    const result = getPerspectives([]);
    expect(result).toEqual([]);
  });

  it('all 5 perspectives → 5 results', () => {
    const result = getPerspectives([
      'code-quality',
      'security',
      'performance',
      'architecture',
      'generalist',
    ]);
    expect(result).toHaveLength(5);
    expect(result.map((p) => p.id).sort()).toEqual([
      'architecture',
      'code-quality',
      'generalist',
      'performance',
      'security',
    ]);
  });
});

describe('parsePerspectivesInput', () => {
  it('"" → ["generalist"] (default)', () => {
    expect(parsePerspectivesInput('')).toEqual(['generalist']);
  });

  it('"security" → ["security"]', () => {
    expect(parsePerspectivesInput('security')).toEqual(['security']);
  });

  it('"security,performance" → ["security", "performance"]', () => {
    expect(parsePerspectivesInput('security,performance')).toEqual([
      'security',
      'performance',
    ]);
  });

  it('"security, performance" → ["security", "performance"] (trimmed)', () => {
    expect(parsePerspectivesInput('security, performance')).toEqual([
      'security',
      'performance',
    ]);
  });

  it('",,,," → ["generalist"] (all empty after split)', () => {
    expect(parsePerspectivesInput(',,,')).toEqual(['generalist']);
  });

  it('"unknown,also-unknown" → ["unknown", "also-unknown"] (no validation)', () => {
    expect(parsePerspectivesInput('unknown,also-unknown')).toEqual([
      'unknown',
      'also-unknown',
    ]);
  });

  it('whitespace-only → ["generalist"]', () => {
    expect(parsePerspectivesInput('   ')).toEqual(['generalist']);
  });
});

describe('PERSPECTIVE_REGISTRY', () => {
  it('has exactly 5 entries', () => {
    expect(Object.keys(PERSPECTIVE_REGISTRY)).toHaveLength(5);
  });

  it.each(['code-quality', 'security', 'performance', 'architecture', 'generalist'] as const)(
    'each entry "%s" has required fields',
    (key) => {
      const p = PERSPECTIVE_REGISTRY[key];
      expect(p).toBeDefined();
      expect(p.id).toBe(key);
      expect(typeof p.name).toBe('string');
      expect(p.name.length).toBeGreaterThan(0);
      expect(typeof p.systemPrompt).toBe('string');
      expect(p.systemPrompt.length).toBeGreaterThan(0);
      expect(typeof p.focus).toBe('string');
      expect(p.focus.length).toBeGreaterThan(0);
    }
  );

  it.each(Object.values(PERSPECTIVE_REGISTRY))(
    'systemPrompt of "$name" contains "JSON"',
    (p) => {
      expect(p.systemPrompt).toContain('JSON');
    }
  );
});
