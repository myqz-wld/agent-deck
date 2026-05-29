/**
 * hand-off-session handler-main 子模块（plan deep-project-review-comprehensive-20260528 Step 4.1
 * 拆分产物，从原 hand-off-session.ts 1306 LOC facade 抽出 handler 主入口 + spawn 调用 +
 * baton cleanup + ok return 装配）。
 *
 * 职责：把 cwd-resolver / team-adopt-coordinator / task-reassign-coordinator 三个子模块
 * 串起来跑完整 hand-off 流程（impl resolve → cwd 推导 → adopt precheck/装配 → spawn →
 * phase 1.5 swap → task 过继 → baton cleanup → ok return）。每个 phase 边界清晰，错误
 * 路径短路 return；失败容忍逻辑全在子模块内。
 *
 * **K2 metadata**：本模块装配 ok return 时把 plan / generic 双模式 metadata 透传给
 * caller（mode / planId / planFilePath / worktreePath / baseBranch / phaseLabel /
 * initialPrompt / ignoredFields / archived / teammatesShutdown / adopted / taskReassignment
 * + spread spawnData 全字段）。
 */

import {
  err,
  ok,
  withMcpGuard,
  type HandlerContext,
} from '../../helpers';
import type {
  HandOffSessionArgs,
  HandOffSessionResult,
  SpawnSessionArgs,
  SpawnSessionResult,
} from '../../schemas';
import { omitUndefined } from '@main/utils/optional-fields';
import {
  handOffSessionImpl,
  _isHandOffSessionError,
} from '../hand-off-session-impl';
import { spawnSessionHandler } from '../spawn';
import { runBatonCleanup } from '../baton-cleanup';
import {
  mergeCallerCwd,
  resolveCallerSessionCwd,
  resolvePlanModeDefaultCwd,
  validatePlanModeWorktreeExists,
  computeExtraAllowWrite,
} from './cwd-resolver';
import {
  validateAdoptTeammatesArgs,
  prepareAdoptSnapshotAndPrompt,
  runPhase15AdoptSwapLeadLoop,
  type Phase15Detail,
} from './team-adopt-coordinator';
import { runTaskReassignment } from './task-reassign-coordinator';
import type { HandOffSessionHandlerDeps } from './_deps';

/**
 * spawn handler 第三参 opts 决策 lambda(test seam)。
 *
 * **plan handoff-no-spawn-guards-20260526 §D5/§D6/§D8 收口**:hand-off 永远是「平级接力 +
 * 接管 lead 身份」语义,**无 archiveCaller 分流**。本 lambda 退化为常量,无入参:
 * - `handOffMode: true` — 让 spawn handler 完全跳过 spawn-guards 三道防御 + 永不写
 *   spawn-link(详 spawn-guards.ts §D4 + spawn-link-guard.ts §D6)
 * - `batonRole: 'lead'` — 让新 session 接管 lead 角色防 archiveTeamsIfOrphaned 误触发
 *   (仅当 args.teamName 启用 team 通信时被 spawn addMember 分支用到;不带 teamName
 *   的 hand-off 路径 batonRole 是 no-op)
 *
 * **历史名词 + 故意推翻**:旧名 `batonMode`(REVIEW_39/46/47/48 出现);本 plan §D6 改名升级
 * 语义(原仅跳 depth → 现跳三道 + 永不写 spawn-link)。当年 REVIEW_46(B-HIGH-2)+ REVIEW_47
 * (M12)的「archiveCaller=false 退化 normal spawn」分流被本 plan §D4/§D5 故意推翻 —
 * 用户原话「都是平级的」+「不进行任何和 spawn session 有关的检查」,`archiveCaller=false × N`
 * 滥用风险由 power-user 自负责任(plan §D3)。
 *
 * **lambda 保留 vs inline 删**:plan §D8 选 (a) 保留 lambda export 维持 test seam(不变量 3
 * Phase 1.3a 同款设计),退化常量后入参签名简化为无参 — test 端到端调真实 production
 * 常量 而非 inline 复制合约。
 *
 * @internal Only for __tests__/. Do NOT import from other production files.
 */
export function resolveBatonRoleForSpawn(): { handOffMode: true; batonRole: 'lead' } {
  return { handOffMode: true, batonRole: 'lead' };
}

export const handOffSessionHandler = withMcpGuard(
  'hand_off_session',
  async (
    args: HandOffSessionArgs,
    ctx: HandlerContext,
    handlerDeps?: HandOffSessionHandlerDeps,
  ) => {
    const { caller } = ctx;

    // 1. impl 层：双模式分流(plan-driven / generic) — 解析 plan 文件 / 构造 cold-start prompt
    // ⚠️ caller cwd 注入：impl 默认用 process.cwd() 当 caller cwd（电子 main 进程的 cwd，
    // 通常是 `/`），与真正的 caller SDK session cwd（在 sessions 表里）完全无关。所以
    // **必须**在 handler 层从 sessionRepo 反查 callerSessionRow.cwd 注入到 implDeps.cwd。
    // 不传 → impl 默认 process.cwd() → main-repo 反查永远失败 → 报「caller cwd is not a
    // git repo」（即使 caller 实际在 worktree / git repo 内）。
    // 优先级：caller 显式 implDeps.cwd > sessionRepo 反查 > impl DEFAULT_DEPS（process.cwd）
    // REVIEW_56 §F9 修法: mergeCallerCwd 返 {deps, warnings} (对称 archive-plan.ts)。
    // hand-off-session ok return 没 warnings 字段不 surface,只 console.warn 输出 (caller 通过
    // operator log grep `[hand-off-session]` 可见 fail-open 退化)。signature 重构与
    // archive-plan 同款保持对称易维护。
    const { deps: mergedImplDeps, warnings: callerCwdWarnings } = mergeCallerCwd(
      handlerDeps?.implDeps,
      caller.callerSessionId,
    );
    for (const w of callerCwdWarnings) console.warn(w);
    const resolved = await handOffSessionImpl(
      {
        planId: args.planId,
        prompt: args.prompt,
        phaseLabel: args.phaseLabel,
        planFilePathOverride: args.planFilePath,
      },
      mergedImplDeps,
    );
    if (_isHandOffSessionError(resolved)) {
      return err(resolved.error, resolved.hint);
    }

    // 2. 反查 callerSessionRow + callerSessionCwd（generic 模式 default cwd 用 + existsSync precheck）
    const { callerSessionCwd } = resolveCallerSessionCwd(
      caller.callerSessionId,
      handlerDeps,
    );

    // 3. 组装 spawn_session args：cwd 双模式 default(CHANGELOG_99 + REVIEW_36 HIGH-3)。
    //
    // **plan-driven 模式 default**: args.cwd > resolved.mainRepo (仅当 worktree 在 mainRepo subtree)
    //                              > resolved.worktreePath (外置 worktree fallback)
    // (R1 fix LOW-7 + REVIEW_36 HIGH-3:约定 worktree(`<mainRepo>/.claude/worktrees/<plan-id>`)走 mainRepo
    // 享 CHANGELOG_99 cwd resilience;**外置 worktree**(用户手动 `git worktree add /tmp/wt` /
    // `/Users/me/elsewhere/wt`)若仍走 mainRepo,sandbox.allowWrite=[mainRepo, /tmp, ~/.cache/claude-code]
    // 不覆盖外置 worktree → workspace-write 写每个文件都弹框 / strict 完全卡死。降级到 worktreePath
    // 让 sandbox.allowWrite=[worktreePath, ...] 自然覆盖。worktree 删了 cwd 失效场景由
    // recoverer.findFallbackCwd 启发式 fallback 兜底(父目录 walk 启发式 2 仍能命中 worktree 父目录)。)
    // 理由:让新 session 行为与 EnterWorktree 模式对齐 — sessionRepo.cwd 永远是 main repo(约定 worktree),
    // worktree 删了 cwd 仍 valid。新 session 按 user CLAUDE.md §Step 3 cold-start 流程自己
    // EnterWorktree(path: worktreePath) 进 worktree 干活。
    //
    // **HIGH-3 已知限制**（R2 review claude INFO-1 反馈）：
    // - **strict 档下降级 worktreePath 无意义**：strict 档不给 allowWrite，cwd 也只读
    //   （sandbox-config.ts 设计），workspace-write 档才是修法重点
    // - **外置 worktree 删了之后 fallback 路径**：recoverer.findFallbackCwd 启发式 1 不命中
    //   （regex `^(.+)/\.claude/worktrees/[^/]+(?:\/.*)?$` 仅配 `.claude/worktrees/` 形态）→ 落到
    //   启发式 2 父目录 walk → fallback cwd 可能不覆盖原 worktree 子目录写。**建议外置 worktree
    //   保留约定路径**(放在 `<main-repo>/.claude/worktrees/<plan-id>` 内)避免此 trade-off
    //
    // **generic 模式 default**: args.cwd > callerSessionRow.cwd (precheck existsSync) > resolved.mainRepo
    // (无 worktreePath 兜底,因为 generic 模式没 plan 也没 worktree 上下文;callerCwd 失败
    // 时 fallback 到 mainRepo 反查结果,都失败 → handler 报 'cannot resolve default cwd')。
    // 理由:generic 模式假设 caller 想让新 session 在自己 cwd 工作(最自然延续);只有 caller cwd
    // 没法用时退化到 mainRepo。R1 fix MED-4:callerCwd 必须 existsSync precheck — 否则 caller
    // 是 K2 老 session(cwd=worktree 已被删)时新 spawn 直接 chdir 失败。
    //
    // CHANGELOG_97：teamName 不再默认设为 planId —— baton 单向交接语义不需要 lead/teammate
    // 关系；caller 显式传 teamName 时仍透传给 spawn 启用通信关系（罕见使用）。
    const planModeDefaultCwd = resolvePlanModeDefaultCwd(resolved);
    const defaultCwd =
      resolved.mode === 'plan'
        ? planModeDefaultCwd
        : callerSessionCwd ?? resolved.mainRepo ?? undefined;
    const finalCwd = args.cwd ?? defaultCwd;

    // 4. plan-driven worktreeExists missing 4 case 决策（hard reject / graceful warn）
    const worktreeRejection = validatePlanModeWorktreeExists(resolved, finalCwd);
    if (worktreeRejection !== null) return worktreeRejection.result;

    // 5. extraAllowWrite 计算（外置 worktree 自动加 mainRepo）
    const computedExtraAllowWrite = computeExtraAllowWrite(args, resolved, finalCwd);

    if (!finalCwd) {
      // 极端边界:plan 模式 mainRepo+worktreePath 都 null(impl 不会发生),
      // 或 generic 模式 callerCwd+mainRepo 都 null(external sentinel + caller cwd 非 git repo,
      // 且 deny external 失效的极端测试场景)。给清晰错误。
      return err(
        `cannot resolve default cwd for new session (mode=${resolved.mode}; pass args.cwd explicitly)`,
        `For plan-driven mode this typically means both git rev-parse fallback and worktreePath heuristic failed. For generic mode this means caller session has no cwd in sessionRepo and git rev-parse failed.`,
      );
    }

    // 6. adoptTeammates 互斥校验（N2.c）+ adoptedSnapshot 装配 + cold-start prompt prepend
    const adoptValidationResult = validateAdoptTeammatesArgs(args);
    if (adoptValidationResult !== null) return adoptValidationResult;

    const adoptResult = prepareAdoptSnapshotAndPrompt(
      args,
      caller.callerSessionId,
      resolved.coldStartPrompt,
      handlerDeps,
    );
    if ('isError' in adoptResult) return adoptResult.result;
    const { adoptedSnapshot, coldStartPromptForSDK } = adoptResult;

    // 7. 装配 spawn args（含 adopt 路径 prompt prepend / handOff metadata / cwd / sandbox / extraAllowWrite）
    const spawnArgs: SpawnSessionArgs = {
      adapter: args.adapter ?? 'claude-code',
      cwd: finalCwd,
      // adopt 路径 prompt 含 adoptedBlock prepend;non-adopt 路径用 resolved.coldStartPrompt 原值
      prompt: coldStartPromptForSDK,
      // plan handoff-render-and-image-batch-20260521 §Phase 2 Step 2.2 internal plumbing +
      // R1 reviewer-codex LOW 修法 (generic mode phaseLabel 契约一致性):装配 HandOffMetadata
      // 透传给 spawn handler → builder → adapter narrow → bridge createSession → first user
      // message emit 时 spread 进 events.payload,renderer 渲染 Hand-off badge + 折叠 adoptedBlock。
      //
      // **phaseLabel 按 resolved.mode 过滤**(R1 reviewer-codex LOW 修法):generic mode 时
      // hand-off-session-impl.ts:170-186 已把 `phaseLabel` 标到 ignoredFields(ok return
      // phaseLabel 也是 null);为了让 events.payload metadata 与 handler 契约一致,此处也按
      // resolved.mode 过滤,避免 caller 误传 phaseLabel 给 generic mode 时 events.payload /
      // UI tooltip 显示该 phase 但 ok return 说被忽略(契约不一致 = silent UI/metadata 漂移)。
      handOff: {
        mode: resolved.mode,
        planId: args.planId ?? null,
        phaseLabel: resolved.mode === 'plan' ? args.phaseLabel ?? null : null,
        fromCallerSid: caller.callerSessionId,
        hasAdoptedBlock: args.adoptTeammates === true && adoptedSnapshot !== null,
      },
      // REVIEW_37 P1-Phase2 (claude F4 LOW)：omitUndefined 收口 4 个简单 spread+ternary。
      // 仅 extraAllowWrite（length > 0 语义）保留 inline ternary。
      ...omitUndefined({
        teamName: args.teamName,
        permissionMode: args.permissionMode,
        // REVIEW_36 HIGH-2 修法：sandbox 字段镜像 permissionMode 透传策略
        codexSandbox: args.codexSandbox,
        claudeCodeSandbox: args.claudeCodeSandbox,
      }),
      // REVIEW_36 R2 MED-C 修法：computedExtraAllowWrite 含 mainRepo（外置 worktree 自动加）+
      // caller 显式 args.extraAllowWrite 合并去重。仅当非空时透传给 spawn —
      // 留 inline 因要 length > 0 检查（空数组也跳过，omitUndefined 不处理 empty array）
      ...(computedExtraAllowWrite !== undefined && computedExtraAllowWrite.length > 0
        ? { extraAllowWrite: [...computedExtraAllowWrite] }
        : {}),
      // callerSessionId 透传：spawn handler 内 makeCtx 已重新算（in-process closure
      // override），但这里用 ctx 直接转发跳过中间层。下方 spawnSessionHandler 接受 ctx 参数
      // 直接传同一个 caller，不依赖 spawn_session 的 args.callerSessionId 字段。
    };

    // 8. 调 spawn handler 完成实际 spawn（透传同一 ctx 让 caller 视角一致）
    // plan handoff-no-spawn-guards-20260526 §D5/§D6/§D8:无 archiveCaller 分流,hand-off 永远是
    // {handOffMode: true, batonRole: 'lead'} 平级接力 + 接管 lead 身份语义。
    // spawn handler 端消费语义:
    // - handOffMode=true 跳 spawn-guards 三道全部(depth + fan-out + spawn-rate)+ 永不写
    //   spawn-link(详 spawn-guards.ts §D4 + spawn-link-guard.ts §D6)
    // - batonRole='lead' 让新 session 在 team 内以 lead 角色加入(REVIEW_37 R2 HIGH-1 修法
    //   仍 valid),仅当 args.teamName 真启用 team 通信时被 spawn addMember 分支用到;
    //   不带 teamName 的 hand-off 不 addMember 时 batonRole 是 no-op
    const spawnFn = handlerDeps?.spawnSession ?? spawnSessionHandler;
    const { handOffMode, batonRole } = resolveBatonRoleForSpawn();
    const spawnResult = await spawnFn(
      spawnArgs,
      ctx,
      { handOffMode, batonRole },
    );
    if (spawnResult.isError) {
      // 透传 spawn 的 error 不再二次包装（避免「hand_off_session error: spawn error: ...」嵌套）
      return spawnResult;
    }

    // 9. parse spawn 的 ok JSON → 包 K2 metadata
    // R37 P3-L Step 4.5：cast as SpawnSessionResult 让下游 satisfies HandOffSessionResult
    // 静态校验 spread 字段；JSON.parse 是 unsafe cast — spawn handler ok return 漂移时
    // hand-off return 类型校验失效（trade-off：mcp tool 协议要求 content[].text 字符串
    // 序列化，handler 间无法直接共享 typed result instance；schemas.ts SpawnSessionResult
    // 是 SSOT，spawn handler return 漂移 satisfies 必先在 spawn 自己处拦下，间接守门此处）。
    let spawnData: SpawnSessionResult;
    try {
      spawnData = JSON.parse(spawnResult.content[0]?.text ?? '{}') as SpawnSessionResult;
    } catch (e) {
      return err(
        `failed to parse spawn_session result: ${(e as Error).message}`,
        'spawn_session returned non-JSON content; this is an internal error.',
      );
    }

    // spawnData.sessionId 是 SpawnSessionResult.sessionId（cast 后 string，原 typeof 校验是
    // R37 P3-L 前的 Record<string, unknown> 兜底，cast 后 typeof 校验成 redundant 但保留无害）。
    const newSpawnedSid = typeof spawnData.sessionId === 'string' ? spawnData.sessionId : null;
    // REVIEW_36 R2 HIGH-A: caller 显式 teamName 时 spawn handler 把新 sid 加为 teammate
    // (spawn.ts:310-317)。如果不通过 excludeSessionIds 排除 → helper 把刚交出 baton 的新 session
    // 也关掉(fix-to-fix bug)。spawnData.sessionId 必有(spawn handler ok return 必带 sessionId
    // 字段),否则前面 isError 短路返回。
    const excludeSessionIds = newSpawnedSid ? new Set<string>([newSpawnedSid]) : undefined;

    // 10. plan hand-off-session-adopt-teammates-20260520 Phase 6 — phase 1.5 swapLead loop
    // 设计要点详 team-adopt-coordinator.ts runPhase15AdoptSwapLeadLoop jsdoc。
    let phase15Detail: Phase15Detail = {
      preserved: [],
      failed: [],
      teamsAdopted: 0,
      adoptedTeamIds: [],
    };
    if (args.adoptTeammates === true && adoptedSnapshot && newSpawnedSid) {
      const phase15Result = await runPhase15AdoptSwapLeadLoop(
        caller.callerSessionId,
        adoptedSnapshot,
        newSpawnedSid,
        handlerDeps,
      );
      if ('isError' in phase15Result) return phase15Result.result;
      phase15Detail = phase15Result.phase15Detail;
    }

    // 11. task ownership reassignment 三态分流（详 task-reassign-coordinator.ts jsdoc）
    const taskReassignment = runTaskReassignment(
      args,
      caller.callerSessionId,
      newSpawnedSid,
      phase15Detail,
      handlerDeps,
    );

    // 12. CHANGELOG_109(R37 P2-M Step 3.5): baton cleanup 两段(teammate shutdown + archive caller)
    // 收口到 runBatonCleanup helper(详 baton-cleanup.ts 顶部 jsdoc)。helper 内部串行跑 phase 1
    // (shutdown teammates) → phase 2 (archive caller),失败容错全在 helper 里(单个 close warn /
    // helper 抛错兜底 / archive 失败 warn / DB 异常 fail-safe);handler 这层只透传 input + 把
    // 两个三态结果 spread 进 ok return。
    //
    // baton 单向交接 = caller 会话使命终结,team 里没 lead 后 reviewer-claude / reviewer-codex
    // 等 teammate 应一起收口避免孤儿(占内存 + SDK live query)。plan
    // hand-off-session-adopt-teammates-20260520 Phase 3 删除 phase 1 opt-out 字段;Phase 4 引入
    // adoptTeammates: true 时走独立 phase 1.5 adopt 路径接管 teammate。
    //
    // CHANGELOG_99 R1 fix MED-5: archive 段必须**重新反查** sessionRepo.get 而非复用早期
    // callerSessionRow。spawn 是 long-running async,期间 caller row 可能被删 → 复用
    // 旧探针调 archive 的 UPDATE 对缺失 row 是 no-op 误报 'ok'。helper 内部反查保证 ground truth。
    const cleanup = await runBatonCleanup(
      {
        callerSessionId: caller.callerSessionId,
        // hand-off-mcp-archive-opt-20260515: caller archive opt-out。
        // default true(baton 单向交接 = caller 使命终结);仅 caller 显式传 false 跳过。
        archiveCaller: args.archiveCaller !== false,
        // plan hand-off-session-adopt-teammates-20260520 Phase 4 (D3 + D5):
        // adoptTeammates: true 透传到 baton-cleanup → phase 1 跳过 shutdownTeammatesOnBaton
        // 标 skipped='adopt-keep-implicit'。teammate 由 phase 1.5 adopt 路径调 swapLead 接管
        // (Phase 4 阶段 phase 1.5 在 hand-off-session.ts handler adopt 分支只装配 cold-start
        // prompt;Phase 6 在 baton-cleanup helper 内调 swapLead 完整化 phase 1.5 流程含
        // listAllMembers + emit + collect preserved/failed)。
        adoptTeammates: args.adoptTeammates === true,
        excludeSessionIds,
        toolName: 'hand_off_session',
      },
      {
        shutdownTeammates: handlerDeps?.shutdownTeammates,
        archiveSession: handlerDeps?.archiveSession,
      },
    );

    // 13. ok return 装配（K2 metadata + adopt detail + task reassign + spawn 字段透传）
    return ok({
      // CHANGELOG_99 双模式 metadata
      mode: resolved.mode, // 'plan' | 'generic'
      // K2 metadata（plan 模式有值;generic 模式 plan-only 字段全 null）
      planId: args.planId ?? null,
      planFilePath: resolved.planFilePath,
      worktreePath: resolved.worktreePath,
      baseBranch: resolved.baseBranch,
      phaseLabel: resolved.mode === 'plan' ? args.phaseLabel ?? null : null,
      // plan hand-off-session-adopt-teammates-20260520 Phase 4 (D11 v8 + Round 5 MED-2):
      // initialPrompt 必与 SDK first message 一致(schemas.ts:690-693「完整字面」契约)。
      // adopt 路径返 coldStartPromptForSDK(含 adopted teams context block + user prompt,
      // 不含 wire prefix);non-adopt 路径返 resolved.coldStartPrompt 原值。
      initialPrompt: args.adoptTeammates === true ? coldStartPromptForSDK : resolved.coldStartPrompt,
      /**
       * CHANGELOG_99：generic 模式下 caller 传了 plan-only 字段(phaseLabel / planFilePath)
       * 时被忽略的字段名数组(空数组 = 无忽略)。caller 可见此字段提醒"我传错了"。plan 模式
       * 始终空数组。
       */
      ignoredFields: resolved.ignoredFields,
      archived: cleanup.archived, // Phase A5：'ok' = 归档成功 / 'failed' = warn-only 不阻塞 / 'skipped' = external caller
      /**
       * CHANGELOG_106：teammate shutdown 详情(与 archive_plan 同款)。
       * - closed: 成功 close 的 teammate sid 列表
       * - failed: close 失败的 teammate(含 reason),warn 不阻塞 ok return
       * - skipped: 'caller-not-lead'(caller 不是 lead) /
       *   'adopt-keep-implicit'(plan hand-off-session-adopt-teammates-20260520 Phase 4 引入,
       *   adoptTeammates: true 时 teammate 由 swapLead 接管不 shutdown — Phase 3 完成时
       *   未启用) /
       *   null(正常处理含 closed=[] 的 caller=lead 但 team 内无其他 teammate)
       */
      teammatesShutdown: cleanup.teammatesShutdown,
      // plan hand-off-session-adopt-teammates-20260520 Phase 6 (D7 v8) — adopt 路径详情。
      // **Phase 6 完整化**:phase 1.5 swapLead loop + listAllMembers + lifecycle precheck +
      // emit + collect 完成,adopted 字段反映真实 adopt 结果(teamsAdopted / preserved /
      // failed)。firstTeam fatal abort 路径已在前面 return error 短路,本 return 仅在 ok
      // 路径(全 lead team adopt 完成 / partial adopt 接受)出现 non-null。
      adopted:
        adoptedSnapshot !== null
          ? {
              preserved: phase15Detail.preserved,
              failed: phase15Detail.failed,
              teamsTotal: adoptedSnapshot.teamsTotal,
              teamsAdopted: phase15Detail.teamsAdopted,
              firstTeamId: adoptedSnapshot.firstTeamId,
              // v024 plan §Step D2 R5 LOW-2 显式 wire spread mapping:phase15Detail.adoptedTeamIds
              // 收集自 processSwappedTeam helper 内集中 push（firstTeam + rest loop 全覆盖,
              // Round 4 HIGH-1 修法）；与 preserved 字段并列暴露 caller team uuids 便于 diag
              // preserve-team policyWarning('preserve-team-unadopted-teams') 来源（plan §不变量 5）。
              adoptedTeamIds: phase15Detail.adoptedTeamIds,
            }
          : null,
      // plan task-mcp-owner-session-id-rewrite-20260521 v023 §D3 + deep-review Round 1
      // F3 修法:task 过继三态状态 + count + error,让 caller 通过 ok return 看到 task
      // ownership 转移结果(修前 console.warn 静默吞错)。详上方 try/catch 块顶部注释。
      taskReassignment,
      // 透传 spawn_session 字段（兼容 spawn 调用方）— spread SpawnSessionResult 全部字段，
      // 与 HandOffSessionResult extends SpawnSessionResult 对应让 satisfies 通过。
      ...spawnData,
    } satisfies HandOffSessionResult);
  },
);
