/**
 * 常量 — Claude SDK bridge（CHANGELOG_52 Step 3a / 第三轮大文件拆分）。
 *
 * 抽自 sdk-bridge.ts 顶部 const 段。在 3g 完成「文件迁目录」前，
 * sdk-bridge.ts 仍 import 这些常量；class state 不动。
 */

export const AGENT_ID = 'claude-code';

/**
 * 单条用户消息长度上限（102_400 字符）。超过这个就拒绝排队，让 UI 抛错给用户看到。
 * 102_400 char 已经远超合理对话长度（~25k 中文字符或 ~100k ASCII），主要是兜底「用户
 * 不小心粘了一坨二进制」或者「复制了整个日志文件」的场景。SDK / Anthropic 端再大也会
 * 按 token 计费暴涨。
 *
 * REVIEW_24 HIGH-2 follow-up（CHANGELOG_67 后续）：原是 `MAX_MESSAGE_BYTES = 100_000`
 * (byteLength)，但 `agent-deck-message-repo.ts` 的 `MAX_BODY_LENGTH = 102_400` 是 .length
 * 字符数。R3 universal-message-watcher 入队校验是 length 102_400，投递时 wireBody =
 * `[from xxx]\n` + body 长度还会增加；如果 bridge 端用 byteLength 100_000 校验，CJK /
 * 接近 ASCII 上限的 cross-adapter team message 会在 watcher 入队 OK 但 bridge 端 throw →
 * markFailed 重试 3 次都同款失败。改 `.length` 与 messageRepo 对齐，让所有 adapter
 * (claude / codex / aider / generic-pty) 的 cap 全局一致。
 *
 * Claude SDK / Anthropic API 本身没有 byte 上限，按 token 计费；102_400 char ~25k tokens
 * 远小于 200k context window，SDK 不会拒绝。
 */
export const MAX_MESSAGE_LENGTH = 102_400;

/**
 * 单会话 pendingUserMessages 队列上限。SDK 在 await canUseTool 等待用户响应时
 * 整条 query 阻塞，pendingUserMessages 不被消费；用户连发 10+ 条长 prompt 会无限累积，
 * 内存常驻一堆 SDKUserMessage 对象 + 同步落库 N 条 message 事件，
 * 等用户允许后 SDK 一次性 flush 全部 turn → token 计费暴涨。
 * 20 条已经远超合理"用户连发"场景，超过就拒绝排队，让 UI 提示先处理 pending。
 */
export const MAX_PENDING_MESSAGES = 20;

/**
 * REVIEW_11 Bug 4：read-only 工具白名单。SDK 0.2.x 注册 canUseTool 后所有工具决策都归应用，
 * 包括只读 / 元数据类工具。应用必须在 canUseTool 顶部主动放行这些工具，否则 default mode
 * 下用户会被 Read / Grep 等无害操作反复弹询问。MCP 图片读取类工具靠 `__ImageRead` 后缀匹配。
 *
 * 加白名单不依赖 permissionMode：plan / acceptEdits / bypass / default 任何模式下，
 * 这些工具语义上都不该被拦（plan mode 本意只拦 mutation；其他 mode 也只该拦危险操作）。
 *
 * **CHANGELOG_<X> B1：定义抽到 `@shared/constants/read-only-tools.ts`** 让 lead canUseTool
 * 与 teammate inbox auto-approve 共享同一份白名单（避免双处 hardcode 漂移）。
 * 新增白名单条目去 shared 文件改，本处 re-export 仅为 sdk-bridge 现有 import 路径不变。
 */
export { READ_ONLY_TOOLS } from '@shared/constants/read-only-tools';

/**
 * REVIEW_17 R3 / M3-R3：recoverAndSend 入口 emit 占位 message 的 dedup 窗口。
 * 同 sessionId 短时间内被多次 recover 触发（首次 inflight 失败 swallow + 再次
 * sendMessage 重新进 recoverAndSend）会 emit 多条「⚠ SDK 通道已断开...」噪声。
 * 5s 窗口够覆盖单飞失败到下次 sendMessage 的典型间隔。
 */
export const PLACEHOLDER_DEDUP_MS = 5_000;
