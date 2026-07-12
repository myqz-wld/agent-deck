import { describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import { IpcInvoke } from '@shared/ipc-channels';
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/types';
import { IpcInputError } from '../_helpers';
import { registerSettingsIpc, validateSettingsPatch } from '../settings';

const settingsStoreMocks = vi.hoisted(() => ({
  getAll: vi.fn(),
  patch: vi.fn(),
}));
const invalidatePreparations = vi.hoisted(() => vi.fn());

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }));
vi.mock('@main/window', () => ({ getFloatingWindow: vi.fn() }));
vi.mock('@main/store/settings-store', () => ({ settingsStore: settingsStoreMocks }));
vi.mock('@main/adapters/registry', () => ({ adapterRegistry: {} }));
vi.mock('@main/login-item', () => ({ syncLoginItemSetting: vi.fn() }));
vi.mock('@main/session/lifecycle-scheduler', () => ({ getLifecycleScheduler: vi.fn() }));
vi.mock('@main/store/issue-lifecycle-scheduler', () => ({ getIssueLifecycleScheduler: vi.fn() }));
vi.mock('@main/store/message-lifecycle-scheduler', () => ({ getMessageLifecycleScheduler: vi.fn() }));
vi.mock('@main/session/summarizer', () => ({ summarizer: {} }));
vi.mock('@main/adapters/claude-code/sdk-injection', () => ({
  getActiveAgentDeckClaudeMd: vi.fn(),
  getBuiltinAgentDeckClaudeMd: vi.fn(),
  invalidateAgentDeckSystemPromptAppend: vi.fn(),
  resetUserAgentDeckClaudeMd: vi.fn(),
  saveUserAgentDeckClaudeMd: vi.fn(),
}));
vi.mock('@main/codex-config/toml-writer', () => ({ writeMcpServersToCodexConfig: vi.fn() }));
vi.mock('@main/codex-config/agents-md-installer', () => ({
  syncAgentDeckSection: vi.fn(),
  getActiveCodexAgentsMd: vi.fn(),
  getBuiltinCodexAgentsMd: vi.fn(),
  saveUserCodexAgentsMd: vi.fn(),
  resetUserCodexAgentsMd: vi.fn(),
}));
vi.mock('@main/codex-config/skills-installer', () => ({ syncSkills: vi.fn() }));
vi.mock('../session-hand-off', () => ({
  invalidateSessionHandOffPreparationsForSettingsChange: invalidatePreparations,
}));

function current(overrides: Partial<AppSettings> = {}): AppSettings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

describe('SettingsSet continuation validation', () => {
  it.each([8_000, 64_000, 128_000])('accepts raw retention token value %s', (value) => {
    expect(
      validateSettingsPatch({ continuationRawRetentionTokens: value }, current()),
    ).toMatchObject({ continuationRawRetentionTokens: value });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 64_000.5, 7_999, 128_001, '64000'])(
    'rejects unsafe, fractional, out-of-range, or non-number raw retention value %s',
    (value) => {
      expect(() =>
        validateSettingsPatch(
          { continuationRawRetentionTokens: value } as unknown,
          current(),
        ),
      ).toThrow(IpcInputError);
    },
  );

  it('accepts all current Codex thinking levels and a provider/model update together', () => {
    for (const thinking of ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
      expect(
        validateSettingsPatch(
          {
            continuationCheckpointProvider: 'codex',
            continuationCheckpointModel: 'gpt-continuation',
            continuationCheckpointThinking: thinking,
          },
          current(),
        ),
      ).toMatchObject({ continuationCheckpointThinking: thinking });
    }
  });

  it.each(['minimal', 'bogus'])('rejects removed or unknown Codex thinking %s', (thinking) => {
    expect(() =>
      validateSettingsPatch(
        {
          continuationCheckpointProvider: 'codex',
          continuationCheckpointThinking: thinking,
        } as unknown,
        current(),
      ),
    ).toThrow(/continuationCheckpointThinking/);
  });

  it.each(['minimal', 'bogus'])('rejects removed or unknown Codex summary thinking %s', (thinking) => {
    expect(() =>
      validateSettingsPatch(
        { summaryProvider: 'codex', summaryReasoning: thinking } as unknown,
        current(),
      ),
    ).toThrow(/summaryReasoning/);
  });

  it.each(['minimal', 'ultra', 'bogus'])(
    'rejects Claude-family incompatible thinking %s',
    (thinking) => {
      expect(() =>
        validateSettingsPatch(
          {
            continuationCheckpointProvider: 'deepseek',
            continuationCheckpointThinking: thinking,
          } as unknown,
          current(),
        ),
      ).toThrow(/continuationCheckpointThinking/);
    },
  );

  it('rejects a provider-only switch that would make the retained thinking incompatible', () => {
    expect(() =>
      validateSettingsPatch(
        { continuationCheckpointProvider: 'claude' },
        current({
          continuationCheckpointProvider: 'codex',
          continuationCheckpointThinking: 'ultra',
        }),
      ),
    ).toThrow(/continuationCheckpointThinking/);
  });

  it.each(['unknown', 'claude-code', null, 1])('rejects unknown provider %s', (provider) => {
    expect(() =>
      validateSettingsPatch(
        { continuationCheckpointProvider: provider } as unknown,
        current(),
      ),
    ).toThrow(/continuationCheckpointProvider/);
  });

  it('accepts an empty or 256-character model and rejects non-string or oversized models', () => {
    expect(validateSettingsPatch({ continuationCheckpointModel: '' }, current())).toMatchObject({
      continuationCheckpointModel: '',
    });
    expect(
      validateSettingsPatch({ continuationCheckpointModel: 'm'.repeat(256) }, current()),
    ).toMatchObject({ continuationCheckpointModel: 'm'.repeat(256) });
    expect(() =>
      validateSettingsPatch({ continuationCheckpointModel: 42 } as unknown, current()),
    ).toThrow(/continuationCheckpointModel/);
    expect(() =>
      validateSettingsPatch({ continuationCheckpointModel: 'm'.repeat(257) }, current()),
    ).toThrow(/continuationCheckpointModel/);
  });

  it('rejects unknown settings keys and non-object patches', () => {
    expect(() => validateSettingsPatch({ handOffProvider: 'codex' }, current())).toThrow(
      /unknown setting/,
    );
    expect(() => validateSettingsPatch({ unexpected: true }, current())).toThrow(/unknown setting/);
    expect(() => validateSettingsPatch(Number.NaN, current())).toThrow(/patch/);
    expect(() => validateSettingsPatch([], current())).toThrow(/patch/);
  });

  it('invalidates prepared UI hand-offs only after a valid continuation settings patch', () => {
    settingsStoreMocks.getAll.mockReset().mockReturnValue(current());
    settingsStoreMocks.patch.mockReset().mockImplementation((patch: Partial<AppSettings>) => ({
      ...current(),
      ...patch,
    }));
    invalidatePreparations.mockClear();
    const handle = vi.mocked(ipcMain.handle);
    handle.mockClear();
    registerSettingsIpc();
    const setHandler = handle.mock.calls.find(([channel]) => channel === IpcInvoke.SettingsSet)?.[1];
    expect(setHandler).toBeTypeOf('function');

    expect(
      setHandler!({} as never, { continuationRawRetentionTokens: 96_000 }),
    ).toMatchObject({ continuationRawRetentionTokens: 96_000 });
    expect(settingsStoreMocks.patch).toHaveBeenCalledWith({
      continuationRawRetentionTokens: 96_000,
    });
    expect(invalidatePreparations).toHaveBeenCalledTimes(1);

    settingsStoreMocks.patch.mockClear();
    invalidatePreparations.mockClear();
    expect(() => setHandler!({} as never, { handOffProvider: 'codex' })).toThrow(IpcInputError);
    expect(settingsStoreMocks.patch).not.toHaveBeenCalled();
    expect(invalidatePreparations).not.toHaveBeenCalled();

    expect(setHandler!({} as never, { summaryModel: 'claude-haiku' })).toMatchObject({
      summaryModel: 'claude-haiku',
    });
    expect(invalidatePreparations).not.toHaveBeenCalled();

    expect(setHandler!({} as never, { codexSandbox: 'read-only' })).toMatchObject({
      codexSandbox: 'read-only',
    });
    expect(setHandler!({} as never, { claudeCodeSandbox: 'strict' })).toMatchObject({
      claudeCodeSandbox: 'strict',
    });
    expect(invalidatePreparations).toHaveBeenCalledTimes(2);
  });
});
