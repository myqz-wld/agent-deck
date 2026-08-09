import { describe, expect, it, vi } from 'vitest';
import {
  selectClaudeModel,
  selectClaudeSandboxMode,
} from './runtime-selection';

describe('Claude runtime selection', () => {
  it('prefers the requested sandbox without reading a global default', () => {
    const readDefault = vi.fn(() => 'off' as const);

    expect(
      selectClaudeSandboxMode({
        requested: 'strict',
        persisted: 'workspace-write',
        readDefault,
      }),
    ).toBe('strict');
    expect(readDefault).not.toHaveBeenCalled();
  });

  it('uses a persisted sandbox before the lazy global default', () => {
    const readDefault = vi.fn(() => 'strict' as const);

    expect(
      selectClaudeSandboxMode({
        persisted: 'workspace-write',
        readDefault,
      }),
    ).toBe('workspace-write');
    expect(readDefault).not.toHaveBeenCalled();
  });

  it('uses the global sandbox and then the safe off fallback', () => {
    expect(
      selectClaudeSandboxMode({
        persisted: null,
        readDefault: () => 'strict',
      }),
    ).toBe('strict');
    expect(
      selectClaudeSandboxMode({
        persisted: null,
        readDefault: () => null,
      }),
    ).toBe('off');
  });

  it('prefers a requested model over resumed and profile models', () => {
    expect(
      selectClaudeModel({
        requested: 'requested-model',
        persisted: 'resumed-model',
        profileDefault: 'profile-model',
      }),
    ).toBe('requested-model');
  });

  it('uses a resumed model before the provider profile default', () => {
    expect(
      selectClaudeModel({
        persisted: 'resumed-model',
        profileDefault: 'profile-model',
      }),
    ).toBe('resumed-model');
  });

  it('uses the profile default or leaves SDK model selection undefined', () => {
    expect(
      selectClaudeModel({ persisted: null, profileDefault: 'profile-model' }),
    ).toBe('profile-model');
    expect(selectClaudeModel({ persisted: null })).toBeUndefined();
  });
});
