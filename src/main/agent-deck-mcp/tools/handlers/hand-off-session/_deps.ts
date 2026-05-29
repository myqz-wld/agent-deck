/**
 * hand-off-session shared deps interface（plan deep-project-review-comprehensive-20260528
 * Step 4.1 拆分产物，从原 hand-off-session.ts 1306 LOC facade 抽出 HandOffSessionHandlerDeps
 * 接口定义，给 4 子模块 + facade re-export 共享，避免 facade ↔ handler-main 型循环依赖）。
 *
 * **设计**:facade hand-off-session.ts re-export `HandOffSessionHandlerDeps` 给外部 test
 * (test import path 不动);4 子模块 + handler-main 都直接 import from 本文件,避免任何
 * type re-export cycle。
 */

import type { sessionRepo } from '@main/store/session-repo';
import type { agentDeckTeamRepo } from '@main/store/agent-deck-team-repo';
import type { ReassignOwnerPolicy, ApplyHandOffSkipResult } from '@main/store/task-repo';
import type { HandOffSessionDeps } from '../hand-off-session-impl';
import type { spawnSessionHandler } from '../spawn';
import type { ShutdownTeammatesResult } from '../shutdown-teammates-on-baton';

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
  /**
   * plan hand-off-session-adopt-teammates-20260520 Phase 6 (D4 + D5 + D6 + N8):
   * adopt_teammates: true 路径 phase 1.5 swapLead test seam。default 走
   * agentDeckTeamRepo.swapLead;test 注入控制每个 teamId 的 swap 结果(成功 / swapped:false /
   * throws)验证 firstTeam fatal abort + 非 firstTeam 软失败 partial adopt 路径。
   */
  swapLead?: (
    teamId: string,
    oldLeadSid: string,
    newLeadSid: string,
    opts?: { newDisplayName?: string | null },
  ) => { swapped: true } | { swapped: false; reason: string };
  /**
   * Phase 6 phase 1.5: lifecycle precheck test seam(D6 closed teammate 显式 fail-fast)。
   * default 走 sessionRepo.get;test 注入控制 teammate sessionId 的 lifecycle 返回值(null /
   * 'closed' / 'active' / 'dormant')。
   */
  getSessionForLifecycle?: (sessionId: string) => ReturnType<typeof sessionRepo.get>;
  /**
   * Phase 6 phase 1.5: listAllMembers test seam(拿 swap 后 team 内 teammate 列表做 lifecycle
   * precheck)。default 走 agentDeckTeamRepo.listAllMembers。
   */
  listAllMembersForAdopt?: (teamId: string) => ReturnType<typeof agentDeckTeamRepo.listAllMembers>;
  /**
   * Phase 6 phase 1.5: firstTeam fatal abort 时 shutdown newSid。default 走
   * sessionManager.close;test 注入观察是否调用(关键守门)。
   */
  closeSession?: (sessionId: string) => Promise<void>;
  /**
   * plan task-mcp-owner-session-id-rewrite-20260521 v023 §D3: task 过继 test seam。
   * default 走 taskRepo.reassignOwner;test 注入 spy 验证 spawn 之后、archive caller
   * 之前是否调到 + caller 拥有的 task 行数。失败仅 warn 不阻塞 ok return(task 过继
   * 是 nice-to-have,hand_off baton 本质是 session 接力)。
   *
   * v024 plan task-team-id-restore-20260525 §Step D2 改造:加 policy 参数让 'clear-team' /
   * 'preserve-team' 两态走同款 reassignOwner 接口（'skip' 走独立 applyHandOffSkipPolicy seam,
   * plan §不变量 12）。
   */
  reassignTaskOwner?: (
    oldSessionId: string,
    newSessionId: string,
    opts: { policy: ReassignOwnerPolicy },
  ) => number;
  /**
   * v024 plan §Step D2 'skip' 分支 test seam：default 走 taskRepo.applyHandOffSkipPolicy。
   * test 注入 mock throw 验证 DB throw fallback（Round 4 MED-2 — ok return.taskReassignment
   * status='failed' + error 字段；不抛错给 caller，sane fallback spawn/adopt 已 commit 不回滚）。
   */
  applyHandOffSkipPolicy?: (callerSid: string, newSid: string) => ApplyHandOffSkipResult;
  /**
   * v024 plan §Step D2 preserve-team safety 算法 test seam（Round 4 HIGH-1 修法支撑）：default
   * 走 taskRepo.findOwnedDistinctTeamIds 拿 caller owned distinct non-null team_id 列表。
   * test 注入 mock 控制返回值验证 unadoptedTeamIds 差集算法 + policyWarning 触发条件。
   */
  findCallerOwnedTeamIds?: (callerSid: string) => string[];
}
