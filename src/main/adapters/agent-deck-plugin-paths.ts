/**
 * adapter-aware dispatcher：按 adapter id 路由到对应 agent-deck plugin 根路径。
 *
 * 调用场景：
 * - `src/main/bundled-assets.ts` loadBundledAssets() 双 root scan（plan §P3 Step 3.3）
 * - `src/main/agent-deck-mcp/tools/handlers/spawn.ts` agent_name 按 adapter 路由（plan §D4 / §P3 Step 3.4）
 * - 其他需要按 adapter 动态拿 plugin 路径的位置
 *
 * 受支持 adapter：仅 'claude-code' / 'codex-cli'。aider / generic-pty 无 plugin 注入概念
 * （aider 走 .aider.conf.yml、generic-pty 直接 spawn 不含 SDK），故 signature 限两值。
 */
import { getClaudeAgentDeckPluginPath } from './claude-code/sdk-injection';
import { getCodexAgentDeckPluginPath } from './codex-cli/codex-config-paths';

export function getAgentDeckPluginPathForAdapter(adapter: 'claude-code' | 'codex-cli'): string {
  switch (adapter) {
    case 'claude-code':
      return getClaudeAgentDeckPluginPath();
    case 'codex-cli':
      return getCodexAgentDeckPluginPath();
    default: {
      const _exhaustive: never = adapter;
      throw new Error(`unsupported adapter for plugin path: ${String(_exhaustive)}`);
    }
  }
}
