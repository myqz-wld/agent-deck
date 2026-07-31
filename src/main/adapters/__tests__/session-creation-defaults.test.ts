import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CODEX_CREATION_DEFAULTS_TIMEOUT_MS,
  resolveSessionCreationDefaults,
} from '../session-creation-defaults';

const roots: string[] = [];
const settings = {
  claudeCodeSandbox: 'strict' as const,
  codexSandbox: 'read-only' as const,
  grokSandbox: 'workspace',
};

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-deck-session-defaults-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('resolveSessionCreationDefaults', () => {
  it('layers Claude user, project, and local settings.json model and effort values', async () => {
    const root = tempRoot();
    const cwd = join(root, 'repo');
    mkdirSync(join(root, '.claude'), { recursive: true });
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(
      join(root, '.claude', 'settings.json'),
      JSON.stringify({ model: 'sonnet', effortLevel: 'low' }),
    );
    writeFileSync(
      join(cwd, '.claude', 'settings.json'),
      JSON.stringify({ model: 'opus', effortLevel: 'high' }),
    );
    writeFileSync(
      join(cwd, '.claude', 'settings.local.json'),
      JSON.stringify({ effortLevel: 'xhigh' }),
    );

    await expect(resolveSessionCreationDefaults(
      'claude-code',
      { cwd },
      { settings, userHome: root },
    )).resolves.toMatchObject({
      provider: '',
      model: 'opus',
      thinking: 'xhigh',
      permissionMode: 'bypassPermissions',
      claudeCodeSandbox: 'strict',
    });
  });

  it('uses a selected Claude Gateway profile model and effort', async () => {
    const root = tempRoot();
    const settingsPath = join(root, 'gateway.json');
    writeFileSync(settingsPath, JSON.stringify({ effortLevel: 'max' }));

    await expect(resolveSessionCreationDefaults(
      'claude-code',
      { cwd: root, provider: 'deepseek' },
      {
        settings,
        userHome: root,
        resolveClaudeProfile: () => ({
          id: 'deepseek',
          settingsPath,
          defaultModel: 'deepseek-chat',
          modelAliases: {},
        }),
      },
    )).resolves.toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-chat',
      thinking: 'max',
    });
  });

  it('keeps user settings as the fallback while a Gateway profile is missing', async () => {
    const root = tempRoot();
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(
      join(root, '.claude', 'settings.json'),
      JSON.stringify({ model: 'user-fallback', effortLevel: 'medium' }),
    );

    await expect(resolveSessionCreationDefaults(
      'claude-code',
      { cwd: root, provider: 'unfinished-profile' },
      { settings, userHome: root },
    )).resolves.toMatchObject({
      provider: 'unfinished-profile',
      model: 'user-fallback',
      thinking: 'medium',
    });
  });

  it('reads Codex effective config while keeping the Agent Deck sandbox setting', async () => {
    const root = tempRoot();
    const defaults = await resolveSessionCreationDefaults(
      'codex-cli',
      { cwd: root },
      {
        settings,
        codexConfigPath: join(root, 'missing.toml'),
        readCodexConfig: async () => ({
          model_provider: 'openai',
          model: 'gpt-5.6-sol',
          model_reasoning_effort: 'ultra',
          approval_policy: 'untrusted',
          sandbox_mode: 'danger-full-access',
        }),
      },
    );

    expect(defaults).toMatchObject({
      provider: '',
      model: 'gpt-5.6-sol',
      thinking: 'ultra',
      approvalPolicy: 'untrusted',
      codexSandbox: 'read-only',
    });
  });

  it('starts Codex config resolution under a native independent profile', async () => {
    const root = tempRoot();
    const configPath = join(root, 'config.toml');
    writeFileSync(configPath, 'model = "base-model"\napproval_policy = "on-request"\n');
    writeFileSync(
      join(root, 'openrouter.config.toml'),
      'model = "profile-fallback"\nmodel_reasoning_effort = "max"\napproval_policy = "never"\n',
    );
    const readCodexConfig = vi.fn(async (
      _cwd: string,
      _signal?: AbortSignal,
      profile?: string,
    ) => ({
      model: 'profile-effective',
      model_reasoning_effort: 'ultra',
      approval_policy: 'untrusted',
      selected_profile: profile,
    }));

    await expect(resolveSessionCreationDefaults(
      'codex-cli',
      { cwd: root, provider: 'openrouter' },
      { settings, codexConfigPath: configPath, readCodexConfig },
    )).resolves.toMatchObject({
      provider: 'openrouter',
      model: 'profile-effective',
      thinking: 'ultra',
      approvalPolicy: 'untrusted',
    });
    expect(readCodexConfig).toHaveBeenCalledWith(
      root,
      expect.any(AbortSignal),
      'openrouter',
    );
  });

  it('falls back to the top-level Codex approval policy when config/read is unavailable', async () => {
    const root = tempRoot();
    const configPath = join(root, 'config.toml');
    writeFileSync(
      configPath,
      'approval_policy = "never"\nmodel = "gpt-file-default"\n',
    );

    await expect(resolveSessionCreationDefaults(
      'codex-cli',
      { cwd: root },
      {
        settings,
        codexConfigPath: configPath,
        readCodexConfig: async () => {
          throw new Error('app-server unavailable');
        },
      },
    )).resolves.toMatchObject({
      model: 'gpt-file-default',
      approvalPolicy: 'never',
    });
  });

  it('defaults Codex approvals to on-request when no valid policy is configured', async () => {
    const root = tempRoot();

    await expect(resolveSessionCreationDefaults(
      'codex-cli',
      { cwd: root },
      {
        settings,
        codexConfigPath: join(root, 'missing.toml'),
        readCodexConfig: async () => ({}),
      },
    )).resolves.toMatchObject({
      approvalPolicy: 'on-request',
    });
  });

  it('bounds a stuck Codex config/read and lets the next request recover', async () => {
    vi.useFakeTimers();
    const root = tempRoot();
    const diagnostics: unknown[] = [];
    let attempts = 0;
    let firstSignal: AbortSignal | undefined;
    const readCodexConfig = (_cwd: string, signal?: AbortSignal) => {
      attempts += 1;
      if (attempts === 1) {
        firstSignal = signal;
        return new Promise<Record<string, unknown>>(() => undefined);
      }
      return Promise.resolve({
        model_provider: 'openai',
        model: 'gpt-recovered',
        approval_policy: 'on-request',
      });
    };
    const deps = {
      settings,
      codexConfigPath: join(root, 'missing.toml'),
      readCodexConfig,
      onDiagnostic: (diagnostic: unknown) => diagnostics.push(diagnostic),
    };

    const first = resolveSessionCreationDefaults('codex-cli', { cwd: root }, deps);
    await vi.advanceTimersByTimeAsync(CODEX_CREATION_DEFAULTS_TIMEOUT_MS);
    await expect(first).resolves.toMatchObject({
      model: '',
      approvalPolicy: 'on-request',
    });
    expect(firstSignal?.aborted).toBe(true);
    expect(diagnostics).toContainEqual({
      resolutionSource: 'codex-app-server',
      failureCategory: 'timeout',
    });

    await expect(
      resolveSessionCreationDefaults('codex-cli', { cwd: root }, deps),
    ).resolves.toMatchObject({
      provider: '',
      model: 'gpt-recovered',
      approvalPolicy: 'on-request',
    });
  });

  it('reads Grok config values and falls back to a concrete workspace sandbox', async () => {
    const root = tempRoot();
    const configPath = join(root, 'config.toml');
    writeFileSync(
      configPath,
      'model = "grok-custom"\nreasoning_effort = "medium"\n[ui]\nyolo = false\n',
    );

    await expect(resolveSessionCreationDefaults(
      'grok-build',
      { cwd: root },
      {
        settings: { ...settings, grokSandbox: '' },
        userHome: root,
        grokConfigPath: configPath,
      },
    )).resolves.toMatchObject({
      model: 'grok-custom',
      thinking: 'medium',
      sessionMode: 'default',
      grokSandbox: 'workspace',
    });
  });
});
