import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stringifyMcpServersSection } from '@main/codex-config/toml-writer';
import type { AppSettings } from '@shared/types';
import { scanCodexSettings } from '../codex-scanner';

function makeTmpConfigPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'codex-permission-scan-')), 'config.toml');
}

type CodexScanSettings = Pick<
  AppSettings,
  'codexSandbox' | 'codexMcpServers' | 'enableAgentDeckMcp' | 'mcpHttpEnabled' | 'permissionTimeoutMs'
>;

const baseSettings: CodexScanSettings = {
  codexSandbox: 'workspace-write',
  codexMcpServers: [{ name: 'app-managed', command: 'node', args: ['server.js'] }],
  enableAgentDeckMcp: true,
  mcpHttpEnabled: true,
  permissionTimeoutMs: 90_000,
};

describe('scanCodexSettings', () => {
  it('reports session sandbox override, model, app-managed MCP, and marker-managed MCP', async () => {
    const configPath = makeTmpConfigPath();
    writeFileSync(
      configPath,
      [
        'model = "gpt-5.5"',
        '',
        stringifyMcpServersSection([
          { name: 'marker-managed', url: 'https://example.test/mcp', bearerTokenEnvVar: 'TOKEN' },
        ]),
        '',
      ].join('\n'),
      'utf8',
    );

    const result = await scanCodexSettings({
      configPath,
      appSettings: baseSettings,
      sessionCodexSandbox: 'read-only',
    });

    expect(result.adapter).toBe('codex-cli');
    expect(result.config.path).toBe(configPath);
    expect(result.config.exists).toBe(true);
    expect(result.config.topLevelModel).toBe('gpt-5.5');
    expect(result.config.markerManagedMcpServers).toEqual([
      { name: 'marker-managed', url: 'https://example.test/mcp', bearerTokenEnvVar: 'TOKEN' },
    ]);
    expect(result.appManagedMcpServers).toEqual(baseSettings.codexMcpServers);
    expect(result.effective).toMatchObject({
      sandboxMode: 'read-only',
      sandboxSource: 'session',
      approvalPolicy: 'never',
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
});
