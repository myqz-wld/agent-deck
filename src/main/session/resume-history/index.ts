/**
 * `resume-history/` — resume/fallback 历史注入共享层（plan resume-inject-raw-messages-20260601）。
 *
 * adapter 无关：claude / codex fallback 都 import 本层 `injectResumeHistory` 拼「总结段 +
 * 原始消息段 + 当前消息」三段结构化文本（§D9 解耦靠 maxLength 参数化，不删 cap）。
 *
 * 详 inject-history.ts 顶部 jsdoc（§架构地基 + 不变量 + 降级链）。
 */
export {
  injectResumeHistory,
  type InjectResumeHistoryOptions,
  type PrependResult,
  type PrependFailReason,
} from './inject-history';
export {
  buildRestartResumePrompt,
  type BuildRestartResumePromptOptions,
} from './restart-prompt';
