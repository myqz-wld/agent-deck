/**
 * Phase 4 Step 4.3 create-session new phase — tempKey 占位 + thread.started 等待 + realId rename。
 *
 * **触发条件**: opts.resume 空(spawn 新 codex session)。
 *
 * **执行序列**(索引线对应 facade index.ts L633-668 修前位置):
 * 1. tempKey = initialSid (顶部 validate phase allocate 出的 randomUUID)
 * 2. sessions.set(tempKey, internal) 占位等 realId
 * 3. await threadLoop.startNewThreadAndAwaitId (thread-loop fallback / success 2 处 emit
 *    first-user-message,thread.started 拿到 realId 后由 sessionManager.renameSdkSession 函数体
 *    统一 rename codexBySession + token map,plan §不变量 7)
 * 4. persistSessionFields (sandboxMode + model + extraAllowWrite,用 internal.applicationSid;
 *    plan reverse-rename-sid-stability-20260520 §A.4-pre S5 R3 HIGH-F + S9 修订:spawn 主路径
 *    first thread.started 后切到 realId 冻结,与 claude S5 修订对称)
 * 5. return { sessionId: internal.applicationSid }
 *
 * **handOff metadata**: opts.handOff 透传给 thread-loop 让 thread-loop fallback / success 2 处
 * first-user-message emit 时 spread 进 events.payload (plan §不变量 5 — codex 3 处 emit:
 * fallback / success / resume,本子段不直接 emit user message)。
 */
import { persistSessionFields } from '../session-finalize';
import { readTopLevelModelFromCodexConfig } from '@main/codex-config/toml-writer';
import { CODEX_DEFAULT_BUCKET } from '@shared/model-normalize';
import type {
  CreateSessionDeps,
  CreateSessionOpts,
  CreateSessionResult,
  PreparedContext,
  ValidateResult,
} from './_deps';

export async function runCreateSessionNewPath(
  opts: CreateSessionOpts,
  ctx: PreparedContext,
  validate: ValidateResult,
  deps: CreateSessionDeps,
): Promise<CreateSessionResult> {
  const { internal, cwd, sandboxMode } = ctx;
  // 新建路径：用 initialSid（顶部 validate phase allocate 出的 tempKey）占位，等 thread.started 事件拿到
  // realId 后 rename。plan P2 Step 2.5c：initialSid = randomUUID() 已经在顶部分配 + allocate
  // 过 token,这里直接复用,不再二次 randomUUID(避免 token / Codex 实例 / sessions Map 三处 key
  // 不一致)。realId 与 initialSid 不同时,sessionManager.renameSdkSession 函数体内(Step 2.8)
  // 统一 rename codexBySession Map + token map（不变量 7）。
  const tempKey = validate.initialSid;
  deps.sessions.set(tempKey, internal);
  await deps.threadLoop.startNewThreadAndAwaitId(
    internal,
    tempKey,
    cwd,
    opts.prompt!,
    opts.attachments,
    // plan handoff-render-and-image-batch-20260521 §Phase 2 Step 2.2 第 9 步:透传 handOff
    // 给 thread-loop 让 thread-loop fallback / success 2 处 first-user-message emit 时
    // spread 进 events.payload(详 plan §不变量 5 — codex 3 处 emit:fallback / success / resume)。
    opts.handOff,
  );

  // CHANGELOG_<X> A2a：新建路径拿到 realId 后持久化 sandboxMode + model。
  // startNewThreadAndAwaitId 内部已 emit session-start（同步派发 → ingest 创建 record），
  // 此处 persistSessionFields 紧跟 await 之后跑，UPDATE 必然命中。
  // R37 P2-E Step 3.4b：与 resume 路径同款收口（差异仅 sessionId 来源 = realId vs opts.resume）。
  // plan cross-adapter-parity-20260515 Phase A Step A.7:extraAllowWrite 同 resume 路径同款。
  // **plan reverse-rename-sid-stability-20260520 §A.4-pre S5 R3 HIGH-F + S9 修订**:
  // persistSessionFields 用 internal.applicationSid (spawn 主路径 first thread.started 后切到 realId 冻结);
  // return handle.sessionId 用 internal.applicationSid (与 claude S5 修订对称)。
  // 副作用 (sandbox / model 持久化)在 await 完成后跑;sandbox 字段同 resume path persist 字段同款。
  // ctx.sandboxMode 是 prepare phase 决定的(opts.codexSandbox > rec.codexSandbox(resume 路径) >
  // settingsStore.get('codexSandbox') 三层 fallback)。
  // plan model-token-stats §Phase 1 A4c（deep-review R1 F2 双方独立）：codex turn.completed 不带
  // model，token 统计从 sessions.model 取。新建路径 resolve effective model 持久化，避免交互式
  // codex（不显式传 model 走 ~/.codex/config.toml 默认）落 null → 全折进 unknown bucket。
  // effective = opts.model > config.toml 顶层 model > 'codex-default' 占位。**仅新建路径**做此
  // resolve（resume 路径保留 sessions.model 原值，不在此覆盖）。
  const effectiveModel =
    opts.model ?? readTopLevelModelFromCodexConfig() ?? CODEX_DEFAULT_BUCKET;
  persistSessionFields({
    sessionId: internal.applicationSid,
    sandboxMode,
    model: effectiveModel,
    modelReasoningEffort: opts.modelReasoningEffort,
    extraAllowWrite: opts.extraAllowWrite,
    // plan codex-recover-network-dirs-parity-20260602：reviewer-codex spawn-time default 持久化，
    // 让 recover / restart 读回还原 codex SDK 网络访问 + 额外可读写目录（runtime 真生效）。
    networkAccessEnabled: opts.networkAccessEnabled,
    additionalDirectories: opts.additionalDirectories,
  });

  return { sessionId: internal.applicationSid };
}
