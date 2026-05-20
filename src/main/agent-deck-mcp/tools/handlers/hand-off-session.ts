/**
 * hand_off_session handler 入口（CHANGELOG_99 改名前 `start_next_session`；
 * plan mcp-bug-and-feature-batch-20260513 Phase 4b Step 4b.2；
 * CHANGELOG_97 改 baton 语义：default 不加 team + 自动归档 caller；
 * CHANGELOG_99 双模式改造：plan_id 变 optional，无 plan_id 时走 generic 模式;
 * CHANGELOG_109 R37 P2-M Step 3.5 抽 baton-cleanup.ts 共享 ~80 行模板）。
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
 * 2. **default 自动归档 caller session + CHANGELOG_106 teammate shutdown(同 archive_plan)**：
 *    spawn 成功后调 baton-cleanup.ts 的 runBatonCleanup helper 完成两段(详 baton-cleanup.ts
 *    顶部 jsdoc)。plan hand-off-session-adopt-teammates-20260520 Phase 3 简化:删除 baton-cleanup
 *    phase 1 opt-out 字段。Phase 4 引入 adopt_teammates: true 时由 caller 显式接管 teammate
 *    (走独立 phase 1.5 adopt 路径,baton-cleanup phase 1 跳过标 skipped='adopt-keep-implicit')。
 *
 * **复用策略**：调 spawnSessionHandler 时透传同一个 ctx（caller_session_id），让 spawn
 * 链路里的 spawn-link 等按 caller 视角正确归属。透传后 spawnSessionHandler 返回的
 * HandlerResult 含 JSON.stringify ok 数据，本 handler parse 出 sessionId 等字段，包 K2
 * 自己的 ok return（额外加 K2 metadata: planFilePath / worktreePath / initialPrompt /
 * phaseLabel）。
 */

import { existsSync } from 'node:fs';
import {
  err,
  ok,
  withMcpGuard,
  type HandlerContext,
} from '../helpers';
import type { HandOffSessionArgs, HandOffSessionResult, SpawnSessionArgs, SpawnSessionResult } from '../schemas';
import { EXTERNAL_CALLER_SENTINEL } from '../../types';
import { sessionRepo } from '@main/store/session-repo';
import { agentDeckTeamRepo } from '@main/store/agent-deck-team-repo';
import { omitUndefined } from '@main/utils/optional-fields';
import {
  handOffSessionImpl,
  _isHandOffSessionError,
  type HandOffSessionDeps,
} from './hand-off-session-impl';
import { spawnSessionHandler } from './spawn';
import { runBatonCleanup } from './baton-cleanup';
import {
  buildAdoptedTeamsContextBlock,
  type AdoptedTeam,
} from './adopted-teams-context-block';
import type { ShutdownTeammatesResult } from './shutdown-teammates-on-baton';

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
  /**
   * CHANGELOG_106 + REVIEW_36 R2 HIGH-A：teammate shutdown helper 的 test seam（与 archive_plan 同款）。
   *
   * REVIEW_36 R2 HIGH-A：seam signature 加可选 `excludeSessionIds` 参数，让 hand-off 把刚 spawn 的新
   * sessionId 显式排除（修前 `team_name=x` baton 路径下新 session 被 spawn handler 加为 teammate，
   * 然后被 helper 一并 close）。default 实现 `(sid, exclude) => shutdownTeammatesOnBaton(sid, { excludeSessionIds: exclude })`。
   */
  shutdownTeammates?: (
    callerSessionId: string,
    excludeSessionIds?: ReadonlySet<string>,
  ) => Promise<ShutdownTeammatesResult>;
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

/**
 * Phase 1.3a (deep-review-batch-a1-b-followup-r3-20260519)：spawn handler `opts.batonMode` /
 * `opts.batonRole` 决策抽 lambda export 让 test 端到端调真实 production lambda 而非 inline
 * 复制合约（不变量 3）。
 *
 * **B-HIGH-2 修法**（plan deep-review-batch-a1-b-fixes-20260519 / REVIEW_46）：旧 impl 无条件
 * `batonMode=true` 让 `archive_caller=false` 也跳 spawn-guards depth check + 不写 spawn-link →
 * caller 持 `archive_caller=false` × N 次调 hand_off 形成无限 spawn 路径绕过 fan-out=5/parent +
 * depth=3 双护栏。修法：条件化 `batonMode`，仅 `archive_caller=true`（默认 baton 语义）跳 depth；
 * `archive_caller=false` 退化 normal spawn 走完整 depth/fan-out/setSpawnLink 与 spawn_session 同款。
 *
 * **M12 修法**（REVIEW_47 codex·B MED-4）：旧 impl 无条件 `batonRole: 'lead'`，即使
 * `archive_caller=false` 退化 normal spawn 也无脑传 'lead' 让 spawn.ts:408 addMember 分支拿到
 * 错误 role（如果同时有 team_name 启用 team 通信）。修法：条件化 batonRole — 仅 `batonMode=true`
 * 真 baton 行为时传 'lead'（新 session 接管 lead 角色防 archiveTeamsIfOrphaned 误触发）；
 * `batonMode=false` 退化 normal spawn → undefined 让 spawn 走默认 'teammate'。
 *
 * `args.team_name` 在签名预留但暂未参与决策 — 当前 `batonMode=true` 不带 team_name 时 spawn
 * 内部 `if (args.team_name && teamIdEarly)` addMember 分支不会跑，batonRole 是 no-op，传
 * 'lead' / undefined 行为一致；但传 undefined 更显式表达 "normal spawn" 语义（M12 修法核心）。
 *
 * @internal Only for __tests__/. Do NOT import from other production files.
 */
export function resolveBatonRoleForSpawn(args: {
  archive_caller?: boolean;
  team_name?: string;
}): { batonMode: boolean; batonRole: 'lead' | 'teammate' | undefined } {
  const batonMode = args.archive_caller !== false;
  const batonRole: 'lead' | 'teammate' | undefined = batonMode ? 'lead' : undefined;
  return { batonMode, batonRole };
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

    // 2. 组装 spawn_session args：cwd 双模式 default(CHANGELOG_99 + REVIEW_36 HIGH-3)。
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
    // CHANGELOG_97：team_name 不再默认设为 plan_id —— baton 单向交接语义不需要 lead/teammate
    // 关系；caller 显式传 team_name 时仍透传给 spawn 启用通信关系（罕见使用）。

    // REVIEW_36 HIGH-3：plan-driven 模式 default cwd 推导。
    // 优先 mainRepo（约定 worktree 走 cwd resilience），外置 worktree 退化 worktreePath
    // （让 sandbox.allowWrite=[cwd, /tmp, ~/.cache] 自然覆盖外置路径，否则
    // workspace-write 写每个文件弹框 / strict 完全卡死）。
    // 严格判定 worktree 在 mainRepo subtree（mainRepo + '/' 防同名前缀误命中
    // 如 `/repo` vs `/repo-other` —— `/repo-other`.startsWith('/repo') === true）。
    let planModeDefaultCwd: string | undefined;
    if (!resolved.mainRepo) {
      planModeDefaultCwd = resolved.worktreePath ?? undefined;
    } else if (!resolved.worktreePath) {
      planModeDefaultCwd = resolved.mainRepo;
    } else {
      const mainRepoWithSep = resolved.mainRepo.endsWith('/')
        ? resolved.mainRepo
        : resolved.mainRepo + '/';
      const isInternalWorktree = resolved.worktreePath.startsWith(mainRepoWithSep);
      planModeDefaultCwd = isInternalWorktree ? resolved.mainRepo : resolved.worktreePath;
    }

    const defaultCwd =
      resolved.mode === 'plan'
        ? planModeDefaultCwd
        : callerSessionCwd ?? resolved.mainRepo ?? undefined;
    const finalCwd = args.cwd ?? defaultCwd;

    // REVIEW_36 R2 MED-C：外置 worktree 场景下 finalCwd=worktreePath，
    // sandbox.allowWrite=[worktreePath, /tmp, cache] 不含 mainRepo → 接力 session
    // 写 mainRepo plan 文件被沙盒拦下（user CLAUDE.md §Step 4 完成时更新 frontmatter
    // status=completed 必写，不能拦）。修法：plan-driven + 外置 worktree → 自动加
    // mainRepo 进 extraAllowWrite。caller 显式传 args.extra_allow_write 优先（合并）。
    let computedExtraAllowWrite: readonly string[] | undefined;
    if (
      resolved.mode === 'plan' &&
      resolved.mainRepo &&
      resolved.worktreePath &&
      finalCwd === resolved.worktreePath
    ) {
      // 外置 worktree 路径已被 default cwd 推导降级到 worktreePath（HIGH-3 fix）→ 加 mainRepo 让 plan 文件可写
      const merged = new Set<string>(args.extra_allow_write ?? []);
      merged.add(resolved.mainRepo);
      computedExtraAllowWrite = Array.from(merged);
    } else {
      // 约定 worktree（finalCwd=mainRepo 已含 mainRepo subtree 写权）/ generic 模式 → 仅 caller 显式
      computedExtraAllowWrite = args.extra_allow_write;
    }
    if (!finalCwd) {
      // 极端边界:plan 模式 mainRepo+worktreePath 都 null(impl 不会发生),
      // 或 generic 模式 callerCwd+mainRepo 都 null(external sentinel + caller cwd 非 git repo,
      // 且 deny external 失效的极端测试场景)。给清晰错误。
      return err(
        `cannot resolve default cwd for new session (mode=${resolved.mode}; pass args.cwd explicitly)`,
        `For plan-driven mode this typically means both git rev-parse fallback and worktreePath heuristic failed. For generic mode this means caller session has no cwd in sessionRepo and git rev-parse failed.`,
      );
    }

    // plan hand-off-session-adopt-teammates-20260520 Phase 4 (D1 + D7 + D11 v8 + N5 + N2.b):
    // adopt_teammates: true 路径 — caller 同 team 其他 active+dormant teammate 原地保留 +
    // 新 session 接管 caller=lead 的 team 当 lead。详 plan §D11 v8 (handler 自拼
    // buildAdoptedTeamsContextBlock,不复用 spawn 的 buildLeadContextBlock + 不写 placeholder)。
    //
    // **N5 ≥1 lead 硬约束 fail-fast**(plan §N5 + Round 4 NEW MED-A1):caller 在所有 team 都
    // 不是 lead(全 teammate / 无 active membership)→ handler **spawn 之前** return err,
    // 不 spawn / 不 archive caller。理由:adopt 语义本质是「caller=lead 把 lead role 转给新
    // session」,caller 不是任何 team 的 lead 时该语义无意义。
    //
    // **N2.c 互斥 invariant** 已在 zod refine 层 reject(adopt_teammates: true 与 args.team_name
    // 不可同传 — schemas.ts HAND_OFF_SESSION_ARGS_SCHEMA.refine);此处 args.team_name 必为
    // undefined,直接走 default baton spawn 路径(spawn handler 不写 placeholder / 不 addMember)。
    //
    // **adopt 路径 cold-start prompt**:
    // - snapshot caller 所有 active membership → filter role==='lead' 拿 callerLeadMemberships
    //   (frozen at this point — Phase 6 phase 1.5 swapLead 改 team_member 表后再反查会丢失
    //   caller=lead 状态)
    // - firstTeam = callerLeadMemberships[0](joined_at DESC ordering = 最近加入)
    // - otherLeadTeams = callerLeadMemberships.slice(1)
    // - 调 buildAdoptedTeamsContextBlock(firstTeam, otherLeadTeams) 装配 prompt prepend block
    // - cold-start prompt = `${adoptedBlock}\n---\n\n${resolved.coldStartPrompt}`
    let coldStartPromptForSDK = resolved.coldStartPrompt;
    let adoptedSnapshot: {
      firstTeamId: string;
      teamsTotal: number;
    } | null = null;
    if (args.adopt_teammates === true) {
      // N5 fail-fast:precheck caller 至少 1 个 lead membership;不读 lead memberships 时直接
      // findActiveMembershipsBySession 失败(external sentinel 时 caller 不在 sessions 表,
      // findActiveMembershipsBySession 返空 → length === 0 → return err — 同 N5 语义)。
      const allCallerMemberships = agentDeckTeamRepo.findActiveMembershipsBySession(
        caller.callerSessionId,
      );
      const callerLeadMemberships = allCallerMemberships.filter((m) => m.role === 'lead');
      if (callerLeadMemberships.length === 0) {
        return err(
          'adopt_teammates 要求 caller 至少在一个 active team 是 lead',
          `caller_session_id ${caller.callerSessionId} 当前在 ${allCallerMemberships.length} 个 active team 内,但全部 role !== 'lead'(全 teammate / 无 lead membership)。adopt 语义本质是「lead 把 lead role 转给新 session」,caller 不是任何 team 的 lead 时该语义无意义。改走 default baton(adopt_teammates: false / 不传)或先确认 caller 在某个 team 是 lead 再重试。`,
        );
      }

      // 装配 adopt 路径 cold-start prompt(详 buildAdoptedTeamsContextBlock 顶部 jsdoc)。
      // teammateSids = listAllMembers(teamId).filter(m => m.leftAt === null && m.sessionId !== callerSid)
      //   (含 active + dormant — sessionRepo lifecycle 维度不参与本筛选;Phase 6 phase 1.5
      //   adopt 流程会另做 lifecycle precheck 区分 closed teammate 进 failed)
      const firstTeamMembership = callerLeadMemberships[0]!;
      const firstTeam: AdoptedTeam = {
        id: firstTeamMembership.teamId,
        name: agentDeckTeamRepo.get(firstTeamMembership.teamId)?.name ?? '(unknown-team-name)',
        teammateSids: agentDeckTeamRepo
          .listAllMembers(firstTeamMembership.teamId)
          .filter((m) => m.leftAt === null && m.sessionId !== caller.callerSessionId)
          .map((m) => m.sessionId),
      };
      const otherLeadTeams: AdoptedTeam[] = callerLeadMemberships.slice(1).map((m) => ({
        id: m.teamId,
        name: agentDeckTeamRepo.get(m.teamId)?.name ?? '(unknown-team-name)',
        teammateSids: agentDeckTeamRepo
          .listAllMembers(m.teamId)
          .filter((mm) => mm.leftAt === null && mm.sessionId !== caller.callerSessionId)
          .map((mm) => mm.sessionId),
      }));

      const adoptedBlock = buildAdoptedTeamsContextBlock({ firstTeam, otherLeadTeams });
      coldStartPromptForSDK = `${adoptedBlock}\n---\n\n${resolved.coldStartPrompt}`;
      adoptedSnapshot = {
        firstTeamId: firstTeamMembership.teamId,
        teamsTotal: callerLeadMemberships.length,
      };
    }

    const spawnArgs: SpawnSessionArgs = {
      adapter: args.adapter ?? 'claude-code',
      cwd: finalCwd,
      // adopt 路径 prompt 含 adoptedBlock prepend;non-adopt 路径用 resolved.coldStartPrompt 原值
      prompt: coldStartPromptForSDK,
      // REVIEW_37 P1-Phase2 (claude F4 LOW)：omitUndefined 收口 4 个简单 spread+ternary。
      // 仅 extra_allow_write（length > 0 语义）保留 inline ternary。
      ...omitUndefined({
        team_name: args.team_name,
        permission_mode: args.permission_mode,
        // REVIEW_36 HIGH-2 修法：sandbox 字段镜像 permission_mode 透传策略
        codex_sandbox: args.codex_sandbox,
        claude_code_sandbox: args.claude_code_sandbox,
      }),
      // REVIEW_36 R2 MED-C 修法：computedExtraAllowWrite 含 mainRepo（外置 worktree 自动加）+
      // caller 显式 args.extra_allow_write 合并去重。仅当非空时透传给 spawn —
      // 留 inline 因要 length > 0 检查（空数组也跳过，omitUndefined 不处理 empty array）
      ...(computedExtraAllowWrite !== undefined && computedExtraAllowWrite.length > 0
        ? { extra_allow_write: [...computedExtraAllowWrite] }
        : {}),
      // caller_session_id 透传：spawn handler 内 makeCtx 已重新算（in-process closure
      // override），但这里用 ctx 直接转发跳过中间层。下方 spawnSessionHandler 接受 ctx 参数
      // 直接传同一个 caller，不依赖 spawn_session 的 args.caller_session_id 字段。
    };

    // 3. 调 spawn handler 完成实际 spawn（透传同一 ctx 让 caller 视角一致）
    // batonMode / batonRole 决策详 `resolveBatonRoleForSpawn` lambda jsdoc（B-HIGH-2 + M12）。
    // spawn handler 端消费语义：
    // - batonMode=true 跳 spawn-guards depth check（spawn-guards.ts:89）+ 不写 spawn-link
    //   （spawn.ts:311；REVIEW_39 baton 不是 spawn parent-child 关系）
    // - batonRole='lead' 让新 session 在 team 内以 lead 角色加入（spawn.ts:408；REVIEW_37 R2
    //   HIGH-1 修法），仅当 args.team_name 真启用 team 通信时被 spawn addMember 分支用到；
    //   不带 team_name 的 baton 不 addMember 时 batonRole 是 no-op。
    const spawnFn = handlerDeps?.spawnSession ?? spawnSessionHandler;
    const { batonMode, batonRole } = resolveBatonRoleForSpawn({
      archive_caller: args.archive_caller,
      team_name: args.team_name,
    });
    const spawnResult = await spawnFn(
      spawnArgs,
      ctx,
      // M12 修法：batonRole 可能是 undefined（archive_caller=false 退化 normal spawn）→ omitUndefined
      // 滤掉 undefined 字段避免 opts.batonRole 显式 undefined 撞 spawn handler 类型边界。
      omitUndefined({ batonMode, batonRole }) as { batonMode: boolean; batonRole?: 'lead' | 'teammate' },
    );
    if (spawnResult.isError) {
      // 透传 spawn 的 error 不再二次包装（避免「hand_off_session error: spawn error: ...」嵌套）
      return spawnResult;
    }

    // 4. parse spawn 的 ok JSON → 包 K2 metadata
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

    // 5. CHANGELOG_109(R37 P2-M Step 3.5): baton cleanup 两段(teammate shutdown + archive caller)
    // 收口到 runBatonCleanup helper(详 baton-cleanup.ts 顶部 jsdoc)。helper 内部串行跑 phase 1
    // (shutdown teammates) → phase 2 (archive caller),失败容错全在 helper 里(单个 close warn /
    // helper 抛错兜底 / archive 失败 warn / DB 异常 fail-safe);handler 这层只透传 input + 把
    // 两个三态结果 spread 进 ok return。
    //
    // baton 单向交接 = caller 会话使命终结,team 里没 lead 后 reviewer-claude / reviewer-codex
    // 等 teammate 应一起收口避免孤儿(占内存 + SDK live query)。plan
    // hand-off-session-adopt-teammates-20260520 Phase 3 删除 phase 1 opt-out 字段;Phase 4 引入
    // adopt_teammates: true 时走独立 phase 1.5 adopt 路径接管 teammate。
    //
    // REVIEW_36 R2 HIGH-A: caller 显式 team_name 时 spawn handler 把新 sid 加为 teammate
    // (spawn.ts:310-317)。如果不通过 excludeSessionIds 排除 → helper 把刚交出 baton 的新 session
    // 也关掉(fix-to-fix bug)。spawnData.sessionId 必有(spawn handler ok return 必带 sessionId
    // 字段),否则前面 isError 短路返回。
    //
    // CHANGELOG_99 R1 fix MED-5: archive 段必须**重新反查** sessionRepo.get 而非复用早期
    // callerSessionRow(L142 段)。spawn 是 long-running async,期间 caller row 可能被删 → 复用
    // 旧探针调 archive 的 UPDATE 对缺失 row 是 no-op 误报 'ok'。helper 内部反查保证 ground truth。
    // spawnData.sessionId 是 SpawnSessionResult.sessionId（cast 后 string，原 typeof 校验是
    // R37 P3-L 前的 Record<string, unknown> 兜底，cast 后 typeof 校验成 redundant 但保留无害）。
    const newSpawnedSid = typeof spawnData.sessionId === 'string' ? spawnData.sessionId : null;
    const excludeSessionIds = newSpawnedSid ? new Set<string>([newSpawnedSid]) : undefined;
    const cleanup = await runBatonCleanup(
      {
        callerSessionId: caller.callerSessionId,
        // hand-off-mcp-archive-opt-20260515: caller archive opt-out。
        // default true(baton 单向交接 = caller 使命终结);仅 caller 显式传 false 跳过。
        archiveCaller: args.archive_caller !== false,
        // plan hand-off-session-adopt-teammates-20260520 Phase 4 (D3 + D5):
        // adopt_teammates: true 透传到 baton-cleanup → phase 1 跳过 shutdownTeammatesOnBaton
        // 标 skipped='adopt-keep-implicit'。teammate 由 phase 1.5 adopt 路径调 swapLead 接管
        // (Phase 4 阶段 phase 1.5 在 hand-off-session.ts handler adopt 分支只装配 cold-start
        // prompt;Phase 6 在 baton-cleanup helper 内调 swapLead 完整化 phase 1.5 流程含
        // listAllMembers + emit + collect preserved/failed)。
        adoptTeammates: args.adopt_teammates === true,
        excludeSessionIds,
        toolName: 'hand_off_session',
      },
      {
        shutdownTeammates: handlerDeps?.shutdownTeammates,
        archiveSession: handlerDeps?.archiveSession,
      },
    );

    return ok({
      // CHANGELOG_99 双模式 metadata
      mode: resolved.mode, // 'plan' | 'generic'
      // K2 metadata（plan 模式有值;generic 模式 plan-only 字段全 null）
      planId: args.plan_id ?? null,
      planFilePath: resolved.planFilePath,
      worktreePath: resolved.worktreePath,
      baseBranch: resolved.baseBranch,
      phaseLabel: resolved.mode === 'plan' ? args.phase_label ?? null : null,
      // plan hand-off-session-adopt-teammates-20260520 Phase 4 (D11 v8 + Round 5 MED-2):
      // initialPrompt 必与 SDK first message 一致(schemas.ts:690-693「完整字面」契约)。
      // adopt 路径返 coldStartPromptForSDK(含 adopted teams context block + user prompt,
      // 不含 wire prefix);non-adopt 路径返 resolved.coldStartPrompt 原值。
      initialPrompt: args.adopt_teammates === true ? coldStartPromptForSDK : resolved.coldStartPrompt,
      /**
       * CHANGELOG_99：generic 模式下 caller 传了 plan-only 字段(phase_label / plan_file_path)
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
       *   adopt_teammates: true 时 teammate 由 swapLead 接管不 shutdown — Phase 3 完成时
       *   未启用) /
       *   null(正常处理含 closed=[] 的 caller=lead 但 team 内无其他 teammate)
       */
      teammatesShutdown: cleanup.teammatesShutdown,
      // plan hand-off-session-adopt-teammates-20260520 Phase 4 (D7 v8) — adopt 路径详情。
      // **Phase 4 阶段中间状态**:swapLead 还没在 baton-cleanup helper 跑(Phase 6 才完整化
      // phase 1.5 流程含 swapLead + listAllMembers + emit),所以 teamsAdopted=0 +
      // preserved=[] + failed=[] 暂不反映真实 adopt 进度;**仅 firstTeamId + teamsTotal 有
      // snapshot 值**(spawn 之前 freeze)。Phase 6 完成后这些字段会含完整 adopt 结果。
      adopted:
        adoptedSnapshot !== null
          ? {
              preserved: [],
              failed: [],
              teamsTotal: adoptedSnapshot.teamsTotal,
              teamsAdopted: 0,
              firstTeamId: adoptedSnapshot.firstTeamId,
            }
          : null,
      // 透传 spawn_session 字段（兼容 spawn 调用方）— spread SpawnSessionResult 全部字段，
      // 与 HandOffSessionResult extends SpawnSessionResult 对应让 satisfies 通过。
      ...spawnData,
      } satisfies HandOffSessionResult);
  },
);
