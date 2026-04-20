import type { AgentAdapter, AdapterContext } from '../types';

/**
 * Codex CLI 适配器（占位）。
 *
 * 实现指引（后续填充）：
 * - 通过 spawn 启动 `codex` CLI，监听 stdout/stderr
 * - 用正则或 JSON 解析识别会话边界、文件改动、等待状态
 * - 文件改动可结合 `git diff` 派生 before/after
 *
 * 当前 init/shutdown 为空，不会出现在 UI 中（adapter UI 会基于 capabilities 过滤）。
 */
export const codexCliAdapter: AgentAdapter = {
  id: 'codex-cli',
  displayName: 'Codex CLI',
  capabilities: {
    canCreateSession: false,
    canInterrupt: false,
    canSendMessage: false,
    canInstallHooks: false,
    canRespondPermission: false,
    canSetPermissionMode: false,
  },
  async init(_ctx: AdapterContext): Promise<void> {
    // intentionally empty
  },
  async shutdown(): Promise<void> {
    // intentionally empty
  },
};
