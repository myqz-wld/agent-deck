/**
 * codex 视角 agent-deck plugin 路径解析。
 *
 * 与 Claude plugin source path 同模式：dev / prod 自动分流。
 *
 * 关键差异：codex app-server **没有 Claude SDK 的 plugins[] 字段**。本路径由
 * bundled-assets / custom-agent loader 扫描 Codex TOML reviewer agents；skills 通过
 * `skills/extraRoots/set` 指向 app-owned substituted mirror；CODEX_AGENTS.md 通过
 * per-session `developerInstructions` 注入。
 */
import { join } from 'node:path';
import { resolveApplicationResourcesRoot } from '@main/runtime-host/application-resources';
import {
  getApplicationHostPaths,
  type ApplicationHostPaths,
} from '@main/runtime-host/application-paths';

export function resolveCodexAgentDeckPluginPath(paths: ApplicationHostPaths): string {
  return join(resolveApplicationResourcesRoot(paths), 'codex-config', 'agent-deck-plugin');
}

export function getCodexAgentDeckPluginPath(): string {
  return resolveCodexAgentDeckPluginPath(getApplicationHostPaths());
}
