import { describe, expect, it } from 'vitest';

import {
  CLAUDE_RUNTIME_PERMISSION_MODES,
  PERMISSION_MODES,
  isPermissionMode,
  isSelectablePermissionMode,
  normalizeStoredPermissionMode,
} from '../types';

describe('Claude permission mode SSOT', () => {
  it('exposes only the five supported user-facing modes', () => {
    expect(PERMISSION_MODES).toEqual([
      'default',
      'acceptEdits',
      'plan',
      'auto',
      'bypassPermissions',
    ]);
    for (const mode of CLAUDE_RUNTIME_PERMISSION_MODES) {
      expect(isPermissionMode(mode)).toBe(true);
    }
    expect(isSelectablePermissionMode('dontAsk')).toBe(false);
    for (const mode of PERMISSION_MODES) {
      expect(isSelectablePermissionMode(mode)).toBe(true);
    }
  });

  it('preserves provider-only dontAsk while rejecting unknown values', () => {
    expect(normalizeStoredPermissionMode('dontAsk')).toBe('dontAsk');
    expect(normalizeStoredPermissionMode('unknown')).toBeNull();
  });
});
