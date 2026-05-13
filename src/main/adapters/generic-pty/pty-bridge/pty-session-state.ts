/**
 * GenericPtyBridge 共享 type 与常量（CHANGELOG_82 Step 3.1 Tier 2 拆分）。
 *
 * 拆分前是 pty-bridge.ts 顶部 const + interface 集中区；拆出独立文件后所有 sub-module
 * （lifecycle / message-io / spawn-helper / index facade）+ class 自身共享同款定义，
 * 避免双处 hardcode 漂移。
 *
 * 这里**只放无副作用** type / 常量；任何带逻辑的 helper 拆到对应 sub-module。
 */

import type { IPty } from 'node-pty';
import type { AgentEvent, GenericPtyConfig, UploadedAttachmentRef } from '@shared/types';
import type { IdleDetector, PtyOutputBuffer } from '../ansi-parser';
import type { PtyFileWatcher } from '../file-watcher';

export const ADAPTER_ID_GENERIC_PTY = 'generic-pty';
export const ADAPTER_ID_AIDER = 'aider';

/** SIGTERM 后等多久再 SIGKILL（仿 SDK fallback 等待）。 */
export const KILL_GRACE_MS = 10_000;

/**
 * 单条消息 / 首条 prompt 长度上限。
 *
 * REVIEW_24 HIGH-2：与 `agent-deck-message-repo.ts:44` 的 MAX_BODY_LENGTH (102_400 char)
 * 对齐 — universal-message-watcher 入队校验是 `body.length > MAX_BODY_LENGTH`，
 * 投递时 wireBody = `[from xxx]\n` + body 长度还会增加。如果 bridge 端用 byteLength
 * 100_000 校验（旧 R4 落地），CJK / 接近 ASCII 上限的 cross-adapter message 会在
 * watcher 入队 OK 但 bridge 端 throw → markFailed 重试 3 次都同样失败。改 `.length`
 * 与 messageRepo 对齐（PTY 写 stdin 是 char-based 不挑 byte）。
 *
 * REVIEW_24 follow-up（CHANGELOG_67 后续）：claude-code / codex-cli adapter 的
 * MAX_MESSAGE_BYTES 也已同步改成 MAX_MESSAGE_LENGTH = 102_400 全局对齐
 * （详 `claude-code/sdk-bridge/constants.ts` 与 `codex-cli/sdk-bridge/constants.ts`）。
 */
export const MAX_PROMPT_LENGTH = 102_400;

export interface PtySessionState {
  /** node-pty IPty 实例 */
  pty: IPty;
  /** 持久化的 spawn config（重启后 resume 用；当下 F2 没用 resume，留给未来） */
  config: GenericPtyConfig;
  /** sessions 表 cwd（用于 emit session-start payload） */
  cwd: string;
  /** SIGTERM 后调度的 SIGKILL timer（close 时清；session-end 时清） */
  killTimer: NodeJS.Timeout | null;
  /** 标记本 session 已被显式 close（区分 user-initiated close 与子进程自然 exit） */
  intentionallyClosed: boolean;
  /** F3：环形 buffer，保留最近 stripped stdout，给 promptSuffixRegex 二次校验用 */
  outputBuffer: PtyOutputBuffer;
  /** F3：idle 检测器；onData 时 reset、close 时 dispose */
  idleDetector: IdleDetector;
  /**
   * F3：去重 waiting-for-user emit。idle timer 触发后置 true，下次 onData 复位
   * （避免连续 idle / promptSuffix 反复 match 同一段静默生成多条 waiting-for-user 事件）。
   */
  idleEmitted: boolean;
  /** F4：cwd 文件改动 watcher；close 时必 await 关闭释放 fs handle */
  fileWatcher: PtyFileWatcher;
}

export interface GenericPtyBridgeOptions {
  /**
   * 适配器 id（注入由哪个 adapter own 本 bridge）。
   * - 'generic-pty'：用户自定义命令，要求 createSession 入参传 genericPtyConfig
   * - 'aider'：固定 'aider' preset（adapter 层兜底；用户也可在 NewSessionDialog 微调 args）
   *
   * 写入 emit 的 agentId + sessionRepo.upsert 的 agent_id；watcher 反查
   * adapterRegistry.get(agentId) 时也用此 id 找回正确 adapter。
   */
  adapterId: 'generic-pty' | 'aider';

  /**
   * 当 createSession 入参 genericPtyConfig === undefined 时的 fallback config。
   * - aider adapter 注入 GENERIC_PTY_PRESETS 里的 'aider' preset config
   * - generic-pty adapter 注入 undefined → createSession 直接 throw "missing config"
   */
  fallbackConfig: GenericPtyConfig | null;

  /** AgentEvent 派发回调（adapter init 时由 ctx.emit 注入）。 */
  emit: (event: AgentEvent) => void;
}

export interface CreatePtySessionInput {
  cwd: string;
  prompt?: string;
  /** 可选用户配置；undefined → 用 bridge.fallbackConfig（aider）；null → throw（generic-pty） */
  genericPtyConfig?: GenericPtyConfig;
  /** 与其他 adapter 接口对齐；PTY 不支持 attachments（无概念），传了静默忽略 */
  attachments?: UploadedAttachmentRef[];
}
