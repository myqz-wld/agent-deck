/**
 * baton-cleanup.ts —— archive_plan + hand_off_session 共享 baton cleanup 模板（CHANGELOG_109，
 * R37 P2-M Step 3.5）。
 *
 * **抽出动机**：archive_plan 与 hand_off_session 两个 handler 在「impl/spawn 成功后」各自跑
 * ~80 行重复代码,模板 99% 一致(仅 console.warn 前缀和 hand-off 多 excludeSessionIds 不同):
 *
 * 1. **teammate shutdown 六态**(skipped: 'caller-not-lead' | 'all-lead-teams-archived' |
 *    'adopt-keep-implicit' | 'archive-caller-false-keep' | 'phase-1-error' | null;
 *    plan hand-off-session-adopt-teammates-20260520 Phase 3 删 baton-cleanup teammate-shutdown
 *    的 opt-out 字段后,后续 Phase 4 / CHANGELOG_169 F4 / REVIEW_56 §F6 R2 修法逐步引入剩余
 *    skipped 值)
 *    - external sentinel 防御 → skipped='caller-not-lead'
 *    - caller 是 lead 但所有 team 已 archived → skipped='all-lead-teams-archived'(REVIEW_56 §F6 R2)
 *    - adopt_teammates=true(teammate 已转给 newSid) → skipped='adopt-keep-implicit'(Phase 4)
 *    - archive_caller=false(caller 保活) → skipped='archive-caller-false-keep'(CHANGELOG_169 F4)
 *    - phase 1 内部 throw 兜底 → skipped='phase-1-error'(REVIEW_56 §F6 Plan-Review Round 2 codex MED-3)
 *    - 调 shutdownTeammatesOnBaton(callerSid, excludeSessionIds?) → 透传 result
 *    - helper 抛错 → 兜底 closed=[] + skipped='phase-1-error' + console.warn
 *
 * 2. **archive caller 三态**(archived: 'ok' | 'failed' | 'skipped')
 *    - external sentinel → archived='skipped'
 *    - **archive_caller=false 显式 opt-out**(hand-off-mcp-archive-opt-20260515)→ archived='skipped'
 *      (与 external sentinel 同款 'skipped' 值,不同来源:caller 显式意图 vs 防御短路)
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
 * **plan hand-off-session-adopt-teammates-20260520 Phase 3 简化** (D2 + N4): 删除 phase 1
 * teammate-shutdown opt-out 字段。default 行为永远调 shutdownTeammatesOnBaton(caller 显式
 * 接管 teammate 走 hand_off_session adopt_teammates: true,详 plan Phase 4 — 那时再加
 * `adoptTeammates: boolean` 入参标 skipped='adopt-keep-implicit')。Phase 3 期间 helper
 * 入参仅剩 callerSessionId / excludeSessionIds / archiveCaller / toolName,phase 1 永远跑
 * shutdownFn 不带分支。
 */

import { sessionRepo, SessionRowMissingError } from '@main/store/session-repo';
import { sessionManager } from '@main/session/manager';
import { eventBus } from '@main/event-bus';
import type { EventMap } from '@main/event-bus';
import { EXTERNAL_CALLER_SENTINEL } from '../../types';
import {
  shutdownTeammatesOnBaton,
  type ShutdownTeammatesResult,
} from './shutdown-teammates-on-baton';

export interface RunBatonCleanupInput {
  /** caller session id(从 ctx.caller.callerSessionId 透传)。external sentinel 时 helper 走防御短路。 */
  callerSessionId: string;
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
   * hand-off-mcp-archive-opt-20260515: caller 是否要归档(handler 层从 args.archive_caller 读出)。
   * - true (default,不传时按 true 走): phase 2 走 sessionRepo.get + sessionManager.archive 完整流程
   * - false: phase 2 跳过,标 archived='skipped' (与 external sentinel 同款 'skipped' 值,不同来源)
   *
   * **典型场景**: hand_off_session caller 想起新 session 并行做事(更接近 spawn 用法),自己仍要
   * 继续观察 reviewer reply / 出 summary,显式传 archive_caller=false 跳过 archive 让 caller still active。
   *
   * archive_plan 不传(plan 收口 = caller 使命终结必归档,语义上不应 opt-out)— optional + default true 保持
   * archive_plan handler 调用方零改动向后兼容。
   *
   * 与其他 opt-out 字段(若未来新增)互相独立。
   */
  archiveCaller?: boolean;
  /**
   * plan hand-off-session-adopt-teammates-20260520 Phase 4 (D3 + D5): hand_off_session
   * caller 是否显式传 adopt_teammates=true 让新 session 接管 teammate(handler 层从
   * args.adopt_teammates 读出)。
   *
   * - **undefined / false (default)**: phase 1 走 shutdownTeammatesOnBaton(default 行为,
   *   关 teammate)+ phase 2 archive caller
   * - **true**: phase 1 跳过 shutdownTeammatesOnBaton 标 skipped='adopt-keep-implicit'
   *   (teammate 由 hand-off-session.ts handler phase 1.5 adopt 路径调 swapLead 接管 — Phase 4
   *   阶段 phase 1.5 在 hand-off-session.ts handler 内,Phase 6 移到 baton-cleanup helper 内)
   *
   * **archive_plan 不传**(plan 收口 = caller 使命终结,teammate 一并 shutdown,语义上不应
   * opt-out 接管)— optional + default 行为对 archive_plan 调用方零改动向后兼容。
   *
   * **与 archiveCaller 配合**(CHANGELOG_169 F4 修法):**archive_caller=false 也跳过 phase 1**
   * (标 skipped='archive-caller-false-keep')— caller 仍 active 当 lead 时 teammates 也保留
   * alive 让 caller 继续观察 reviewer reply(对应 schema 文案承诺)。adopt_teammates=true +
   * archive_caller=false 同传时优先 adopt 分支(同款效果都是 teammates 留 alive 但 skipped
   * 标识不同来源)。
   */
  adoptTeammates?: boolean;
  /**
   * console.warn 前缀的工具名(union narrow,archive-toctou-fix-20260515 plan):
   * - 'archive_plan': mcp archive_plan handler 调用
   * - 'hand_off_session': mcp hand_off_session handler 调用
   *
   * K3 SessionHandOffSpawn 走独立 archiveSourceSessionWithEmit helper 不经本路径,
   * 故 union 仅 2 值。新增 mcp tool 走本 helper 必须先在 EventMap 'caller-archive-failed'
   * payload toolName union 加值,然后在此同步 narrow,否则 emit 时 tsc 报错(✅ feature)。
   *
   * test 断言核心 substring 与 toolName 无关(`shutdownTeammatesOnBaton helper failed for caller <sid>`
   * / `cannot archive caller <sid>: not in sessions table` / `archive caller <sid> failed:`),
   * 但 toolName 让 stderr 实际看到的 warn 行更易定位。
   */
  toolName: 'archive_plan' | 'hand_off_session';
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
  /**
   * test seam: emit 'caller-archive-failed' event(默认 eventBus.emit)。让单测可断言 emit
   * 调用 + payload schema 不需 mock 整个 eventBus 模块。
   *
   * archive-failure-ux-upthrow-20260515 plan: row missing 短路 + archiveFn 抛错两处都调用
   * 此 emit 上抛失败给 main bootstrap listener → notifyUser + IPC channel。
   */
  emitArchiveFailed?: (payload: EventMap['caller-archive-failed'][0]) => void;
}

export interface RunBatonCleanupResult {
  /**
   * Phase 1 结果(直接来自 shutdownTeammatesOnBaton 或兜底默认值):
   * - closed: 成功 close 的 teammate sid 列表(已 dedup 跨 team 共享同 sid)
   * - failed: close 失败的 teammate(含 reason),warn 不阻塞
   * - skipped 五态(REVIEW_56 §F6 + 历史 R2 + Phase 4 累积):
   *   - 'caller-not-lead': caller 不是 lead(含 external sentinel)
   *   - 'all-lead-teams-archived': caller 是 lead 但所有相关 team 已 archived(R2 修法 UX 精度)
   *   - 'adopt-keep-implicit': hand_off_session adopt_teammates: true 时 teammate 由 swapLead
   *      接管不 shutdown — Phase 4 引入,Phase 3 阶段类型预留不出现
   *   - 'phase-1-error': **REVIEW_56 §F6 修法 (Plan-Review Round 2 codex MED-3)**: 本 caller layer
   *      catch block 兜底标 — `shutdownTeammatesOnBaton` helper 抛错(DB 异常 / mock 失败)时区分
   *      于 null 「正常无 teammate」
   *   - null: 正常处理含 closed=[] 的 caller=lead 但 team 内无其他 active teammate
   */
  teammatesShutdown: ShutdownTeammatesResult;
  /**
   * Phase 2 结果:
   * - 'ok' = caller 归档成功
   * - 'failed' = warn-only 不阻塞(callerRow 缺 / DB 不可用 / archive 抛错)
   * - 'skipped' = external caller(防御短路) **或** caller 显式传 archive_caller=false 跳过
   *   (hand-off-mcp-archive-opt-20260515 — 与 external sentinel 同款值不同来源)
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
  // plan hand-off-session-adopt-teammates-20260520 Phase 3 简化(D2 + N4): 删除 phase 1
  // teammate-shutdown opt-out 字段。default 永远调 shutdownTeammatesOnBaton。
  //
  // **Phase 4 (D3 + D5)**: adopt_teammates=true 时跳过本 helper 标 skipped='adopt-keep-implicit'
  // — teammate 由 hand-off-session.ts handler phase 1.5 adopt 路径调 swapLead 接管(Phase 4
  // 阶段 phase 1.5 在 hand-off-session.ts handler 内;Phase 6 移到 baton-cleanup helper 内
  // 完整化 phase 1.5 流程含 swapLead + listAllMembers + emit + collect preserved/failed)。
  //
  // **CHANGELOG_169 F4 修法**(reviewer-codex MED finding): archiveCaller=false 时也跳过 phase 1
  // 标 skipped='archive-caller-false-keep'。schema 文案承诺「caller 仍可看 reviewer reply」
  // 的隐含语义要求 teammates 也保留 alive,不然 caller 看到的是已关闭的 reviewer。
  let teammatesShutdown: ShutdownTeammatesResult;
  if (input.adoptTeammates === true) {
    // Phase 4: adopt 路径下不调 shutdownTeammatesOnBaton,标 skipped='adopt-keep-implicit'
    // (与 'caller-not-lead' 三态 union 对齐)。caller 仍是 lead 但 teammate 由新 session
    // 接管 — 详 hand-off-session.ts handler adopt 分支。
    teammatesShutdown = { closed: [], failed: [], skipped: 'adopt-keep-implicit' };
  } else if (input.archiveCaller === false) {
    // CHANGELOG_169 F4: caller 显式 archive_caller=false 也跳过 phase 1。caller 仍 active 当
    // lead,teammates 留 alive 让 caller 继续观察 reviewer reply(schema 文案承诺)。
    teammatesShutdown = { closed: [], failed: [], skipped: 'archive-caller-false-keep' };
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
      // REVIEW_56 §F6 修法 (Plan-Review Round 2 codex MED-3): helper 抛错兜底改标 'phase-1-error'
      // 第五态(原 null 与「正常无 teammate」混淆),便于 UX / 监控分辨「helper 真错」vs
      // 「正常 caller=lead 但无其他 active teammate」。
      teammatesShutdown = { closed: [], failed: [], skipped: 'phase-1-error' };
    }
  }

  // ─── Phase 2: archive caller ────────────────────────────────────
  // hand-off-mcp-archive-opt-20260515: caller 显式传 archive_caller=false → 跳过 phase 2 标
  // archived='skipped'。与 external sentinel 短路同款 'skipped' 值,但来源不同(external = 防御
  // 短路,archive_caller=false = 显式 caller 意图)。跳过路径不调 getFn / archiveFn,零副作用。
  if (input.archiveCaller === false) {
    return { teammatesShutdown, archived: 'skipped' };
  }

  // archive 前 sessionRepo.get 探针(CHANGELOG_98 / R2 reviewer-codex MED-2):
  // session 异常被清理 / 边界状态 / spawn 期间 row 被删 → archived='failed' 不报 'ok'
  // (UPDATE 对缺失 row 是 no-op 误报 — archive-toctou-fix-20260515 plan setArchived 已 throw
  // SessionRowMissingError,但探针仍是第一道闸门让常见 row missing 不必走 archive 段)。
  // CHANGELOG_99 R1 fix MED-5: 重新反查 ground truth(不复用 spawn 之前的探针),spawn 是
  // long-running async,期间 caller row 可能被删。本 helper 内反查保证 spawn 后 ground truth。
  // archive-failure-ux-upthrow-20260515 plan: row missing / probe-throw / archive throw 三处
  // 失败时都调 emitFn 上抛 'caller-archive-failed' event,main bootstrap listener 桥到 notifyUser
  // + IPC channel,避免 archive='failed' 字段被 caller 静默吞掉用户感知不到。
  // archive-toctou-fix-20260515 plan: probe try/catch 拆出 'probe-throw' 独立 reasonKind
  // (DB 异常可重试,与 row 真不存在的 'row-missing' 区分),修前老语义把 DB probe 异常误归
  // row-missing 隐藏 UI 重试入口(LOW probe-throw bug)。
  const emitFn =
    deps?.emitArchiveFailed ??
    ((payload: EventMap['caller-archive-failed'][0]) => eventBus.emit('caller-archive-failed', payload));
  let callerRow: ReturnType<typeof sessionRepo.get> = null;
  let probeError: { reason: string } | null = null;
  const getFn = deps?.getSession ?? ((sid: string) => sessionRepo.get(sid));
  try {
    callerRow = getFn(input.callerSessionId);
  } catch (e) {
    // archive-toctou-fix-20260515 plan: probe 抛错独立分支 — DB 异常 (SQLite locked / read failure)
    // 状态未知 row 可能仍存在,与 row 真不存在的 'row-missing' 区分。reasonKind='probe-throw' 让 UI
    // 显示「重试归档」按钮(同 'archive-throw' 重试路径,但 reason 文案区分 DB probe 错与 archive 错)。
    const errStr = e instanceof Error ? `${e.message}` : String(e);
    probeError = { reason: `probe getSession threw for ${input.callerSessionId}: ${errStr}` };
  }
  if (probeError) {
    console.warn(`[mcp ${input.toolName}] ${probeError.reason}`);
    emitFn({
      sessionId: input.callerSessionId,
      toolName: input.toolName,
      reason: probeError.reason,
      reasonKind: 'probe-throw',
    });
    return { teammatesShutdown, archived: 'failed' };
  }
  if (!callerRow) {
    const reason = `cannot archive caller ${input.callerSessionId}: not in sessions table (异常被清理 / 边界状态 / 长 async 期间 row 被删)`;
    console.warn(`[mcp ${input.toolName}] ${reason}`);
    // 上抛 row-missing: row 不存在 → 重试归档无效, UI 仅告知。
    emitFn({
      sessionId: input.callerSessionId,
      toolName: input.toolName,
      reason,
      reasonKind: 'row-missing',
    });
    return { teammatesShutdown, archived: 'failed' };
  }

  const archiveFn = deps?.archiveSession ?? ((sid: string) => sessionManager.archive(sid));
  try {
    await archiveFn(input.callerSessionId);
    return { teammatesShutdown, archived: 'ok' };
  } catch (e) {
    // archive-toctou-fix-20260515 plan: 用 instanceof SessionRowMissingError 区分 setArchived no-op
    // (race window: probe OK 后 row 被外部删) vs 真 archive 异常 (FK constraint / DB locked / etc)。
    // 修前 catch-all 把 setter no-op 误归 'archive-throw' (UI 显示「重试归档」误导用户:row 真不存在
    // 重试无效),修后 instanceof 判别准确反射 reasonKind 给 UI(R1 reviewer-codex MED-1 修法)。
    const isRowMissing = e instanceof SessionRowMissingError;
    const errStr = e instanceof Error ? `${e.message}` : String(e);
    const reason = isRowMissing
      ? `cannot archive caller ${input.callerSessionId}: ${errStr} (race window: probe OK 后 setArchived no-op)`
      : `archive caller ${input.callerSessionId} failed: ${errStr}`;
    console.warn(
      `[mcp ${input.toolName}] ${
        isRowMissing
          ? `archive caller ${input.callerSessionId} setArchived no-op (race window)`
          : `archive caller ${input.callerSessionId} failed`
      }:`,
      e,
    );
    emitFn({
      sessionId: input.callerSessionId,
      toolName: input.toolName,
      reason,
      reasonKind: isRowMissing ? 'row-missing' : 'archive-throw',
    });
    return { teammatesShutdown, archived: 'failed' };
  }
}
