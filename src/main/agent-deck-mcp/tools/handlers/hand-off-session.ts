/**
 * hand_off_session handler 入口（CHANGELOG_99 改名前 `start_next_session`；
 * plan mcp-bug-and-feature-batch-20260513 Phase 4b Step 4b.2；
 * CHANGELOG_97 改 baton 语义：default 不加 team + 自动归档 caller；
 * CHANGELOG_99 双模式改造：plan_id 变 optional，无 plan_id 时走 generic 模式）。
 *
 * 薄 wrapper：deny external caller + validateExternalCaller + 调 handOffSessionImpl
 * 拿 resolved 上下文（planFilePath / worktreePath / coldStartPrompt） + 组装 spawn_session
 * args + 调 spawnSessionHandler 完成实际 spawn + **归档 caller** + 包 K2 metadata + spawn 字段透传。
 *
 * 业务行为完全在 hand-off-session-impl.ts（plan resolve / frontmatter parse / status 校验
 * / prompt 构造），spawn 行为完全复用 spawnSessionHandler（与 spawn_session tool 同款防御链
 * + permission_mode / sandbox 继承）。
 *
 * **Deny external caller**（types.ts: EXTERNAL_CALLER_ALLOWED.hand_off_session = false）：
 * 起 SDK session 的 fork bomb 风险（同 spawn_session / archive_plan），绝不允许 stdio
 * external client 调用。
 *
 * **CHANGELOG_97 baton 语义改造**：plan 接力的本质是「caller 把 baton 单向交出，新 session
 * 独立接手，原 caller 退出」，**不是**「派出小弟干活，原 caller 当 lead 持续监督」。所以：
 *
 * 1. **default 不传 team_name 给 spawn**：caller 不显式传 team_name 时，spawn 不走
 *    ensureByName / addMember 路径 → 原 caller 不被打 lead 标签 / 新 session 不被打
 *    teammate 标签。如果 caller 真的想走 lead/teammate 通信关系（罕见），仍可显式传
 *    args.team_name 启用。历史行为「team_name = plan_id」实证 47260477 团队仅 1 条
 *    自动 placeholder message，lead 与 teammate 之间从未真正对话 → 强加 team 关系
 *    在 SessionList 显示「↳ teammate」缩进 + lead 标签是冗余 UX 噪音。
 *
 * 2. **default 自动归档 caller session**：spawn 成功后立即调 sessionManager.archive
 *    (caller.callerSessionId)，把 baton 完整交出。失败仅 console.warn 不阻塞 K2 成功
 *    return（caller 至少能拿到 newSid，原会话留 active 影响小，用户可手动右键归档）。
 *
 * **复用策略**：调 spawnSessionHandler 时透传同一个 ctx（caller_session_id），让 spawn
 * 链路里的 spawn-link 等按 caller 视角正确归属。透传后 spawnSessionHandler 返回的
 * HandlerResult 含 JSON.stringify ok 数据，本 handler parse 出 sessionId 等字段，包 K2
 * 自己的 ok return（额外加 K2 metadata: planFilePath / worktreePath / initialPrompt /
 * phaseLabel）。
 */

import { existsSync } from 'node:fs';
import {
  denyExternalIfNotAllowed,
  err,
  ok,
  validateExternalCaller,
  type HandlerContext,
  type HandlerResult,
} from '../helpers';
import type { HandOffSessionArgs, SpawnSessionArgs } from '../schemas';
import { EXTERNAL_CALLER_SENTINEL } from '../../types';
import { sessionManager } from '@main/session/manager';
import { sessionRepo } from '@main/store/session-repo';
import {
  handOffSessionImpl,
  _isHandOffSessionError,
  type HandOffSessionDeps,
} from './hand-off-session-impl';
import { spawnSessionHandler } from './spawn';

/**
 * 测试 inject seam：默认调真 spawnSessionHandler / sessionManager.archive；test 通过
 * depsOverride 注入 mock 函数避免起真 SDK session / 真碰 DB。impl deps 也透传给
 * handOffSessionImpl。
 */
export interface HandOffSessionHandlerDeps {
  spawnSession?: typeof spawnSessionHandler;
  /** CHANGELOG_97：archive caller 的 test seam，让单测无需 mock 整个 sessionManager */
  archiveSession?: (sessionId: string) => Promise<void>;
  implDeps?: HandOffSessionDeps;
  /**
   * CHANGELOG_99 R1 fix MED-4:cwd 存在性 test seam。default 走 fs.existsSync,生产环境
   * generic 模式 caller cwd 已失效(典型: caller 在 K2 老 session cwd=worktree,worktree 被
   * archive_plan 删)→ precheck false → handler default cwd fallback 到 mainRepo,而不是把
   * 失效 cwd 原样传给 spawn(spawn 会 chdir 失败,recoverer 又只覆盖 sendMessage 不覆盖
   * 新 spawn 的 createSession 路径)。
   */
  cwdExists?: (path: string) => boolean;
}

/**
 * 从 caller session id 反查 sessions 表拿 cwd，构造 implDeps 子集（仅 cwd 字段）。
 *
 * 解 H5 caller cwd bug 的核心：impl DEFAULT_DEPS.cwd = process.cwd()（Electron main
 * 进程 cwd，通常 `/`），与真正的 caller SDK session cwd 无关，所以反查 main-repo /
 * 判定 worktree 都失败。handler 层必须从 sessionRepo 反查 caller session 的真实 cwd
 * 注入。external sentinel / 反查不到时返回空对象，impl 仍走 DEFAULT_DEPS.cwd 兜底。
 */
function resolveCallerCwdDeps(callerSessionId: string): HandOffSessionDeps {
  if (callerSessionId === EXTERNAL_CALLER_SENTINEL) return {};
  // CHANGELOG_99 R1 fix MED-1:sessionRepo.get 包 try/catch fail-safe (与 L143 段对称)。
  // DB 异常 (test 未 init / 生产 SQLite locked / FK conflict) 时返回空 deps,让 impl 退化到
  // DEFAULT_DEPS.cwd = process.cwd() 兜底,而非 handler 直接 crash。
  let row: ReturnType<typeof sessionRepo.get> = null;
  try {
    row = sessionRepo.get(callerSessionId);
  } catch {
    return {};
  }
  if (!row?.cwd) return {};
  const cwd = row.cwd;
  return { cwd: () => cwd };
}

/**
 * 合并 caller 显式 implDeps 与 sessionRepo 反查的 callerCwd 注入。
 *
 * 优先级（从高到低）：
 * 1. caller 显式传 `handlerDeps.implDeps.cwd`（test 场景或 caller 想强制覆盖）
 * 2. sessionRepo 反查 callerSession.cwd（生产路径正常情况）
 * 3. impl 内 DEFAULT_DEPS.cwd（process.cwd，最后兜底）
 *
 * 实现策略：caller 显式 cwd 时直接返回 caller 原 implDeps；否则把 callerCwdInjection 放
 * **后面** spread 覆盖任何 caller implDeps 里 cwd: undefined 的边界 case。
 */
function mergeCallerCwd(
  callerImplDeps: HandOffSessionDeps | undefined,
  callerSessionId: string,
): HandOffSessionDeps | undefined {
  if (callerImplDeps?.cwd) return callerImplDeps;
  const callerCwdInjection = resolveCallerCwdDeps(callerSessionId);
  if (!callerCwdInjection.cwd) return callerImplDeps;
  return { ...callerImplDeps, ...callerCwdInjection };
}

export async function handOffSessionHandler(
  args: HandOffSessionArgs,
  ctx: HandlerContext,
  handlerDeps?: HandOffSessionHandlerDeps,
): Promise<HandlerResult> {
  const { caller } = ctx;
  const denial = denyExternalIfNotAllowed('hand_off_session', caller);
  if (denial) return denial;
  const callerCheck = validateExternalCaller(caller);
  if (callerCheck) return callerCheck;

  // 1. impl 层：双模式分流(plan-driven / generic) — 解析 plan 文件 / 构造 cold-start prompt
  // ⚠️ caller cwd 注入：impl 默认用 process.cwd() 当 caller cwd（电子 main 进程的 cwd，
  // 通常是 `/`），与真正的 caller SDK session cwd（在 sessions 表里）完全无关。所以
  // **必须**在 handler 层从 sessionRepo 反查 callerSessionRow.cwd 注入到 implDeps.cwd。
  // 不传 → impl 默认 process.cwd() → main-repo 反查永远失败 → 报「caller cwd is not a
  // git repo」（即使 caller 实际在 worktree / git repo 内）。
  // 优先级：caller 显式 implDeps.cwd > sessionRepo 反查 > impl DEFAULT_DEPS（process.cwd）
  const mergedImplDeps = mergeCallerCwd(handlerDeps?.implDeps, caller.callerSessionId);
  const resolved = await handOffSessionImpl(
    {
      planId: args.plan_id,
      prompt: args.prompt,
      phaseLabel: args.phase_label,
      planFilePathOverride: args.plan_file_path,
    },
    mergedImplDeps,
  );
  if (_isHandOffSessionError(resolved)) {
    return err(resolved.error, resolved.hint);
  }

  // CHANGELOG_99：generic 模式下 caller 还可能想用 callerCwd 作 default cwd(plan 模式不需要)
  // 反查 caller session row(此处复用 mergeCallerCwd 计算所依赖的 sessionRepo,但单独取
  // 一次以便 generic 模式 default cwd 用 + 后续归档阶段复用)。external sentinel 时
  // callerRow null,fallback 到 mainRepo / undefined(让 spawn handler 报 cwd 缺失,理论上
  // deny external 拦截不到这里)。**try/catch DB 错误**:test 场景下 DB 可能未 init,要让
  // plan 模式 spawn 失败短路 case 不需要先撞 DB; generic 模式无 DB 时 callerCwd null,
  // default cwd 退化到 mainRepo。
  let callerSessionRow: ReturnType<typeof sessionRepo.get> = null;
  if (caller.callerSessionId !== EXTERNAL_CALLER_SENTINEL) {
    try {
      callerSessionRow = sessionRepo.get(caller.callerSessionId);
    } catch {
      // DB 不可用(typical: test 环境 DB 未 init)→ 留 null,后续 default cwd / 归档段
      // 都按 row missing 路径走(generic 模式 default cwd 退化到 mainRepo;归档阶段标 'failed')
      callerSessionRow = null;
    }
  }
  // CHANGELOG_99 R1 fix MED-4:generic 模式 default cwd 候选 callerSessionCwd 必须 existsSync
  // precheck。生产场景:caller 是 K2 老 session,cwd=worktree,worktree 已被 archive_plan 删 →
  // callerSessionCwd 仍是失效路径 → 直接传给 spawn 会 chdir 失败(recoverer 只覆盖已建立
  // session 的 sendMessage 路径,不覆盖新 spawn 的 createSession)。precheck false → null
  // 让 default cwd fallback 到 mainRepo。
  const cwdExistsFn = handlerDeps?.cwdExists ?? existsSync;
  const callerSessionCwdRaw: string | null = callerSessionRow?.cwd ?? null;
  const callerSessionCwd: string | null =
    callerSessionCwdRaw !== null && cwdExistsFn(callerSessionCwdRaw) ? callerSessionCwdRaw : null;

  // 2. 组装 spawn_session args：cwd 双模式 default(CHANGELOG_99)。
  //
  // **plan-driven 模式 default**: args.cwd > resolved.mainRepo > resolved.worktreePath
  // (R1 fix LOW-7:原注释错把 caller cwd 写在最高优先级,实际 plan 模式不走 caller cwd —
  // 因 plan-driven 设计就是要让新 session 在 mainRepo 工作 + 自己 EnterWorktree 进 worktree,
  // caller cwd 无意义。worktreePath 是兜底,仅当 mainRepo 反查 + 启发式都失败时退化到原行为。)
  // 理由:让新 session 行为与 EnterWorktree 模式对齐 — sessionRepo.cwd 永远是 main repo,
  // worktree 删了 cwd 仍 valid。新 session 按 user CLAUDE.md §Step 3 cold-start 流程自己
  // EnterWorktree(path: worktreePath) 进 worktree 干活。
  //
  // **generic 模式 default**: args.cwd > callerSessionRow.cwd (precheck existsSync) > resolved.mainRepo
  // (无 worktreePath 兜底,因为 generic 模式没 plan 也没 worktree 上下文;callerCwd 失败
  // 时 fallback 到 mainRepo 反查结果,都失败 → handler 报 'cannot resolve default cwd')。
  // 理由:generic 模式假设 caller 想让新 session 在自己 cwd 工作(最自然延续);只有 caller cwd
  // 没法用时退化到 mainRepo。R1 fix MED-4:callerCwd 必须 existsSync precheck — 否则 caller
  // 是 K2 老 session(cwd=worktree 已被删)时新 spawn 直接 chdir 失败。
  //
  // CHANGELOG_97：team_name 不再默认设为 plan_id —— baton 单向交接语义不需要 lead/teammate
  // 关系；caller 显式传 team_name 时仍透传给 spawn 启用通信关系（罕见使用）。
  const defaultCwd =
    resolved.mode === 'plan'
      ? resolved.mainRepo ?? resolved.worktreePath ?? undefined
      : callerSessionCwd ?? resolved.mainRepo ?? undefined;
  const finalCwd = args.cwd ?? defaultCwd;
  if (!finalCwd) {
    // 极端边界:plan 模式 mainRepo+worktreePath 都 null(impl 不会发生),
    // 或 generic 模式 callerCwd+mainRepo 都 null(external sentinel + caller cwd 非 git repo,
    // 且 deny external 失效的极端测试场景)。给清晰错误。
    return err(
      `cannot resolve default cwd for new session (mode=${resolved.mode}; pass args.cwd explicitly)`,
      `For plan-driven mode this typically means both git rev-parse fallback and worktreePath heuristic failed. For generic mode this means caller session has no cwd in sessionRepo and git rev-parse failed.`,
    );
  }
  const spawnArgs: SpawnSessionArgs = {
    adapter: args.adapter ?? 'claude-code',
    cwd: finalCwd,
    prompt: resolved.coldStartPrompt,
    ...(args.team_name !== undefined ? { team_name: args.team_name } : {}),
    ...(args.permission_mode !== undefined ? { permission_mode: args.permission_mode } : {}),
    // caller_session_id 透传：spawn handler 内 makeCtx 已重新算（in-process closure
    // override），但这里用 ctx 直接转发跳过中间层。下方 spawnSessionHandler 接受 ctx 参数
    // 直接传同一个 caller，不依赖 spawn_session 的 args.caller_session_id 字段。
  };

  // 3. 调 spawn handler 完成实际 spawn（透传同一 ctx 让 caller 视角一致）
  // CHANGELOG_98 / R2 deep review HIGH-1：传 { batonMode: true } 让 spawn-guards 跳 depth
  // check + setSpawnLink 写 lateral parentDepth（不 +1）。baton 单向交接（spawn 后立即
  // archive caller）不构成 fork-bomb 风险，多 phase 接力不该被 maxDepth=3 拒。
  const spawnFn = handlerDeps?.spawnSession ?? spawnSessionHandler;
  const spawnResult = await spawnFn(spawnArgs, ctx, { batonMode: true });
  if (spawnResult.isError) {
    // 透传 spawn 的 error 不再二次包装（避免「hand_off_session error: spawn error: ...」嵌套）
    return spawnResult;
  }

  // 4. parse spawn 的 ok JSON → 包 K2 metadata
  let spawnData: Record<string, unknown>;
  try {
    spawnData = JSON.parse(spawnResult.content[0]?.text ?? '{}');
  } catch (e) {
    return err(
      `failed to parse spawn_session result: ${(e as Error).message}`,
      'spawn_session returned non-JSON content; this is an internal error.',
    );
  }

  // 5. CHANGELOG_97：自动归档 caller session（baton 语义 = 原会话退出，新会话独立接手）。
  // external caller 不在 sessions 表（已被 denyExternalIfNotAllowed 拦下，理论不会到这里；
  // 防御性双保险）。失败仅 console.warn 不阻塞 K2 成功 return（caller 至少能拿到 newSid）。
  // Phase A5 / R1 deep review *未验证* #1 升级：把 archive 结果放到 ok return.archived
  // 字段（'ok' / 'failed' / 'skipped'），让 caller 不必看 console.warn 就能感知归档结果。
  // CHANGELOG_98 / R2 reviewer-codex MED-2：archive 前 sessionRepo.get 探针，缺 row
  // （session 异常被清理 / caller 在 sentinel 之外的边界状态）→ 'failed' 不报 'ok'
  // （旧实现 archive() 是 sessionRepo.setArchived no-op + emit no-op + 仍返回 'ok' 误报）。
  // CHANGELOG_99 R1 fix MED-5:archive 段**重新反查** sessionRepo.get 而非复用早期 callerSessionRow。
  // 早期反查在 spawn 之前(用于 generic 模式 default cwd),spawn 是 long-running async 操作,
  // spawn 期间 caller row 可能被删(用户手动 close / lifecycle scheduler 清理),复用旧探针
  // 会调 archive,但 UPDATE 对缺失 row 是 no-op → 误报 'ok'。重新反查 ground truth,与 K2
  // 原模式一致。
  let archived: 'ok' | 'failed' | 'skipped' = 'skipped';
  if (caller.callerSessionId !== EXTERNAL_CALLER_SENTINEL) {
    let archiveTimeRow: ReturnType<typeof sessionRepo.get> = null;
    try {
      archiveTimeRow = sessionRepo.get(caller.callerSessionId);
    } catch {
      // DB 异常 fail-safe(同 L143 段)
      archiveTimeRow = null;
    }
    if (!archiveTimeRow) {
      archived = 'failed';
      console.warn(
        `[mcp hand_off_session] cannot archive caller ${caller.callerSessionId}: not in sessions table (异常被清理 / 边界状态 / spawn 期间 row 被删)`,
      );
    } else {
      const archiveFn =
        handlerDeps?.archiveSession ?? ((sid: string) => sessionManager.archive(sid));
      try {
        await archiveFn(caller.callerSessionId);
        archived = 'ok';
      } catch (e) {
        archived = 'failed';
        console.warn(
          `[mcp hand_off_session] archive caller ${caller.callerSessionId} failed:`,
          e,
        );
      }
    }
  }

  return ok({
    // CHANGELOG_99 双模式 metadata
    mode: resolved.mode, // 'plan' | 'generic'
    // K2 metadata（plan 模式有值;generic 模式 plan-only 字段全 null）
    planId: args.plan_id ?? null,
    planFilePath: resolved.planFilePath,
    worktreePath: resolved.worktreePath,
    baseBranch: resolved.baseBranch,
    phaseLabel: resolved.mode === 'plan' ? args.phase_label ?? null : null,
    initialPrompt: resolved.coldStartPrompt,
    /**
     * CHANGELOG_99：generic 模式下 caller 传了 plan-only 字段(phase_label / plan_file_path)
     * 时被忽略的字段名数组(空数组 = 无忽略)。caller 可见此字段提醒"我传错了"。plan 模式
     * 始终空数组。
     */
    ignoredFields: resolved.ignoredFields,
    archived, // Phase A5：'ok' = 归档成功 / 'failed' = warn-only 不阻塞 / 'skipped' = external caller
    // 透传 spawn_session 字段（兼容 spawn 调用方）
    ...spawnData,
  });
}
