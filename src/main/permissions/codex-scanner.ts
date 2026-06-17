/**
 * Codex 权限页只读扫描器。
 *
 * Codex CLI 没有 Claude Code 的 allow/deny/ask settings 层；Agent Deck 侧能展示的真实权限面
 * 是 Codex SDK 启动时使用的 sandboxMode、固定 approvalPolicy、Agent Deck MCP 注入状态，以及
 * `~/.codex/config.toml` 中与 Codex 运行相关的只读配置。
 */

import { promises as fs } from 'node:fs';
import type {
  AppSettings,
  CodexPermissionScanResult,
  CodexSandboxMode,
} from '@shared/types';
import { settingsStore } from '@main/store/settings-store';
import {
  getCodexConfigPath,
  readMcpServersFromCodexConfig,
  readTopLevelModelFromCodexConfig,
} from '@main/codex-config/toml-writer';
import { permissionTimeoutMsToCodexToolTimeoutSec } from '@main/codex-config/agent-deck-mcp-injector';

type CodexScanSettings = Pick<
  AppSettings,
  'codexSandbox' | 'codexMcpServers' | 'enableAgentDeckMcp' | 'mcpHttpEnabled' | 'permissionTimeoutMs'
>;

interface ScanCodexSettingsOptions {
  configPath?: string;
  appSettings?: CodexScanSettings;
  sessionCodexSandbox?: CodexSandboxMode | null;
}

const CODEX_SANDBOX_MODES = new Set<CodexSandboxMode>([
  'workspace-write',
  'read-only',
  'danger-full-access',
]);

function isCodexSandboxMode(value: unknown): value is CodexSandboxMode {
  return typeof value === 'string' && CODEX_SANDBOX_MODES.has(value as CodexSandboxMode);
}

async function readRawConfig(configPath: string): Promise<{
  exists: boolean;
  raw: string | null;
  readError: string | null;
}> {
  try {
    return {
      exists: true,
      raw: await fs.readFile(configPath, 'utf-8'),
      readError: null,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { exists: false, raw: null, readError: null };
    }
    return { exists: false, raw: null, readError: (err as Error).message };
  }
}

export async function scanCodexSettings(
  options: ScanCodexSettingsOptions = {},
): Promise<CodexPermissionScanResult> {
  const settings = options.appSettings ?? settingsStore.getAll();
  const configPath = options.configPath ?? getCodexConfigPath();
  const sessionSandbox = options.sessionCodexSandbox;
  const hasSessionSandbox = isCodexSandboxMode(sessionSandbox);
  const sandboxMode = hasSessionSandbox ? sessionSandbox : settings.codexSandbox;
  const agentDeckMcpEnabled = settings.enableAgentDeckMcp && settings.mcpHttpEnabled;

  const [configRaw, topLevelModel, markerManagedMcpServers] = await Promise.all([
    readRawConfig(configPath),
    Promise.resolve(readTopLevelModelFromCodexConfig(configPath)),
    Promise.resolve(readMcpServersFromCodexConfig(configPath)),
  ]);

  return {
    adapter: 'codex-cli',
    config: {
      path: configPath,
      exists: configRaw.exists,
      raw: configRaw.raw,
      readError: configRaw.readError,
      topLevelModel,
      markerManagedMcpServers,
    },
    appManagedMcpServers: settings.codexMcpServers,
    effective: {
      sandboxMode,
      sandboxSource: hasSessionSandbox ? 'session' : 'settings',
      approvalPolicy: 'never',
      skipGitRepoCheck: true,
      agentDeckMcp: {
        enabled: settings.enableAgentDeckMcp,
        httpEnabled: settings.mcpHttpEnabled,
        injectedForNewSessions: agentDeckMcpEnabled,
        toolTimeoutSec: agentDeckMcpEnabled
          ? permissionTimeoutMsToCodexToolTimeoutSec(settings.permissionTimeoutMs)
          : null,
        reason: !settings.enableAgentDeckMcp
          ? 'Agent Deck MCP 已关闭'
          : !settings.mcpHttpEnabled
            ? 'MCP HTTP transport 已关闭，Codex 无法连接'
            : null,
      },
    },
  };
}
