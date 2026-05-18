/**
 * codex 视角 agent-deck plugin 路径解析。
 *
 * 与 claude-code/sdk-injection.getClaudeAgentDeckPluginPath 同模式：dev / prod 自动分流。
 *
 * 关键差异：codex SDK **没有 plugins[] 字段**（不会自动扫该目录）。本路径由
 * `src/main/bundled-assets.ts` multi-root scan 路径用，把 codex-config/agent-deck-plugin/agents/
 * 下的 reviewer agent body 注册到 manifest，给 spawn handler 按 args.adapter 路由（plan §D4）。
 *
 * 协议层（codex 视角 system prompt）走 `resources/codex-config/CODEX_AGENTS.md` 静态文件，
 * 由 `src/main/codex-config/agents-md-installer.ts` 同步到 `~/.codex/AGENTS.md`（plan §D5）。
 */
import { app } from 'electron';
import { join } from 'node:path';

export function getCodexAgentDeckPluginPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'codex-config', 'agent-deck-plugin');
  }
  return join(app.getAppPath(), 'resources', 'codex-config', 'agent-deck-plugin');
}
