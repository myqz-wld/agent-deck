import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS } from '@shared/types/settings/defaults';
import { resolveServerCoreSessionLifecycleSettings } from './session-lifecycle-options';

describe('Server Core session lifecycle settings', () => {
  it('uses the Local lifecycle policy as the headless default', () => {
    expect(resolveServerCoreSessionLifecycleSettings({})).toEqual({
      activeWindowMs: DEFAULT_SETTINGS.activeWindowMs,
      closeAfterMs: DEFAULT_SETTINGS.closeAfterMs,
      historyRetentionDays: DEFAULT_SETTINGS.historyRetentionDays,
      issueResolvedRetentionDays: DEFAULT_SETTINGS.issueResolvedRetentionDays,
      issueSoftDeletedRetentionDays: DEFAULT_SETTINGS.issueSoftDeletedRetentionDays,
      messageRetentionDays: DEFAULT_SETTINGS.messageRetentionDays,
    });
  });

  it('accepts only the exact versioned settings shape', () => {
    expect(resolveServerCoreSessionLifecycleSettings({
      sessionLifecycle: {
        schemaVersion: 1,
        activeWindowMs: 60_000,
        closeAfterMs: 120_000,
        historyRetentionDays: 7,
        issueResolvedRetentionDays: 14,
        issueSoftDeletedRetentionDays: 3,
        messageRetentionDays: 21,
      },
    })).toEqual({
      activeWindowMs: 60_000,
      closeAfterMs: 120_000,
      historyRetentionDays: 7,
      issueResolvedRetentionDays: 14,
      issueSoftDeletedRetentionDays: 3,
      messageRetentionDays: 21,
    });
    expect(() => resolveServerCoreSessionLifecycleSettings({
      sessionLifecycle: {
        schemaVersion: 1,
        activeWindowMs: 60_000,
        closeAfterMs: 120_000,
        historyRetentionDays: 7,
        issueResolvedRetentionDays: 14,
        issueSoftDeletedRetentionDays: 3,
        messageRetentionDays: 21,
        providerConfigPath: '/private/provider.json',
      },
    })).toThrow('unsupported fields');
  });

  it('rejects a close threshold that could collapse both phases into one policy window', () => {
    expect(() => resolveServerCoreSessionLifecycleSettings({
      sessionLifecycle: {
        schemaVersion: 1,
        activeWindowMs: 120_000,
        closeAfterMs: 60_000,
        historyRetentionDays: 7,
        issueResolvedRetentionDays: 14,
        issueSoftDeletedRetentionDays: 3,
        messageRetentionDays: 21,
      },
    })).toThrow('must exceed activeWindowMs');
  });
});
