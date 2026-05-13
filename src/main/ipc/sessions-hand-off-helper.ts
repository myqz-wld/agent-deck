/**
 * Hand-off SDK session 创建 opts 拼装 helper（REVIEW_33 H6）。
 *
 * 抽到独立 file 是为了让 unit test 可以纯 import 不触发 sessions.ts 的 Electron / IPC
 * register 副作用链（sessions.ts import 链含 sessionManager / sessionRepo /
 * eventBus 等 Electron 依赖，单测 import 整个 module 会拉起 Electron 加载报错）。
 *
 * 关键决策：与原 session 完全对齐 cwd / permissionMode / codexSandbox / claudeCodeSandbox
 * 四字段（前三个 H6 修前漏，导致用户切到 read-only 后 hand-off 起的新 session 落
 * settings 全局默认 = 隐性沙盒 downgrade）。条件透传规则与 permissionMode 对称：
 * 字段为 null/undefined 时不写 opts → adapter 收到 undefined 走 settings 全局值
 * fallback（保持 codex-cli / claude-code adapter 既有行为）。
 */
import type { SessionRecord } from '@shared/types';
import type { CreateSessionOptions } from '@main/adapters/types';

export function buildHandOffCreateSessionOpts(
  session: SessionRecord,
  finalPrompt: string,
): CreateSessionOptions {
  return {
    cwd: session.cwd,
    prompt: finalPrompt,
    ...(session.permissionMode ? { permissionMode: session.permissionMode } : {}),
    ...(session.codexSandbox ? { codexSandbox: session.codexSandbox } : {}),
    ...(session.claudeCodeSandbox ? { claudeCodeSandbox: session.claudeCodeSandbox } : {}),
  };
}
