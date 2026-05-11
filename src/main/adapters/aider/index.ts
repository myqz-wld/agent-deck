import type { AgentAdapter, AdapterContext } from '../types';

/**
 * Aider 适配器（占位）。
 *
 * 实现指引：
 * - Aider 支持 --message-file 和 hooks（`/run` 命令）；考虑通过 fifo 或临时文件桥接
 * - 监听 Aider 的 ".aider.input.history" 与会话日志推断状态
 */
export const aiderAdapter: AgentAdapter = {
  id: 'aider',
  displayName: 'Aider',
  capabilities: {
    canCreateSession: false,
    canInterrupt: false,
    canSendMessage: false,
    canInstallHooks: false,
    canRespondPermission: false,
    canSetPermissionMode: false,
    canRestartWithPermissionMode: false,
    canRestartWithCodexSandbox: false,
    canCloseSession: false,
    // R3.E4 占位 false：F 阶段实装 receiveTeammateMessage（aider --message-file 路径）后改 true
    canCollaborate: false,
  },
  async init(_ctx: AdapterContext): Promise<void> {
    // intentionally empty
  },
  async shutdown(): Promise<void> {
    // intentionally empty
  },
};
