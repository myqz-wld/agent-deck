/**
 * Phase 4 Step 4.3 create-session orchestrator — facade.createSession 主体的薄壳。
 *
 * **职责边界**:
 * - validate phase **同步执行**(try block 之前)— throw 不走 rollback (token 未 allocate)
 * - prepare phase **inline 在本 orchestrator**(cwd / sandbox / thread 准备 — 不单独抽子段,
 *   user 选 validate/resume/new 3 子段不含 prepare,这部分留在 orchestrator 内紧贴 try 头)
 * - resume / new path dispatch — `opts.resume` 决定走哪条 sub-fn
 * - catch phase 跑 runCreateSessionRollback (4 资源 best-effort cleanup,REVIEW_60 R4 §B 抽法 #3)
 *
 * **REVIEW_60 MED-codex-2 修法**(reviewer-codex R1 MED 单方 finding + lead 验证):
 * 旧 bug: createSession 整个函数体无顶层 try/catch,allocate 之后任何 throw 都让
 * token + (可能已 set 的) codex 实例 + (可能已 set 的) sessions Map entry + sdkClaim 全
 * 泄漏。具体路径:
 *   1. ensureCodex throw (new CodexAppServerClient throw 等)
 *   2. resumeThread/startThread sync throw (Codex app-server 参数校验失败 / 拿不到 thread id 等)
 *   3. await thread-loop.runTurnLoop (resume path inner Promise) 在 thread-loop earlyErrCb
 *      cleanup 已含双轨,但本 catch 走 best-effort 重复 cleanup (idempotent: tokenMap.release
 *      / codexBySession.delete / sessions.delete / releaseSdkClaim 全是 no-op 安全) 加固
 *   4. new path: startNewThreadAndAwaitId await throw — thread-loop 内部 fallback 已 cleanup,
 *      本 catch 同款 best-effort 加固
 * 对称 claude createSession (sdk-bridge/index.ts:31-165) try/catch 收口模板。
 *
 * **REVIEW_56 HIGH-1 修法 — facade 必须消费 opts.resumeMode + opts.resumeCliSid**:
 * recoverer (recoverer.ts:344 + 370) / restart-controller (line 132) 已显式传出这两个字段,
 * 但本 facade 修前漏接(只看 opts.resume),导致:
 *  1) jsonl-missing fallback 路径(resumeMode='fresh-cli-reuse-app') 仍 resumeThread →
 *     SDK 抛 jsonl 不存在错(预检漏判时进一步死链)
 *  2) 反向 rename 后 cliSessionId !== applicationSid 时 SDK 拿 applicationSid 调
 *     resumeThread → 找不到正确 jsonl → 历史失。
 * 修后:
 *  - effectiveResumeThreadId = opts.resume && resumeMode !== 'fresh-cli-reuse-app'
 *      ? (opts.resumeCliSid ?? sessionRepo.cliSessionId ?? opts.resume)  // 与 claude
 *         facade index.ts:332-335 同款 3 层兜底:caller 显式 > sessionRepo 中间层 >
 *         applicationSid 末层(REVIEW_56 R2 reviewer-claude MED-Cross-Adapter-Parity 修法,
 *         保 cross-adapter 设计对称 + 防 future caller 漏传 silently fall back 到
 *         applicationSid 在反向 rename 后 != cliSessionId 时撞错 thread)
 *      : null                                  // fresh thread / spawn 主路径
 *  - effectiveResumeThreadId 非空 → resumeThread, 否则 startThread (jsonl-missing fallback
 *    自然走 startThread + applicationSid 不变,first thread.started 进 thread-loop case 3
 *    fork-detect 路径 updateCliSessionId 完成反向 rename)。
 * internal.threadId 初值 = effectiveResumeThreadId ?? opts.resume(REVIEW_79 MED-1 修法,见
 * internal 构造处注释):
 *  - normal resume after fallback: threadId = cli-sid(effectiveResumeThreadId)→ SDK 返同 cli-sid
 *    → thread-loop case 2 正常分支(修前用 applicationSid 误触 case 3 fork-detect)
 *  - fresh-cli-reuse-app: effectiveResumeThreadId=null → threadId = opts.resume(applicationSid),
 *    SDK startThread 返新 thread_id 与 applicationSid 不一致 → thread-loop case 3 (line 292)
 *    通过 ev.thread_id !== internal.threadId 触发 fork-detect → updateCliSessionId 把
 *    cli_session_id 列改成 SDK 真 thread_id;applicationSid (sessions.id) 不动 (不变量 1)。
 */
import { sessionRepo } from '@main/store/session-repo';
import { settingsStore } from '@main/store/settings-store';
import { getAgentDeckCodexDeveloperInstructions } from '@main/codex-config/agents-md-installer';
import { resolveSpawnCwd } from '@main/utils/cwd-resolver';
import { packCodexInput } from '../input-pack';
import { buildCodexThreadOptions } from '../thread-options-builder';
import { runCreateSessionRollback } from '../create-session-rollback';
import type { InternalSession } from '../types';
import type { CodexAppServerThread } from '../../app-server/client';
import { validateCreateSessionOpts } from './create-session-validate';
import { runCreateSessionResumePath } from './create-session-resume';
import { runCreateSessionNewPath } from './create-session-new';
import { readTopLevelModelReasoningEffortFromCodexConfig } from '@main/codex-config/toml-writer';
import { resolveCodexReasoningEffort } from './reasoning-effort-resolve';
import type {
  CreateSessionDeps,
  CreateSessionOpts,
  CreateSessionResult,
  PreparedContext,
} from './_deps';

export async function createSessionImpl(
  opts: CreateSessionOpts,
  deps: CreateSessionDeps,
): Promise<CreateSessionResult> {
  // validate phase: prompt empty / cap check + sid 分配 + token allocate (同步执行,throw 跳出
  // 不进 try block — token 未 allocate 无需 rollback)
  const validate = validateCreateSessionOpts(opts);
  const { initialSid, sessionToken } = validate;

  try {
    // prepare phase: codex 实例 + cwd + sandboxMode + thread + internal session record。
    // 不抽子段(user mini-spike confirm 3 子段 validate/resume/new 不含 prepare),inline 在
    // orchestrator try 头紧贴 dispatch 之前 — 让 prepare 失败走 catch 触发 rollback。
    //
    // plan §P3 Step 3.5: 透传 envOverrideExtra（generic 透传机制,目前无 hot caller）到
    // ensureCodex,让 codex 子进程 env merge extra 字段。
    const codex = await deps.ensureCodex(initialSid, sessionToken, opts.envOverrideExtra);
    const cwd = resolveSpawnCwd(opts);
    // CHANGELOG_<X> A2a：codexSandbox 优先级（高 → 低）：
    // 1. opts.codexSandbox（NewSessionDialog / IPC / cli.ts 显式传入，最新意图）
    // 2. resume 路径下 sessionRepo.get(resume).codexSandbox（用户上次该会话选过的，重启应用后回放）
    // 3. settingsStore.get('codexSandbox')（settings 全局值兜底）
    //
    // symmetry-plan P2 MED-B：从 `bridge.currentSandboxMode` field 改为直接 settingsStore 读
    // — 与 claude-code adapter sandbox-resolve.ts 同款直读模式（删 in-memory mirror + setter
    // + apply hook 三层冗余）。settings 改 codexSandbox 不需 push 到 bridge,下次 createSession
    // 即按新值生效（与 claude 同款语义,spawn-time 锁定不变）。
    //
    // REVIEW_79 INFO (reviewer-claude) 修法:同一 row 单读复用。修前 persistedSandbox(取
    // .codexSandbox) 与 effectiveResumeThreadId(取 .cliSessionId) 各调一次 sessionRepo.get(opts.resume)
    // 同步读同一行(两读间无 await,better-sqlite3 同步单线程值一致无 race,纯冗余)。
    const resumeRec = opts.resume ? sessionRepo.get(opts.resume) : null;
    const persistedSandbox = resumeRec?.codexSandbox ?? null;
    const sandboxMode =
      opts.codexSandbox ?? persistedSandbox ?? settingsStore.get('codexSandbox');
    const hasReasoningConfigLayer =
      opts.codexConfigOverrides !== undefined &&
      (Object.prototype.hasOwnProperty.call(opts.codexConfigOverrides, 'profile') ||
        Object.prototype.hasOwnProperty.call(
          opts.codexConfigOverrides,
          'model_reasoning_effort',
        ));
    const {
      sessionValue: sessionModelReasoningEffort,
      threadValue: threadModelReasoningEffort,
    } = resolveCodexReasoningEffort({
      explicit: opts.modelReasoningEffort,
      isResume: opts.resume !== undefined,
      persisted: resumeRec?.thinking,
      hasLayerOverride: hasReasoningConfigLayer,
      readConfigured: readTopLevelModelReasoningEffortFromCodexConfig,
    });
    const effectiveOpts =
      sessionModelReasoningEffort === opts.modelReasoningEffort
        ? opts
        : { ...opts, modelReasoningEffort: sessionModelReasoningEffort };
    const developerInstructions = combineDeveloperInstructions(
      getAgentDeckCodexDeveloperInstructions(),
      opts.developerInstructions,
    );

    let thread: CodexAppServerThread;
    // effectiveResumeThreadId 3 层兜底:caller 显式 > sessionRepo cliSessionId 中间层 >
    // applicationSid 末层。REVIEW_56 R2 reviewer-claude MED-Cross-Adapter-Parity 修法,
    // 保 cross-adapter 设计对称 + 防 future caller 漏传 silently fall back 到 applicationSid
    // 在反向 rename 后 != cliSessionId 时撞错 thread。详 orchestrator jsdoc 顶部 REVIEW_56 HIGH-1。
    const effectiveResumeThreadId =
      opts.resume && opts.resumeMode !== 'fresh-cli-reuse-app'
        ? (opts.resumeCliSid ?? resumeRec?.cliSessionId ?? opts.resume)
        : null;
    if (effectiveResumeThreadId) {
      // CHANGELOG_<X> A2a：resume 路径必须透传 sandboxMode / workingDirectory / approvalPolicy，
      // 否则 codex SDK 默认行为 = 不传 --sandbox flag，让 codex CLI 用 ~/.codex/config.toml 全局
      // 默认 / read-only 兜底，丢失用户上次该会话选过的档位（spike-A2 实测验证 SDK
      // resumeThread(id, options) 透传到每次 turn 的 CLI args）。
      //
      // plan §P3 Step 3.5 + §不变量 6: 3 个新字段（approvalPolicy / networkAccessEnabled /
      // additionalDirectories）从 opts 读，bridge **不主动 enforce default**。caller 缺省 →
      // approvalPolicy 沿用 'never'（现状）；networkAccessEnabled / additionalDirectories
      // 不写字段（codex SDK 走 ThreadOptions 默认）。options-builder 在 reviewer-* 路径下
      // 已 spread reviewer runtime defaults（approvalPolicy / networkAccessEnabled /
      // additionalDirectories）,这里直接透传不影响普通 codex session lead 路径。
      thread = codex.resumeThread(
        effectiveResumeThreadId,
        buildCodexThreadOptions({
          workingDirectory: cwd,
          sandboxMode,
          approvalPolicy: opts.approvalPolicy,
          model: opts.model,
          modelReasoningEffort: threadModelReasoningEffort,
          developerInstructions,
          configOverrides: opts.codexConfigOverrides,
          networkAccessEnabled: opts.networkAccessEnabled,
          additionalDirectories: opts.additionalDirectories,
        }),
      );
    } else {
      thread = codex.startThread(
        buildCodexThreadOptions({
          workingDirectory: cwd,
          sandboxMode,
          approvalPolicy: opts.approvalPolicy,
          model: opts.model,
          modelReasoningEffort: threadModelReasoningEffort,
          developerInstructions,
          configOverrides: opts.codexConfigOverrides,
          networkAccessEnabled: opts.networkAccessEnabled,
          additionalDirectories: opts.additionalDirectories,
        }),
      );
    }

    const firstInput = opts.resumeOnly ? null : packCodexInput(opts.prompt!, opts.attachments);
    // **plan reverse-rename-sid-stability-20260520 §A.4-pre S2 + S7**: applicationSid 双阶段化
    // (initialSid = opts.resume ?? randomUUID() 已是合适 applicationSid 初值,validate phase 同款逻辑):
    // - spawn 主路径(无 opts.resume): ctor 时 applicationSid = initialSid (= randomUUID 即 tempKey),
    //   first thread.started 到达时 thread-loop.ts:142 isNewSpawn 分支保护切到 realId 后冻结
    // - resume / fallback 路径(有 opts.resume): ctor 时 applicationSid = opts.resume,全生命周期不变
    // S7 修订:mcpSessionTokenMap.allocate 已用 initialSid (validate phase),与 applicationSid 同款 = sessions.id 维度,
    //   反向 rename 不动 sessions.id → token map key 永远稳定。
    //
    // **REVIEW_79 MED-1 修法 (reviewer-claude 单方 + lead 现场验证,claude parity 偏差)**:
    // internal.threadId 初值必须用 effectiveResumeThreadId(= 实际传给 resumeThread 的 cli-sid 维度)
    // 而非 opts.resume(applicationSid 维度)。反向 rename 后(applicationSid=A,cli_session_id=C,C≠A)
    // normal resume 走 resumeThread(C) → SDK 返 thread_id=C,若 internal.threadId 仍是 A 则
    // thread-loop.ts:295 `internal.threadId(A) !== ev.thread_id(C)` 误触 case 3 fork-detect(本该
    // case 2 正常分支)→ 每次 resume 这类会话都打误导性 `logger.warn "SDK returned thread_id C !=
    // tracked A"`(实际无 fork) + latent 脆弱(若未来 case 3 改无条件写黑名单则 C 被误拉黑成真 bug)。
    // 当前 updateCliSessionId(A, C) 因 oldCliSid===C===newCliSid 不写黑名单(rename.ts:151)故无数据损坏。
    // 与 claude parity(stream-processor.ts:365 比较 effectiveResumeCliSid=cli-sid 维度 vs realId)对齐。
    // 三路径验证: ① normal resume after fallback → threadId=C → SDK 返 C → case 2 ✓
    //            ② fresh-cli-reuse-app → effectiveResumeThreadId=null → threadId=opts.resume=A →
    //               SDK startThread 返新 id D → A!==D → case 3 ✓ (intended 保留)
    //            ③ spawn (无 resume) → effectiveResumeThreadId=null + opts.resume undefined →
    //               threadId=null → case 1 ✓ (保留)
    const internal: InternalSession = {
      applicationSid: initialSid,
      threadId: effectiveResumeThreadId ?? opts.resume ?? null,
      cwd,
      thread,
      pendingMessages: firstInput ? [firstInput] : [],
      currentTurn: null,
      currentTurnId: null,
      turnLoopRunning: false,
      intentionallyClosed: false,
    };

    // ctx 打包 prepare phase 输出,传 sub-fn 让其只读消费(子段不动 cwd / sandboxMode / thread / internal
    // 副作用 — sessions.set / claimAsSdk / emit 由子段自己负责)
    const ctx: PreparedContext = {
      cwd,
      sandboxMode,
      thread,
      internal,
    };

    // dispatch resume / new path
    if (opts.resume) {
      return await runCreateSessionResumePath(effectiveOpts, ctx, deps);
    }
    return await runCreateSessionNewPath(effectiveOpts, ctx, validate, deps);
  } catch (err) {
    // REVIEW_60 MED-codex-2 + R4 §B 抽法 #3 修法 (与 try 块配对):
    // 4 资源 best-effort cleanup 抽到 create-session-rollback.ts helper (REVIEW_60 R4 reviewer-claude
    // 抽法清单),caller 调完后 throw err。详 helper jsdoc。
    runCreateSessionRollback({
      sessionId: initialSid,
      resumeSessionId: opts.resume,
      deps: {
        codexBySession: deps.codexBySession,
        sessions: deps.sessions,
      },
    });
    throw err;
  }
}

function combineDeveloperInstructions(
  ...parts: Array<string | undefined>
): string | undefined {
  const filtered = parts.map((p) => p?.trim()).filter((p): p is string => !!p);
  return filtered.length > 0 ? filtered.join('\n\n---\n\n') : undefined;
}
