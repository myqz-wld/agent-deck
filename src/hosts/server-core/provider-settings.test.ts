import { describe, expect, it } from 'vitest';

import type { JsonObject } from '@contracts/index';
import { DEFAULT_SETTINGS } from '@shared/types';
import {
  SERVER_CORE_PROVIDER_SETTINGS_KEYS,
  resolveServerCoreProviderSettings,
} from './provider-settings';

describe('Server Core provider settings', () => {
  it('publishes an immutable provider-only default snapshot', () => {
    const settings = resolveServerCoreProviderSettings({ unrelated: true });

    expect(Object.keys(settings).sort()).toEqual(
      [...SERVER_CORE_PROVIDER_SETTINGS_KEYS].sort(),
    );
    expect(settings).toMatchObject({
      claudeCodeSandbox: DEFAULT_SETTINGS.claudeCodeSandbox,
      codexSandbox: DEFAULT_SETTINGS.codexSandbox,
      grokSandbox: DEFAULT_SETTINGS.grokSandbox,
      permissionTimeoutMs: DEFAULT_SETTINGS.permissionTimeoutMs,
    });
    expect(Object.isFrozen(settings)).toBe(true);
  });

  it('normalizes bounded overrides without accepting desktop-only settings', () => {
    const settings = resolveServerCoreProviderSettings({
      providerSettings: {
        claudeCliPath: '/opt/providers/claude',
        codexCliPath: '/opt/providers/codex',
        enableAgentDeckMcp: false,
        grokSandbox: ' project-locked ',
        permissionTimeoutMs: 0,
        summaryModel: ' model-a ',
        summaryThinking: 'ultra',
      },
    });

    expect(settings).toMatchObject({
      claudeCliPath: '/opt/providers/claude',
      codexCliPath: '/opt/providers/codex',
      enableAgentDeckMcp: false,
      grokSandbox: 'project-locked',
      permissionTimeoutMs: 0,
      summaryModel: 'model-a',
      summaryThinking: 'ultra',
    });
  });

  it.each<JsonObject>([
    { providerSettings: null },
    { providerSettings: { typoSandbox: 'strict' } },
    { providerSettings: { claudeCliPath: 'relative/claude' } },
    { providerSettings: { codexSandbox: 'strict' } },
    { providerSettings: { permissionTimeoutMs: -1 } },
    { providerSettings: { summaryThinking: 'unsupported' } },
    { providerSettings: { grokSandbox: 'strict\nworkspace' } },
  ])('rejects an invalid provider settings boundary %#', (runtimeOptions) => {
    expect(() => resolveServerCoreProviderSettings(runtimeOptions)).toThrow(
      /providerSettings/,
    );
  });
});
