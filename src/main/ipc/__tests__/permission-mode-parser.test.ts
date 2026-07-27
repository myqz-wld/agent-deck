import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}));
vi.mock('@main/utils/logger', () => ({
  default: { scope: () => ({ warn: vi.fn() }) },
}));

import {
  parseOptionalAbsolutePathArray,
  parsePermissionMode,
} from '../_helpers';

describe('parsePermissionMode', () => {
  it.each([
    'default',
    'acceptEdits',
    'plan',
    'auto',
    'bypassPermissions',
  ] as const)('accepts the current Claude Code mode %s', (mode) => {
    expect(parsePermissionMode(mode)).toBe(mode);
  });

  it('rejects retired or unknown values', () => {
    expect(() => parsePermissionMode('dontAsk')).toThrow(/must be one of/);
    expect(() => parsePermissionMode('delegate')).toThrow(/must be one of/);
  });
});

describe('parseOptionalAbsolutePathArray', () => {
  it('preserves explicit absolute writable roots, including an empty list', () => {
    expect(parseOptionalAbsolutePathArray('roots', ['/repo', 'C:\\repo'])).toEqual([
      '/repo',
      'C:\\repo',
    ]);
    expect(parseOptionalAbsolutePathArray('roots', [])).toEqual([]);
    expect(parseOptionalAbsolutePathArray('roots', undefined)).toBeNull();
  });

  it('rejects relative roots before they reach an adapter sandbox', () => {
    expect(() => parseOptionalAbsolutePathArray('roots', ['relative/path'])).toThrow(
      /absolute path/,
    );
  });
});
