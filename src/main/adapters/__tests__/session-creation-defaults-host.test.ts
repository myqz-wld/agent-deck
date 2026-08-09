import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  debug: vi.fn(),
  getAll: vi.fn(),
  getCodexInstance: vi.fn(),
  request: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@main/store/settings-store', () => ({
  settingsStore: { getAll: mocks.getAll },
}));

vi.mock('../codex-cli/codex-instance-pool', () => ({
  getCodexInstance: mocks.getCodexInstance,
}));

vi.mock('@main/utils/logger', () => ({
  default: { scope: () => ({ debug: mocks.debug, warn: mocks.warn }) },
}));

describe('desktop session creation defaults host', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAll.mockReturnValue({
      claudeCodeSandbox: 'strict',
      codexSandbox: 'read-only',
      grokSandbox: 'workspace',
    });
    mocks.request.mockResolvedValue({
      config: {
        model: 'gpt-host-default',
        model_reasoning_effort: 'xhigh',
      },
    });
    mocks.getCodexInstance.mockResolvedValue({ request: mocks.request });
  });

  it('supplies settings, Codex config access, and desktop diagnostics to the Core', async () => {
    const { resolveSessionCreationDefaults } = await import('../session-creation-defaults');
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });

    await expect(resolveSessionCreationDefaults(
      'codex-cli',
      { cwd: '/repo' },
      {
        codexConfigPath: '/missing/config.toml',
        readConfigFile: async () => { throw missing; },
      },
    )).resolves.toMatchObject({
      codexSandbox: 'read-only',
      model: 'gpt-host-default',
      thinking: 'xhigh',
    });

    expect(mocks.getAll).toHaveBeenCalledOnce();
    expect(mocks.getCodexInstance).toHaveBeenCalledOnce();
    expect(mocks.request).toHaveBeenCalledWith(
      'config/read',
      { includeLayers: false, cwd: '/repo' },
      expect.any(AbortSignal),
    );
    expect(mocks.debug).toHaveBeenCalledWith(
      '[session-creation-defaults] config fallback',
      { resolutionSource: 'codex-config', failureCategory: 'not-found' },
    );
  });
});
