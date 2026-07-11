/**
 * 常量 — Codex SDK bridge（CHANGELOG_52 Step 4a / 第三轮大文件拆分）。
 *
 * 抽自 codex-cli/sdk-bridge.ts 顶部 const 段。在 4c 完成「文件迁目录」前，
 * sdk-bridge.ts 仍 import 这些常量；class state 不动。
 */

export const AGENT_ID = 'codex-cli';

/**
 * 单条用户消息长度上限（102_400 字符，与 claude-code + agent-deck-message-repo 全局对齐）。
 *
 * REVIEW_24 HIGH-2 follow-up：原是 `MAX_MESSAGE_BYTES = 100_000` (byteLength)，详
 * `claude-code/sdk-bridge/constants.ts` 同款注释。
 */
export { MAX_USER_MESSAGE_LENGTH as MAX_MESSAGE_LENGTH } from '@shared/message-limits';

/** 单会话 pendingMessages 队列上限（与 claude-code 对齐：20 条）。 */
export const MAX_PENDING_MESSAGES = 20;

/** 30 秒未拿到 thread.started 事件就 fallback：避免 createSession 永远 hang。 */
export const THREAD_STARTED_FALLBACK_MS = 30_000;
