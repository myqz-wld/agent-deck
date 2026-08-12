import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppSettings } from '@shared/types';
import { scanCodexSettings } from '../codex-scanner';

function makeTmpConfigPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'codex-permission-scan-')), 'config.toml');
}

const roots: string[] = [];
const originalCodexHome = process.env.CODEX_HOME;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
});

type CodexScanSettings = Pick<
  AppSettings,
  'codexSandbox' | 'enableAgentDeckMcp' | 'mcpHttpEnabled' | 'permissionTimeoutMs'
>;

const baseSettings: CodexScanSettings = {
  codexSandbox: 'workspace-write',
  enableAgentDeckMcp: true,
  mcpHttpEnabled: true,
  permissionTimeoutMs: 90_000,
};

describe('scanCodexSettings', () => {
  it('reports session sandbox override, model, and dynamic Agent Deck MCP state', async () => {
    const configPath = makeTmpConfigPath();
    writeFileSync(
      configPath,
      'model = "gpt-5.5"\n\n[mcp_servers.user-owned]\ncommand = "node"\n',
      'utf8',
    );

    const result = await scanCodexSettings({
      configPath,
      appSettings: baseSettings,
      sessionCodexSandbox: 'read-only',
      sessionCodexApprovalPolicy: 'never',
    });

    expect(result.adapter).toBe('codex-cli');
    expect(result.config.path).toBe(configPath);
    expect(result.config.exists).toBe(true);
    expect(result.config.topLevelModel).toBe('gpt-5.5');
    expect(result.config.raw).toContain('[mcp_servers.user-owned]');
    expect(result.effective).toMatchObject({
      sandboxMode: 'read-only',
      sandboxSource: 'session',
      approvalPolicy: 'never',
      approvalSource: 'agent-deck',
      skipGitRepoCheck: true,
      agentDeckMcp: {
        enabled: true,
        httpEnabled: true,
        injectedForNewSessions: true,
        toolTimeoutSec: 90,
        reason: null,
      },
    });
  });

  it('falls back to settings sandbox and explains disabled Agent Deck MCP', async () => {
    const configPath = join(tmpdir(), `missing-codex-config-${Date.now()}.toml`);

    const result = await scanCodexSettings({
      configPath,
      appSettings: {
        ...baseSettings,
        enableAgentDeckMcp: false,
        permissionTimeoutMs: 0,
      },
      sessionCodexSandbox: null,
    });

    expect(result.config.exists).toBe(false);
    expect(result.config.raw).toBeNull();
    expect(result.config.readError).toBeNull();
    expect(result.config.topLevelModel).toBeNull();
    expect(result.effective.sandboxMode).toBe('workspace-write');
    expect(result.effective.sandboxSource).toBe('settings');
    expect(result.effective.agentDeckMcp).toEqual({
      enabled: false,
      httpEnabled: true,
      injectedForNewSessions: false,
      toolTimeoutSec: null,
      reason: 'Agent Deck MCP 已关闭',
    });
  });

  it('scans config.toml from CODEX_HOME by default', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-permission-home-'));
    roots.push(root);
    process.env.CODEX_HOME = root;
    writeFileSync(join(root, 'config.toml'), 'model = "gpt-custom-home"\n', 'utf8');

    const result = await scanCodexSettings({ appSettings: baseSettings });

    expect(result.config.path).toBe(join(root, 'config.toml'));
    expect(result.config.topLevelModel).toBe('gpt-custom-home');
  });

  it('bounds the raw config snapshot instead of sending an oversized file to the renderer', async () => {
    const configPath = makeTmpConfigPath();
    writeFileSync(configPath, `model = "gpt-5.5"\n# ${'x'.repeat(256 * 1024)}`, 'utf8');

    const result = await scanCodexSettings({
      configPath,
      appSettings: baseSettings,
    });

    expect(result.config.exists).toBe(true);
    expect(result.config.raw).toBeNull();
    expect(result.config.topLevelModel).toBeNull();
    expect(result.config.readError).toBe('配置文件超过安全读取上限');
  });
});
