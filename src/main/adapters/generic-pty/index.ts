import type { AgentAdapter, AdapterContext } from '../types';

/**
 * Generic PTY 适配器（占位）。
 *
 * 实现指引：
 * - 用 node-pty 包裹任意 CLI（用户可自定义命令），通过 ANSI 解析与 idle 检测推断状态
 * - 配合用户提供的正则规则识别「等待输入」「完成」等事件
 * - 文件改动通过监听 cwd 下的 fs 变更（chokidar）+ git diff 推断
 */
export const genericPtyAdapter: AgentAdapter = {
  id: 'generic-pty',
  displayName: 'Generic PTY',
  capabilities: {
    canCreateSession: false,
    canInterrupt: false,
    canSendMessage: false,
    canInstallHooks: false,
    canRespondPermission: false,
    canSetPermissionMode: false,
    canRestartWithPermissionMode: false,
    canCloseSession: false,
  },
  async init(_ctx: AdapterContext): Promise<void> {
    // intentionally empty
  },
  async shutdown(): Promise<void> {
    // intentionally empty
  },
};
