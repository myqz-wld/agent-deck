import { describe, expect, it, vi } from 'vitest';
import { resolveCodexReasoningEffort } from '../create-session/reasoning-effort-resolve';

describe('resolveCodexReasoningEffort', () => {
  it('uses an explicit session value without reading global config', () => {
    const readConfigured = vi.fn(() => 'low' as const);
    expect(
      resolveCodexReasoningEffort({
        explicit: 'ultra',
        isResume: false,
        persisted: null,
        readConfigured,
      }),
    ).toEqual({ sessionValue: 'ultra', threadValue: 'ultra' });
    expect(readConfigured).not.toHaveBeenCalled();
  });

  it('uses a valid persisted value for resume without reading current global config', () => {
    const readConfigured = vi.fn(() => 'ultra' as const);
    expect(
      resolveCodexReasoningEffort({
        isResume: true,
        persisted: 'max',
        readConfigured,
      }),
    ).toEqual({ sessionValue: 'max', threadValue: 'max' });
    expect(readConfigured).not.toHaveBeenCalled();
  });

  it('keeps a historical null/invalid resume value unset', () => {
    const readConfigured = vi.fn(() => 'ultra' as const);
    expect(
      resolveCodexReasoningEffort({
        isResume: true,
        persisted: null,
        readConfigured,
      }),
    ).toEqual({ sessionValue: undefined, threadValue: undefined });
    expect(
      resolveCodexReasoningEffort({
        isResume: true,
        persisted: 'future-effort',
        readConfigured,
      }),
    ).toEqual({ sessionValue: undefined, threadValue: undefined });
    expect(readConfigured).not.toHaveBeenCalled();
  });

  it('reads a valid top-level config value only for a new session', () => {
    const readConfigured = vi.fn(() => 'ultra' as const);
    expect(
      resolveCodexReasoningEffort({
        isResume: false,
        persisted: null,
        readConfigured,
      }),
    ).toEqual({ sessionValue: 'ultra' });
    expect(readConfigured).toHaveBeenCalledOnce();
  });

  it('does not persist a global hint when a per-session config layer may override it', () => {
    const readConfigured = vi.fn(() => 'high' as const);
    expect(
      resolveCodexReasoningEffort({
        isResume: false,
        persisted: null,
        hasLayerOverride: true,
        readConfigured,
      }),
    ).toEqual({});
    expect(readConfigured).not.toHaveBeenCalled();
  });
});
