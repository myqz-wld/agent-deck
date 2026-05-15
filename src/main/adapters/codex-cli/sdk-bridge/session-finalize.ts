/**
 * createSession 拿到 realId 之后的字段持久化收口（R37 P2-E Step 3.4b）。
 *
 * 抽自 ClaudeSdkBridge → CodexSdkBridge index.ts createSession 两路（resume + 新建）
 * 字面镜像的 setCodexSandbox + setModel + warn 模板。两路都需要在拿到 thread sessionId
 * 之后把 sandboxMode + model 持久化到 sessions 表，且 model 持久化必须配 codex 专属的
 * 「runtime 不生效」warn 提示（plan model-wiring-and-handoff-20260514 D5）。
 *
 * 与 claude `session-finalize.ts` 抽法**有差异**：
 * - claude 一路（新建）需要全 finalize（emit session-start + setSandbox + setModel + emit user message）
 * - codex 两路 finalize 步骤不同：
 *   - resume 路径：emit session-start + setSandbox + setModel + emit user message + 起 turn loop
 *   - 新建路径：startNewThreadAndAwaitId 内已 emit session-start + emit user message，外部只补 setSandbox + setModel
 *
 *   两路共性只有 setSandbox + setModel + warn 三步，emit / runTurnLoop 不在共性里 — 强行
 *   atomic helper 反而让 facade 失去对各路径序列的控制权。
 *
 * 本 helper 只收口共性三步，emit / runTurnLoop 仍由 facade 显式调用，与 claude 同模式
 * （claude finalizeSessionStart 也只管 emit + setSandbox + setModel + emit user message 这一段）。
 *
 * 行为零变化：抽出前后字面 try/catch + console.warn 一致。
 */
import { sessionRepo } from '@main/store/session-repo';

export interface PersistSessionFieldsArgs {
  /** thread sessionId（resume 路径 = opts.resume；新建路径 = startNewThreadAndAwaitId 拿到的 realId） */
  sessionId: string;
  /** 解析后的 sandboxMode（已通过 opts.codexSandbox > sessionRepo > settingsStore 三级 fallback） */
  sandboxMode: 'workspace-write' | 'read-only' | 'danger-full-access';
  /**
   * plan model-wiring-and-handoff-20260514 Step 2.5：opts.model 透传值。
   * undefined → 跳过持久化（保留 sessions.model 原值，resume 路径下保持原 model）；
   * 非 undefined → setModel 写入 + 触发 codex 专属 runtime-not-effective warn 提示。
   */
  model?: string;
  /**
   * plan cross-adapter-parity-20260515 Phase A Step A.7 / REVIEW_40 R1 reviewer-codex MED-F:
   * caller 透传的 SDK sandbox 额外可写根。**codex SDK 不消费 extra writable roots**
   * (sandboxMode 只接 'workspace-write' / 'read-only' / 'danger-full-access' 三档),
   * 但本字段仍持久化到 sessions.extra_allow_write 保跨 adapter parity 对称(让 SessionRecord
   * 字段在 claude / codex 之间形态一致 + future codex SDK 加支持时零迁移成本)。
   *
   * undefined / 空数组 → 跳过持久化(保留 sessions.extra_allow_write 原值)。非空数组 →
   * setExtraAllowWrite 写入 + warn 提示 codex runtime 不消费(同 model warn 模式)。
   */
  extraAllowWrite?: readonly string[];
}

/**
 * 持久化 sandboxMode + model 字段，配 codex 专属的「model 持久化但 runtime 不生效」warn 提示。
 *
 * try/catch 兜底：DB 异常不阻塞会话启动（最坏情况字段没存，下次会话退化默认）。
 * console.warn：失败时透出错误，与 claude session-finalize 同款诊断模式。
 */
export function persistSessionFields(args: PersistSessionFieldsArgs): void {
  const { sessionId, sandboxMode, model, extraAllowWrite } = args;

  // 1. 持久化 sandbox 档位（CHANGELOG_<X> A2a）
  try {
    sessionRepo.setCodexSandbox(sessionId, sandboxMode);
  } catch (err) {
    console.warn(`[codex-bridge] setCodexSandbox(${sessionId}, ${sandboxMode}) 失败`, err);
  }

  // 2. plan model-wiring-and-handoff-20260514 Step 2.5：opts.model 持久化（D5：runtime 不生效，
  // codex CLI runtime model 由 ~/.codex/config.toml 顶层 `model` 决定；本字段仅记账让 UI
  // 显示 frontmatter 意图）。配合下方 warn 提示用户改 toml 才真正切 model。
  if (model) {
    try {
      sessionRepo.setModel(sessionId, model);
    } catch (err) {
      console.warn(`[codex-bridge] setModel(${sessionId}, ${model}) 失败`, err);
    }
    console.warn(
      `[codex-bridge] frontmatter model="${model}" 仅持久化未生效：codex SDK 不接受` +
        ` per-thread model override，runtime model 由 ~/.codex/config.toml 顶层 \`model\` 字段决定。`,
    );
  }

  // 3. plan cross-adapter-parity-20260515 Phase A Step A.7 / REVIEW_40 R1 MED-F:
  // opts.extraAllowWrite 持久化(parity 对称写库,runtime 不生效 — codex SDK 不接受 extra
  // writable roots 字段,sandboxMode 三档只控制根 sandbox profile)。配合下方 warn 提示。
  if (extraAllowWrite !== undefined && extraAllowWrite.length > 0) {
    try {
      // setExtraAllowWrite 接 string[] | null,readonly string[] 转 mutable copy
      sessionRepo.setExtraAllowWrite(sessionId, [...extraAllowWrite]);
    } catch (err) {
      console.warn(
        `[codex-bridge] setExtraAllowWrite(${sessionId}, [${extraAllowWrite.join(', ')}]) 失败`,
        err,
      );
    }
    console.warn(
      `[codex-bridge] extraAllowWrite=[${extraAllowWrite.join(', ')}] 仅持久化未生效:` +
        ` codex SDK 不支持 extra writable roots,sandboxMode 三档(workspace-write / read-only /` +
        ` danger-full-access)只控根 sandbox profile。本字段持久化保跨 adapter parity 对称。`,
    );
  }
}
