/**
 * baton-cleanup.ts —— archive_plan + hand_off_session 共享 baton cleanup 模板（CHANGELOG_109，
 * R37 P2-M Step 3.5）。
 *
 * **抽出动机**：archive_plan 与 hand_off_session 两个 handler 在「impl/spawn 成功后」各自跑
 * ~80 行重复代码,模板 99% 一致(仅 console.warn 前缀和 hand-off 多 excludeSessionIds 不同):
 *
 * 1. **teammate shutdown 三态**(skipped: 'keep-teammates' | 'caller-not-lead' | null)
 *    - external sentinel 防御 → skipped='caller-not-lead'
 *    - keep_teammates=true → skipped='keep-teammates'
 *    - 调 shutdownTeammatesOnBaton(callerSid, excludeSessionIds?) → 透传 result
 *    - helper 抛错 → 兜底 closed=[] + skipped=null + console.warn
 *
 * 2. **archive caller 三态**(archived: 'ok' | 'failed' | 'skipped')
 *    - external sentinel → archived='skipped'
 *    - sessionRepo.get 探针(CHANGELOG_98 / R2 reviewer-codex MED-2): row missing → 'failed' +
 *      warn,不调 archive(避免 UPDATE no-op 误报 'ok')
 *    - 调 sessionManager.archive(callerSid) → 'ok'
 *    - archive 抛错 → 'failed' + warn
 *    - DB 异常 fail-safe → row null + 'failed'(等同 row missing 路径)
 *
 * 抽出后两个 handler 共 ~160 行 → ~20 行(仅传 input + 透传 result)。
 *
 * **时序**(必须严格 phase 1 → phase 2 不能交换):
 *
 *   phase 1: shutdown teammates(caller 仍是 lead,listActiveMembers 拿 teammate 名单)
 *   phase 2: archive caller(archiveTeamsIfOrphaned 触发 0-lead → team auto-archive)
 *
 * 颠倒顺序会让 archive caller 先把 team auto-archive,phase 1 内 listActiveMembers
 * (JOIN sessions archived_at IS NULL)看不到 caller,但 caller 没 archive 之前的 lead
 * 反查还在(findActiveMembershipsBySession 不过滤 archived)→ 行为可能 OK 但语义混乱;
 * 「先清理 member 后退场」更自然。
 *
 * **mock seam**：所有副作用 fn(shutdownTeammates / archiveSession / getSession)通过 deps inject,
 * 让单测无需 mock 整个 sessionManager / sessionRepo / agentDeckTeamRepo。default 实现复用:
 * - shutdownTeammates → shutdownTeammatesOnBaton(含 excludeSessionIds 透传)
 * - archiveSession → sessionManager.archive
 * - getSession → sessionRepo.get
 *
 * **CHANGELOG_99 R1 fix MED-5(hand-off 段历史)**: archive caller 段的 sessionRepo.get 必须
 * **重新反查**(不复用 spawn 之前的 callerSessionRow):spawn / impl 是 long-running async,
 * 期间 caller row 可能被删(用户手动 close / lifecycle scheduler 清理),复用旧探针调 archive
 * 时 UPDATE 对缺失 row 是 no-op → 误报 'ok'。本 helper 内反查,不接受 caller 传入,保证 ground
 * truth。
 *
 * **不**处理 keep_teammates 的 schema 字段读取:caller 在 handler 层读 args.keep_teammates 后
 * 通过 input.keepTeammates: boolean 传入,避免 helper 既懂 schema 字段又懂 caller role 检测的
 * 耦合。
 */

import { sessionRepo } from '@main/store/session-repo';
import { sessionManager } from '@main/session/manager';
import { EXTERNAL_CALLER_SENTINEL } from '../../types';
import {
  shutdownTeammatesOnBaton,
  type ShutdownTeammatesResult,
} from './shutdown-teammates-on-baton';

export interface RunBatonCleanupInput {
  /** caller session id(从 ctx.caller.callerSessionId 透传)。external sentinel 时 helper 走防御短路。 */
  callerSessionId: string;
  /**
   * caller 是否传了 keep_teammates=true(handler 层从 args.keep_teammates 读出)。
   * - true: phase 1 跳过 teammate shutdown,标 skipped='keep-teammates'
   * - false: phase 1 走 shutdownTeammatesOnBaton(default 调真 helper 含 sessionManager.close)
   */
  keepTeammates: boolean;
  /**
   * 可选 sid 集合让 shutdownTeammatesOnBaton 跳过这些 sid。
   *
   * **典型场景**: hand-off-session(team_name=x) 显式 spawn 新 session 后立即 baton cleanup —
   * 新 session 已被 spawn handler 加为 teammate(spawn.ts:310-317),不排除会被 helper 误关
   * (REVIEW_36 R2 HIGH-A fix-to-fix bug)。caller 把新 spawn sessionId 传入 excludeSessionIds
   * 即可豁免。
   *
   * archive_plan 不传(plan 收口前不 spawn 新 session,无需排除)。
   */
  excludeSessionIds?: ReadonlySet<string>;
  /**
   * console.warn 前缀的工具名(如 'archive_plan' / 'hand_off_session'),拼成 `[mcp <toolName>] ...`
   * 帮调试时分辨哪个 handler 触发的 cleanup。
   *
   * test 断言核心 substring 与 toolName 无关(`shutdownTeammatesOnBaton helper failed for caller <sid>`
   * / `cannot archive caller <sid>: not in sessions table` / `archive caller <sid> failed:`),
   * 但 toolName 让 stderr 实际看到的 warn 行更易定位。
   */
  toolName: string;
}

export interface RunBatonCleanupDeps {
  /**
   * test seam: teammate shutdown helper(默认 shutdownTeammatesOnBaton 含 excludeSessionIds 透传)。
   *
   * REVIEW_36 R2 HIGH-A: signature 加可选第二参 excludeSessionIds 让 hand-off 排除新 spawn sid。
   * default 实现 `(sid, exclude) => shutdownTeammatesOnBaton(sid, { excludeSessionIds: exclude })`。
   */
  shutdownTeammates?: (
    callerSessionId: string,
    excludeSessionIds?: ReadonlySet<string>,
  ) => Promise<ShutdownTeammatesResult>;
  /** test seam: archive caller(默认 sessionManager.archive),让单测无需 mock 整个 sessionManager。 */
  archiveSession?: (sessionId: string) => Promise<void>;
  /**
   * test seam: sessionRepo.get(默认走真 sessionRepo)。让单测可控制 caller row 探针返回值
   * (row missing → archive='failed' / row OK → 走 archiveFn)。
   */
  getSession?: (sessionId: string) => ReturnType<typeof sessionRepo.get>;
}

export interface RunBatonCleanupResult {
  /**
   * Phase 1 结果(直接来自 shutdownTeammatesOnBaton 或兜底默认值):
   * - closed: 成功 close 的 teammate sid 列表(已 dedup 跨 team 共享同 sid)
   * - failed: close 失败的 teammate(含 reason),warn 不阻塞
   * - skipped: 'keep-teammates'(caller 显式) / 'caller-not-lead'(caller 不是 lead) /
   *   null(正常处理含 closed=[] 的 caller=lead 但 team 内无其他 teammate / helper 抛错兜底)
   */
  teammatesShutdown: ShutdownTeammatesResult;
  /**
   * Phase 2 结果:
   * - 'ok' = caller 归档成功
   * - 'failed' = warn-only 不阻塞(callerRow 缺 / DB 不可用 / archive 抛错)
   * - 'skipped' = external caller(理论上 deny external 拦截不到这里,防御性双保险)
   */
  archived: 'ok' | 'failed' | 'skipped';
}

/**
 * 运行 baton cleanup 的两阶段模板。返回字段对应 archive_plan / hand_off_session ok return
 * 里的 `teammatesShutdown` + `archived` 字段(caller 直接 spread 即可)。
 *
 * ⚠️ caller 必须**只在 impl/spawn 成功后**调用本 helper。impl/spawn 失败短路(plan 收口
 * 没成功 / baton 没成功)时 caller 应直接 return 不调本 helper(否则会把 teammate 一起牵连)。
 *
 * 失败容错语义:
 * - phase 1 helper 抛错 → 兜底 + warn,不影响 phase 2 archive caller(plan 收口已成功不该被
 *   helper 故障带崩)
 * - phase 2 archive 失败 → 'failed' + warn,return 不阻塞(caller 仍 ok return,用户手动归档)
 * - DB 异常 fail-safe → 走 row missing 路径标 'failed'
 */
export async function runBatonCleanup(
  input: RunBatonCleanupInput,
  deps?: RunBatonCleanupDeps,
): Promise<RunBatonCleanupResult> {
  // external sentinel 防御短路(deny external 已在 handler 层拦下,这里双保险)。
  // archive='skipped' 准确反映「未尝试归档」语义,与 row missing 'failed' 区分开。
  if (input.callerSessionId === EXTERNAL_CALLER_SENTINEL) {
    return {
      teammatesShutdown: { closed: [], failed: [], skipped: 'caller-not-lead' },
      archived: 'skipped',
    };
  }

  // ─── Phase 1: teammate shutdown ─────────────────────────────────
  let teammatesShutdown: ShutdownTeammatesResult;
  if (input.keepTeammates === true) {
    // caller 显式传 keep_teammates=true(典型: lead 想保留 reviewer 给后续会话用,或显式传
    // team_name 让新 session 接管 lead 角色)→ 跳过 helper 调用直接标 skipped。
    teammatesShutdown = { closed: [], failed: [], skipped: 'keep-teammates' };
  } else {
    const shutdownFn =
      deps?.shutdownTeammates ??
      ((callerSid: string, exclude?: ReadonlySet<string>) =>
        shutdownTeammatesOnBaton(callerSid, { excludeSessionIds: exclude }));
    try {
      teammatesShutdown = await shutdownFn(input.callerSessionId, input.excludeSessionIds);
    } catch (e) {
      // helper 自身抛错(罕见: 反查 DB 异常 / mock 失败)→ 兜底 + warn,phase 2 仍正常走
      // (不让 helper 故障阻塞 plan 收口 / baton 收口)。
      console.warn(
        `[mcp ${input.toolName}] shutdownTeammatesOnBaton helper failed for caller ${input.callerSessionId}:`,
        e,
      );
      teammatesShutdown = { closed: [], failed: [], skipped: null };
    }
  }

  // ─── Phase 2: archive caller ────────────────────────────────────
  // archive 前 sessionRepo.get 探针(CHANGELOG_98 / R2 reviewer-codex MED-2):
  // session 异常被清理 / 边界状态 / spawn 期间 row 被删 → archived='failed' 不报 'ok'
  // (UPDATE 对缺失 row 是 no-op 误报)。
  // CHANGELOG_99 R1 fix MED-5: 重新反查 ground truth(不复用 spawn 之前的探针),spawn 是
  // long-running async,期间 caller row 可能被删。本 helper 内反查保证 spawn 后 ground truth。
  let callerRow: ReturnType<typeof sessionRepo.get> = null;
  const getFn = deps?.getSession ?? ((sid: string) => sessionRepo.get(sid));
  try {
    callerRow = getFn(input.callerSessionId);
  } catch {
    // DB 异常 fail-safe(typical: test 环境 DB 未 init / 生产 SQLite locked / FK conflict)→
    // 留 null,按 row missing 路径 'failed'。
    callerRow = null;
  }
  if (!callerRow) {
    console.warn(
      `[mcp ${input.toolName}] cannot archive caller ${input.callerSessionId}: not in sessions table (异常被清理 / 边界状态 / 长 async 期间 row 被删)`,
    );
    return { teammatesShutdown, archived: 'failed' };
  }

  const archiveFn = deps?.archiveSession ?? ((sid: string) => sessionManager.archive(sid));
  try {
    await archiveFn(input.callerSessionId);
    return { teammatesShutdown, archived: 'ok' };
  } catch (e) {
    console.warn(
      `[mcp ${input.toolName}] archive caller ${input.callerSessionId} failed:`,
      e,
    );
    return { teammatesShutdown, archived: 'failed' };
  }
}
