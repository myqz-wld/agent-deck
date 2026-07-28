import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveSessionCreationDefaults } from '../session-creation-defaults';

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
      provider: 'openai',
      model: 'gpt-5.6-sol',
      thinking: 'ultra',
      approvalPolicy: 'untrusted',
      codexSandbox: 'read-only',
    });
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
