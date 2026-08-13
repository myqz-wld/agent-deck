import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  LOCAL_WORKER_DESKTOP_STATE_PATH,
  LOCAL_WORKER_SYNCED_PROVIDER_SETTING_KEYS,
} from '@hosts/provider-state/local-worker-desktop-state';
import { DEFAULT_SETTINGS } from '@shared/types';
import {
  mergeServerCoreLocalWorkerDesktopState,
  readServerCoreLocalWorkerDesktopState,
} from './local-worker-desktop-state';

function providerHome(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-deck-worker-state-')));
  mkdirSync(join(root, '.agent-deck'), { mode: 0o700 });
  return root;
}

function writeState(root: string): void {
  const providerSettings = Object.fromEntries(
    LOCAL_WORKER_SYNCED_PROVIDER_SETTING_KEYS.map((key) => [key, DEFAULT_SETTINGS[key]]),
  );
  providerSettings.mcpHttpEnabled = false;
  providerSettings.bundledAgentRuntimeOverrides = {
    'claude-code:reviewer-claude': {
      model: 'review-model', thinking: 'max', provider: 'deepseek',
    },
  };
  writeFileSync(join(root, LOCAL_WORKER_DESKTOP_STATE_PATH), JSON.stringify({
    schemaVersion: 1,
    providerSettings,
    sessionLifecycle: {
      schemaVersion: 1,
      activeWindowMs: 120_000,
      closeAfterMs: 3_600_000,
      historyRetentionDays: 14,
    },
  }), { mode: 0o600 });
}

describe('Server Core Local Worker desktop state', () => {
  it('loads the private projection and lets explicit Worker options win', () => {
    const root = providerHome();
    writeState(root);
    const state = readServerCoreLocalWorkerDesktopState(root);
    expect(state).toMatchObject({
      providerSettings: {
        mcpHttpEnabled: false,
        bundledAgentRuntimeOverrides: {
          'claude-code:reviewer-claude': {
            model: 'review-model', thinking: 'max', provider: 'deepseek',
          },
        },
      },
      sessionLifecycle: {
        activeWindowMs: 120_000,
        closeAfterMs: 3_600_000,
        historyRetentionDays: 14,
      },
    });

    expect(mergeServerCoreLocalWorkerDesktopState({
      providerSettings: { mcpHttpEnabled: true, codexCliPath: '/opt/codex' },
    }, state)).toMatchObject({
      providerSettings: { mcpHttpEnabled: true, codexCliPath: '/opt/codex' },
      sessionLifecycle: {
        schemaVersion: 1,
        activeWindowMs: 120_000,
      },
    });
  });

  it('treats a missing projection as no desktop override', () => {
    const options = { providerSettings: { mcpHttpEnabled: true } };
    expect(mergeServerCoreLocalWorkerDesktopState(
      options,
      readServerCoreLocalWorkerDesktopState(providerHome()),
    )).toBe(options);
  });
});
