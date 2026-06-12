/**
 * codex 视角 agent-deck plugin 路径解析。
 *
 * 与 claude-code/sdk-injection.getClaudeAgentDeckPluginPath 同模式：dev / prod 自动分流。
 *
 * 关键差异：codex app-server **没有 Claude SDK 的 plugins[] 字段**。本路径由
 * bundled-assets / custom-agent loader 扫描 Codex TOML reviewer agents；skills 通过
 * `skills/extraRoots/set` 指向 app-owned substituted mirror；CODEX_AGENTS.md 通过
 * per-session `developerInstructions` 注入。
 */
import { app } from 'electron';
import { join } from 'node:path';

export function getCodexAgentDeckPluginPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'codex-config', 'agent-deck-plugin');
  }
  return join(app.getAppPath(), 'resources', 'codex-config', 'agent-deck-plugin');
}
