/**
 * createSession 拿到 realId 之后的字段持久化收口（R37 P2-E Step 3.4b）。
 *
 * 抽自 ClaudeSdkBridge → CodexSdkBridge index.ts createSession 两路（resume + 新建）
 * 字面镜像的 setCodexSandbox + setModel 模板。两路都需要在拿到 thread sessionId
 * 之后把 sandboxMode + model 持久化到 sessions 表。
 *
 * **prompt-asset-review-optimize-20260527 修订**:Codex runtime v0.131.0+ ThreadOptions.model 已支持
 * per-thread override → bridge.createSession 已 spread `opts.model` 进 ThreadOptions runtime
 * 真生效;本 helper 仅负责 setModel 持久化让 UI / resume / dormant 唤醒一致(原 D5 "runtime 不生效"
 * warn 模板已删,过期判断已过)。
 *
 * 与 claude `session-finalize.ts` 抽法**有差异**：
 * - claude 一路（新建）需要全 finalize（emit session-start + setSandbox + setModel + emit user message）
 * - codex 两路 finalize 步骤不同：
 *   - resume 路径：emit session-start + setSandbox + setModel + emit user message + 起 turn loop
 *   - 新建路径：create-session-new 先 emit temp session-start + user message，补 setSandbox + setModel；
 *     startNewThreadAndAwaitId 后台拿 realId 后只 rename / fallback error
 *
 *   两路共性只有 setSandbox + setModel 两步，emit / runTurnLoop 不在共性里 — 强行
 *   atomic helper 反而让 facade 失去对各路径序列的控制权。
 *
 * 本 helper 只收口共性两步，emit / runTurnLoop 仍由 facade 显式调用，与 claude 同模式
 * （claude finalizeSessionStart 也只管 emit + setSandbox + setModel + emit user message 这一段）。
 *
 * 行为零变化：抽出前后字面 try/catch + console.warn 一致。
 */
import { sessionRepo } from '@main/store/session-repo';
import { eventBus } from '@main/event-bus';
import type { CodexThinkingLevel } from '@shared/session-metadata';
import log from '@main/utils/logger';

const logger = log.scope('codex-finalize');

export interface PersistSessionFieldsArgs {
  /** thread sessionId（resume 路径 = opts.resume；新建路径先写 tempKey，后台 rename 到 realId） */
  sessionId: string;
  /** 解析后的 sandboxMode（已通过 opts.codexSandbox > sessionRepo > settingsStore 三级 fallback） */
  sandboxMode: 'workspace-write' | 'read-only' | 'danger-full-access';
  /** Native Codex model_provider; undefined preserves an existing session value. */
  provider?: string;
  /**
   * plan model-wiring-and-handoff-20260514 Step 2.5 + prompt-asset-review-optimize-20260527 修订:
   * opts.model 透传值(Codex runtime v0.131.0+ ThreadOptions.model 已支持 per-thread override,
   * bridge.createSession 已 spread runtime 真生效)。
   * undefined → 跳过持久化(保留 sessions.model 原值,resume 路径下保持原 model);
   * 非 undefined → setModel 持久化到 sessions.model,让 UI / resume / dormant 唤醒一致
   * (本 helper 仅负责持久化,runtime 切换由 bridge.createSession 透传 ThreadOptions.model 完成;
   * 原 codex 专属 runtime-not-effective warn 提示已删 — 字段对 runtime 真生效不再是 dead config)。
   */
  model?: string;
  /** Codex app-server ThreadOptions.modelReasoningEffort value to persist for resume/display. */
  modelReasoningEffort?: CodexThinkingLevel;
  /**
   * plan cross-adapter-parity-20260515 Phase A Step A.7 / REVIEW_40 R1 reviewer-codex MED-F:
   * caller 透传的 SDK sandbox 额外可写根。**codex SDK 不消费 extra writable roots**
   * (sandboxMode 只接 'workspace-write' / 'read-only' / 'danger-full-access' 三档),
   * 但本字段仍持久化到 sessions.extra_allow_write 保跨 adapter parity 对称(让 SessionRecord
   * 字段在 claude / codex 之间形态一致 + future codex SDK 加支持时零迁移成本)。
   *
   * undefined / 空数组 → 跳过持久化(保留 sessions.extra_allow_write 原值)。非空数组 →
   * setExtraAllowWrite 写入 + warn 提示 codex runtime 不消费 extra writable roots(本字段
   * 与 model 字段已不同款:model 字段 Codex runtime v0.131.0+ ThreadOptions.model 已支持
   * runtime 真生效,extraAllowWrite 仍未生效)。
   */
  extraAllowWrite?: readonly string[];
  /**
   * plan codex-recover-network-dirs-parity-20260602：reviewer-codex spawn 时 options-builder
   * 注入的 `networkAccessEnabled` reviewer runtime default。**与 extraAllowWrite 关键区别：codex SDK
   * runtime 真消费**（经 buildCodexThreadOptions → startThread/resumeThread 的
   * ThreadOptions.networkAccessEnabled），持久化是为了 recover / restart 路径读回还原 reviewer
   * 网络访问能力 —— **不是** extraAllowWrite 那种 persist-only no-op，故下方写入**不打 warn**。
   *
   * undefined → 跳过持久化（保留原值）；**用 `!== undefined` 不用 truthy** —— `false` 是合法值
   * （非 reviewer caller 显式关网络），truthy guard 会漏掉显式 false。
   */
  networkAccessEnabled?: boolean;
  /**
   * plan codex-recover-network-dirs-parity-20260602：reviewer-codex spawn 时 options-builder
   * 注入的 `additionalDirectories` reviewer runtime default。**codex SDK runtime 真消费**（经
   * buildCodexThreadOptions → startThread/resumeThread 的 ThreadOptions.additionalDirectories
   * 把这些根加入当前 sandbox 可访问范围），持久化为 recover / restart 还原跨目录访问能力。
   * 与 extraAllowWrite 不同（那个 codex 不消费），故写入**不打 warn**。
   *
   * undefined / 空数组 → 跳过持久化（保留原值）。非空数组 → setAdditionalDirectories 写入。
   */
  additionalDirectories?: readonly string[];
}

/**
 * 持久化 sandboxMode + model 字段(prompt-asset-review-optimize-20260527 修订:Codex runtime
 * v0.131.0+ ThreadOptions.model 已支持 per-thread override → bridge.createSession 已 spread
 * 进 ThreadOptions runtime 真生效;本 helper 仅 setModel 持久化让 resume / UI / dormant 唤醒
 * 一致,原 codex 专属 "runtime 不生效" warn 提示已删)。
 *
 * try/catch 兜底：DB 异常不阻塞会话启动（最坏情况字段没存，下次会话退化默认）。
 * console.warn：失败时透出错误，与 claude session-finalize 同款诊断模式。
 */
export function persistSessionFields(args: PersistSessionFieldsArgs): void {
  const { sessionId, sandboxMode, provider, model, modelReasoningEffort, extraAllowWrite, networkAccessEnabled, additionalDirectories } =
    args;

  // 1. 持久化 sandbox 档位（CHANGELOG_<X> A2a）
  try {
    sessionRepo.setCodexSandbox(sessionId, sandboxMode);
  } catch (err) {
    logger.warn(`[codex-bridge] setCodexSandbox(${sessionId}, ${sandboxMode}) 失败`, err);
  }

  if (provider !== undefined) {
    try {
      sessionRepo.setRuntimeProvider(sessionId, provider);
    } catch (err) {
      logger.warn(
        `[codex-bridge] setRuntimeProvider(${sessionId}, ${provider}) 失败`,
        err,
      );
    }
  }

  // 2. plan model-wiring-and-handoff-20260514 Step 2.5 + prompt-asset-review-optimize-20260527 修订:
  // opts.model 持久化(setModel)让 UI / resume / DB 与 frontmatter 一致。Codex runtime v0.131.0
  // ThreadOptions.model 已支持 per-thread override — runtime model 由 sdk-bridge.index.ts
  // startThread/resumeThread 透传字段真生效(不再需要原 D5 warn,frontmatter model 不再是 dead config)。
  if (model) {
    try {
      sessionRepo.setModel(sessionId, model);
    } catch (err) {
      logger.warn(`[codex-bridge] setModel(${sessionId}, ${model}) 失败`, err);
    }
  }

  if (modelReasoningEffort !== undefined) {
    try {
      sessionRepo.setThinking(sessionId, modelReasoningEffort);
    } catch (err) {
      logger.warn(
        `[codex-bridge] setThinking(${sessionId}, ${modelReasoningEffort}) 失败`,
        err,
      );
    }
  }

  // 3. plan cross-adapter-parity-20260515 Phase A Step A.7 / REVIEW_40 R1 MED-F:
  // opts.extraAllowWrite 持久化(parity 对称写库,runtime 不生效 — codex SDK 不接受 extra
  // writable roots 字段,sandboxMode 三档只控制根 sandbox profile)。配合下方 warn 提示。
  if (extraAllowWrite !== undefined && extraAllowWrite.length > 0) {
    try {
      // setExtraAllowWrite 接 string[] | null,readonly string[] 转 mutable copy
      sessionRepo.setExtraAllowWrite(sessionId, [...extraAllowWrite]);
    } catch (err) {
      logger.warn(
        `[codex-bridge] setExtraAllowWrite(${sessionId}, [${extraAllowWrite.join(', ')}]) 失败`,
        err,
      );
    }
    logger.warn(
      `[codex-bridge] extraAllowWrite=[${extraAllowWrite.join(', ')}] 仅持久化未生效:` +
        ` codex SDK 不支持 extra writable roots,sandboxMode 三档(workspace-write / read-only /` +
        ` danger-full-access)只控根 sandbox profile。本字段持久化保跨 adapter parity 对称。`,
    );
  }

  // 4. plan codex-recover-network-dirs-parity-20260602：networkAccessEnabled 持久化。
  // **与 extraAllowWrite 不同：codex SDK runtime 真消费**（buildCodexThreadOptions →
  // startThread/resumeThread），故**不打 warn**（同 setModel）。**用 `!== undefined` 不用 truthy** —
  // false 是合法值（非 reviewer caller 显式关网络），truthy guard 会漏掉显式 false。
  if (networkAccessEnabled !== undefined) {
    try {
      sessionRepo.setNetworkAccessEnabled(sessionId, networkAccessEnabled);
    } catch (err) {
      logger.warn(
        `[codex-bridge] setNetworkAccessEnabled(${sessionId}, ${networkAccessEnabled}) 失败`,
        err,
      );
    }
  }

  // 5. plan codex-recover-network-dirs-parity-20260602：additionalDirectories 持久化。
  // **codex SDK runtime 真消费**（同上），不打 warn。空数组跳过（同 extraAllowWrite guard）。
  if (additionalDirectories !== undefined && additionalDirectories.length > 0) {
    try {
      sessionRepo.setAdditionalDirectories(sessionId, [...additionalDirectories]);
    } catch (err) {
      logger.warn(
        `[codex-bridge] setAdditionalDirectories(${sessionId}, [${additionalDirectories.join(', ')}]) 失败`,
        err,
      );
    }
  }

  emitPersistedSessionFields(sessionId);
}

function emitPersistedSessionFields(sessionId: string): void {
  try {
    const updated = sessionRepo.get(sessionId);
    if (updated) eventBus.emit('session-upserted', updated);
  } catch (err) {
    logger.warn(
      `[codex-bridge] emit session-upserted after persistSessionFields(${sessionId}) 失败`,
      err,
    );
  }
}
