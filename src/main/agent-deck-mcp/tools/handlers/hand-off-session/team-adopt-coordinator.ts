/**
 * hand-off-session team-adopt-coordinator 子模块（plan deep-project-review-comprehensive-20260528
 * Step 4.1 拆分产物，从原 hand-off-session.ts 1306 LOC facade 抽出 adoptTeammates 路径
 * 整套逻辑：互斥校验 + N5 fail-fast precheck + memberships 分类 + adoptedSnapshot 装配 +
 * cold-start prompt prepend + phase 1.5 swapLead loop + processSwappedTeam helper）。
 *
 * 责任：
 * - N2.c 互斥 invariant 双层防御（adoptTeammates 与 teamName 不可同传）
 * - allCallerMemberships 分类（callerLeadMemberships / teammateOnlyTeamIds / archivedTeamIds /
 *   notFoundTeamIds）
 * - N5 ≥1 lead 硬约束 fail-fast（caller 不是任何 active team 的 lead → err 不 spawn）
 * - adoptedSnapshot 装配（firstTeam + otherLeadTeams + teamsTotal）
 * - cold-start prompt prepend（buildAdoptedTeamsContextBlock）
 * - phase 1.5 swapLead loop：firstTeam 失败 fatal abort（close newSid + 不 archive caller）
 *   非 firstTeam 失败 push failed continue
 * - processSwappedTeam helper（listAllMembers + lifecycle precheck + N8 emit safeEmit 兜底）
 *
 * **设计**：handler-main 通过 `prepareAdoptSnapshotAndPrompt` 拿 adoptedSnapshot + prompt,
 * spawn 完成拿 newSpawnedSid 后再调 `runPhase15AdoptSwapLeadLoop`。两段拆分让 spawn
 * 调用边界清晰（adopt 前装配 → spawn → adopt 后 swap）。
 */

import { err, type HandlerResult } from '../../helpers';
import type { HandOffSessionArgs } from '../../schemas';
import type { HandOffSessionHandlerDeps } from './_deps';
import { sessionRepo } from '@main/store/session-repo';
import { sessionManager } from '@main/session/manager';
import { agentDeckTeamRepo } from '@main/store/agent-deck-team-repo';
import { eventBus } from '@main/event-bus';
import {
  buildAdoptedTeamsContextBlock,
  type AdoptedTeam,
} from '../adopted-teams-context-block';

/**
 * adoptedSnapshot — adoptTeammates: true 路径下 cold-start prompt 装配 + phase 1.5
 * swapLead loop 共享 state。snapshot 在 prompt 装配阶段 frozen（Phase 6 phase 1.5
 * swapLead 改 team_member 表后再反查会丢失 caller=lead 状态）。
 */
export interface AdoptedSnapshot {
  firstTeamId: string;
  /**
   * Phase 7 reviewer-codex Round 2 LOW + Round 3 polish 修法:teamsTotal 改算
   * active eligibility 内的 team 数(callerLead + teammateOnly,排 archived ghost)。
   * 数学:teamsTotal === callerLeadMemberships.length + teammateOnlyTeamIds.length;
   * 与 send_message active shared-team 边界一致。
   */
  teamsTotal: number;
  /** Phase 6: phase 1.5 swapLead loop 用的 team id 顺序(firstTeamId 在 [0],其他在 slice(1)) */
  callerLeadTeamIds: string[];
  /**
   * Phase 6 D5 step 2 (plan §N5 line 119): caller 是 teammate 的 team 进 failed,reason=
   * 'caller-not-lead-in-team' — 让 caller 看到为什么 some team 没 adopt(snapshot 时已分流,
   * 不进 swapLead loop 但要透传到 ok return.adopted.failed)。
   */
  teammateOnlyTeamIds: string[];
  /**
   * Phase 7 reviewer-codex Round 2 LOW + Round 3 LOW polish 修法:caller 在
   * archived team 的 ghost membership(role 不论 lead / teammate)进 failed
   * reason='team-archived' — 让 caller 看到为什么 some team 没 adopt。修前
   * (commit 4ca89e5)只 caller=lead 的 archived team 进此字段,caller=teammate
   * 在 archived team 仍 push 'caller-not-lead-in-team' 与「teamsTotal 排除
   * archived ghost」语义不一致。修后 archived 不论 role 一致。
   */
  archivedTeamIds: string[];
  /**
   * Follow-up INFO-7 修法:caller membership 指向的 team row 不存在(DB 不一致罕见
   * corner case,FK 约束 ON DELETE 应拦,defense in depth)— push failed reason=
   * 'team-not-found' 与 archived 区分,future debug DB 不一致更易定位。
   */
  notFoundTeamIds: string[];
}

/**
 * Phase 1.5 adopt swapLead loop 结果。
 *
 * v024 plan §Step D2 + Round 4 HIGH-1 + Round 5 LOW-2 修法:与 `preserved`(teammate
 * sids)对称暴露 swapLead 成功的 caller-as-lead team uuids。preserve-team safety 算法
 * 用此与 newSidActiveTeamIds 比对差集 → policyWarning='preserve-team-unadopted-teams'
 * + unadoptedTeamIds 字段（plan §不变量 5）。
 *
 * **L814 firstTeam path + L839 rest loop 双 push**(Round 4 HIGH-1):processSwappedTeam
 * helper 内集中 push 避免双 push 漂移（Round 4 实施 hint）。helper 在 firstTeam 与
 * rest loop swapLead 成功后**都**调用,集中 push 让缺一处 implementer 改不漏。
 */
export interface Phase15Detail {
  preserved: string[];
  failed: Array<{ sid: string; reason: string; teamId: string }>;
  teamsAdopted: number;
  adoptedTeamIds: string[];
}

/**
 * N2.c 互斥 invariant 双层防御（Phase 7 reviewer-codex HIGH 修法）：
 * - schema 层 zod refine reject（schemas.ts HAND_OFF_SESSION_ARGS_SCHEMA.refine）
 * - handler 入口防御性硬约束（本节）— 因为生产 mcp tool 注册路径走 SHAPE 不跑 strict.refine,
 *   schema 守门只在 *.test.ts 显式调 ARGS_SCHEMA.safeParse 时生效
 *
 * 此处防御性 reject 让生产路径(in-process / HTTP / stdio transport)同传时立即 fail-fast,
 * 避免 args.teamName 透传给 spawn → spawn 内 batonRole='lead' 写新 sid 进 teamName 的
 * team → swapLead 之后形成 dual-lead window(N1 violation)/ silent prompt 数据丢失
 * (cold-start prompt 仅含 callerLeadMemberships,不含 args.teamName)。
 */
export function validateAdoptTeammatesArgs(args: HandOffSessionArgs): HandlerResult | null {
  if (args.adoptTeammates === true && args.teamName !== undefined) {
    return err(
      'adoptTeammates 与 teamName 不可同传',
      'adopt 路径自动过继 caller 同 team(走 swapLead transaction),与显式额外 teamName(spawn 内 addMember 写新 sid as lead)语义冲突 — 同传会形成 spawn 写 lead → swapLead demote caller 之间的 dual-lead window 破坏 N1 invariant,且 cold-start prompt 仅含 callerLeadMemberships 不含额外 team 形成 silent prompt 数据丢失。改用 adoptTeammates: false + 显式 teamName 走 default spawn,或 adoptTeammates: true 不传 teamName 走 adopt 自动过继。',
    );
  }
  return null;
}

/**
 * adoptTeammates: true 路径 — 准备 adoptedSnapshot + 装配 cold-start prompt prepend block。
 *
 * adoptTeammates 不为 true 时直接 short-circuit 返 `{ adoptedSnapshot: null, coldStartPrompt }`,
 * caller 用 resolved.coldStartPrompt 原值即可。
 *
 * **N5 ≥1 lead 硬约束 fail-fast**(plan §N5 + Round 4 NEW MED-A1):caller 在所有 team 都
 * 不是 lead(全 teammate / 无 active membership)→ handler **spawn 之前** return err,
 * 不 spawn / 不 archive caller。
 *
 * **Phase 7 reviewer-codex Round 1 MED 修法**:findActiveMembershipsBySession 只过滤 left_at
 * IS NULL,不 JOIN agent_deck_teams / sessions 过滤 archived_at,与 send_message 的
 * findSharedActiveTeams 强制 archived 过滤(member-query.ts:147-158)边界不一致 →
 * adopt 把 archived team 误算 lead membership → cold-start prompt 列 archived team
 * 让新 session 发消息撞 no-shared-team(silent dual-team-broken bug)。修法:
 * filter 加 team archivedAt === null 守门(用 adopt-local filter 不动公共 helper
 * 避免影响其他 caller — REVIEW_35 LOW-A1 / REVIEW_32 HIGH-2 等历史 caller 期望)。
 *
 * **Phase 7 reviewer-codex Round 2 修法**(MED + LOW):分类 active / archived ghost
 * memberships,让 prompt 装配 + teamsTotal + failed 语义对齐 send_message
 * active shared-team 边界。
 *
 * **Phase 7 reviewer-codex Round 3 LOW polish**:caller=teammate 在 archived team
 * 也走 archived 分支(reason='team-archived'),与 caller=lead 在 archived team
 * 一致(commit 4ca89e5 之前 caller=teammate 不查 team archived 是 spy-less safety
 * trade-off,polish 后给 T4.7 加 spy 让所有 caller role 都查 team archived,语义
 * 与 schemas.ts/文档「teamsTotal 排除 archived ghost」严格对齐)。
 *
 * **Phase 7 reviewer-codex Round 2 MED 修法**(prompt 装配 archived teammate filter):
 * sessionManager.archive() 不调 leaveTeam(session/manager.ts:331-340),archived
 * teammate 的 team_member 行 leftAt 仍 null → 修前装配仅过滤 leftAt → archived
 * teammate 进 prompt teammateSids → 新 session 调 send_message 撞 findSharedActiveTeams
 * 强制 sb.archived_at IS NULL → 拒(silent prompt-listed-but-unreachable bug)。
 * 修法:装配时一起做 sessionRepo lifecycle/archived precheck,与 phase 1.5 lifecycle
 * precheck 同款 eligibility(missing / closed / archived 都不进 prompt)。phase 1.5
 * 仍 push failed 让 caller 通过 ok return 看到原因。
 */
export function prepareAdoptSnapshotAndPrompt(
  args: HandOffSessionArgs,
  callerSessionId: string,
  baseColdStartPrompt: string,
  handlerDeps: HandOffSessionHandlerDeps | undefined,
):
  | { adoptedSnapshot: AdoptedSnapshot | null; coldStartPromptForSDK: string }
  | { isError: true; result: HandlerResult } {
  if (args.adoptTeammates !== true) {
    return { adoptedSnapshot: null, coldStartPromptForSDK: baseColdStartPrompt };
  }

  // **follow-up INFO-6 修法**:adopt 路径 prompt 装配 + phase 1.5 lifecycle precheck 共享
  // 同款 deps-aware fallback 提到外层 scope declare 一次;test seam 与生产路径都走
  // `handlerDeps?.getSessionForLifecycle ?? sessionRepo.get` 同 closure。
  const getSessionFn =
    handlerDeps?.getSessionForLifecycle ?? ((sid: string) => sessionRepo.get(sid));

  // N5 fail-fast:precheck caller 至少 1 个 lead membership;不读 lead memberships 时直接
  // findActiveMembershipsBySession 失败(external sentinel 时 caller 不在 sessions 表,
  // findActiveMembershipsBySession 返空 → length === 0 → return err — 同 N5 语义)。
  const allCallerMemberships = agentDeckTeamRepo.findActiveMembershipsBySession(callerSessionId);
  const callerLeadMemberships: typeof allCallerMemberships = [];
  // **follow-up INFO-7 修法**:team row missing(`agentDeckTeamRepo.get` 返 null —
  // FK 约束 ON DELETE 应拦不该出现,defense in depth)与 archived(`archivedAt !== null`)
  // 分两 reason 'team-not-found' / 'team-archived';修前合并进 archivedTeamIds 全 push
  // reason='team-archived' 误导(实际 row 不存在 ≠ archived)。两态分流让 caller 看到精
  // 确原因,future debug DB 不一致更易定位。
  const notFoundTeamIds: string[] = [];
  const archivedTeamIds: string[] = [];
  const teammateOnlyTeamIds: string[] = [];
  for (const m of allCallerMemberships) {
    const team = agentDeckTeamRepo.get(m.teamId);
    if (team === null) {
      notFoundTeamIds.push(m.teamId);
    } else if (team.archivedAt !== null) {
      archivedTeamIds.push(m.teamId);
    } else if (m.role === 'lead') {
      callerLeadMemberships.push(m);
    } else {
      teammateOnlyTeamIds.push(m.teamId);
    }
  }
  if (callerLeadMemberships.length === 0) {
    return {
      isError: true,
      result: err(
        'adoptTeammates 要求 caller 至少在一个 active team 是 lead',
        `callerSessionId ${callerSessionId} 当前在 ${allCallerMemberships.length} 个 active membership 内(含 archived team ghost ${archivedTeamIds.length} 条 + team row missing ghost ${notFoundTeamIds.length} 条),但 active team(team.archived_at IS NULL)中 role==='lead' 的 0 个(全 teammate / 全 archived team / team row missing / 无 lead membership)。adopt 语义本质是「lead 把 lead role 转给新 session」,caller 不是任何 active team 的 lead 时该语义无意义。改走 default baton(adoptTeammates: false / 不传)或先确认 caller 在某个 active team 是 lead 再重试。`,
      ),
    };
  }

  const eligibleTeammateSidsForPrompt = (teamId: string): string[] =>
    agentDeckTeamRepo
      .listAllMembers(teamId)
      .filter((m) => m.leftAt === null && m.sessionId !== callerSessionId)
      .filter((m) => {
        const s = getSessionFn(m.sessionId);
        return s !== null && s.lifecycle !== 'closed' && s.archivedAt === null;
      })
      .map((m) => m.sessionId);

  // 装配 adopt 路径 cold-start prompt(详 buildAdoptedTeamsContextBlock 顶部 jsdoc)。
  const firstTeamMembership = callerLeadMemberships[0]!;
  const firstTeam: AdoptedTeam = {
    id: firstTeamMembership.teamId,
    name: agentDeckTeamRepo.get(firstTeamMembership.teamId)?.name ?? '(unknown-team-name)',
    teammateSids: eligibleTeammateSidsForPrompt(firstTeamMembership.teamId),
  };
  const otherLeadTeams: AdoptedTeam[] = callerLeadMemberships.slice(1).map((m) => ({
    id: m.teamId,
    name: agentDeckTeamRepo.get(m.teamId)?.name ?? '(unknown-team-name)',
    teammateSids: eligibleTeammateSidsForPrompt(m.teamId),
  }));

  const adoptedBlock = buildAdoptedTeamsContextBlock({ firstTeam, otherLeadTeams });
  const coldStartPromptForSDK = `${adoptedBlock}\n---\n\n${baseColdStartPrompt}`;
  const adoptedSnapshot: AdoptedSnapshot = {
    firstTeamId: firstTeamMembership.teamId,
    teamsTotal: callerLeadMemberships.length + teammateOnlyTeamIds.length,
    callerLeadTeamIds: callerLeadMemberships.map((m) => m.teamId),
    teammateOnlyTeamIds,
    archivedTeamIds,
    notFoundTeamIds,
  };
  return { adoptedSnapshot, coldStartPromptForSDK };
}

/**
 * plan hand-off-session-adopt-teammates-20260520 Phase 6 (D4 + D5 + D6 + N8) — phase 1.5
 * adopt 流程:在 spawn 成功后、runBatonCleanup 之前跑 swapLead loop + listAllMembers +
 * lifecycle precheck + emit + collect preserved/failed。设计要点:
 *
 * **firstTeam fatal abort 路径**(Round 5 codex MED-3):firstTeam swapLead 失败(swapped:false /
 * throws)→ fatal abort:
 * - 调 closeFn(newSpawnedSid) shutdown 新 session(避免交出 stale firstTeam anchor 的孤儿
 *   新 session)
 * - **不 archive caller**(caller 状态零变化 — phase 1.5 入口 caller 仍是 lead,swapLead
 *   transaction 内 precheck 短路 demote 未执行)
 * - hand_off_session **return error**「adopt firstTeam swap failed: <reason>」+ hint 含
 *   failed firstTeamId + reason
 *
 * **firstTeam 成功后非 firstTeam swapLead 软失败接受 partial adopt**(D5):非 firstTeam
 * swapLead failed → push failed + continue 下一 team(其他 team 仍可成功)。
 *
 * **lifecycle precheck**(D6):每 teammate 显式 lifecycle precheck → session === null /
 * lifecycle === 'closed' 进 failed;'active' / 'dormant' 进 preservedSet(去重)。
 *
 * **N8 emit**:swapLead 成功后 eventBus.emit × 2 + sessionManager.notifyTeamMembershipChanged ×
 * 2(caller 'left' + newSid 'joined')。
 *
 * 返回 `{ isError: true, result }` 表示 firstTeam fatal abort（caller 短路 return）;
 * 否则返 `{ phase15Detail }` 给 caller 装配 ok return.adopted。
 */
export async function runPhase15AdoptSwapLeadLoop(
  callerSessionId: string,
  adoptedSnapshot: AdoptedSnapshot,
  newSpawnedSid: string,
  handlerDeps: HandOffSessionHandlerDeps | undefined,
): Promise<
  | { phase15Detail: Phase15Detail }
  | { isError: true; result: HandlerResult }
> {
  const swapLeadFn =
    handlerDeps?.swapLead ??
    ((teamId: string, oldSid: string, newSid: string, opts?: { newDisplayName?: string | null }) =>
      agentDeckTeamRepo.swapLead(teamId, oldSid, newSid, opts));
  // **follow-up INFO-6 修法**:复用与 prompt 装配同款 closure。
  const getSessionFn =
    handlerDeps?.getSessionForLifecycle ?? ((sid: string) => sessionRepo.get(sid));
  const listMembersFn =
    handlerDeps?.listAllMembersForAdopt ??
    ((teamId: string) => agentDeckTeamRepo.listAllMembers(teamId));
  const closeSessionFn =
    handlerDeps?.closeSession ?? ((sid: string) => sessionManager.close(sid));

  const preservedSet = new Set<string>();
  const failedList: Array<{ sid: string; reason: string; teamId: string }> = [];
  let teamsAdoptedCount = 0;
  // v024 plan §Step D2 + Round 4 HIGH-1 + Round 5 LOW-2 修法:与 preservedSet 对称
  // 收集 swapLead 成功的 caller-as-lead team uuids。preserve-team safety 算法用此与
  // newSidActiveTeamIds 比对差集 → policyWarning + unadoptedTeamIds 字段（plan §不变量 5）。
  // **集中责任 — processSwappedTeam helper 内 push**（Round 4 实施 hint）:firstTeam path
  // / rest loop 都调 helper,helper 内 push 让缺一处 implementer 改不漏。
  const adoptedTeamIdsList: string[] = [];

  // Phase 6 D5 step 2 (plan §N5 line 119): caller 是 teammate 的 team push failed
  // (snapshot 时已分流,不进 swapLead loop 但透传到 ok return.adopted.failed 让 caller
  // 看到为什么 some team 没 adopt)。
  for (const teammateTeamId of adoptedSnapshot.teammateOnlyTeamIds) {
    failedList.push({
      sid: callerSessionId,
      teamId: teammateTeamId,
      reason: 'caller-not-lead-in-team',
    });
  }
  // Phase 7 reviewer-codex Round 2 LOW + Round 3 polish 修法:archived team
  // (caller 不论 lead / teammate role)push failed reason='team-archived' —
  // 与 teammateOnlyTeamIds push failed 同款语义透传(snapshot 时已分流,不进
  // swapLead loop 但让 caller 通过 ok return 看到为什么 some team 没 adopt;
  // teamsTotal/teamsAdopted/failed 数学上对齐)。
  for (const archivedTeamId of adoptedSnapshot.archivedTeamIds) {
    failedList.push({
      sid: callerSessionId,
      teamId: archivedTeamId,
      reason: 'team-archived',
    });
  }
  // Follow-up INFO-7 修法:team row missing 与 archived 区分,push reason='team-not-found'
  // (defense in depth — FK 约束 ON DELETE 应拦实际 row missing,但 DB 不一致罕见 corner
  // case 时 caller 通过 ok return 看到精确原因)。
  for (const notFoundTeamId of adoptedSnapshot.notFoundTeamIds) {
    failedList.push({
      sid: callerSessionId,
      teamId: notFoundTeamId,
      reason: 'team-not-found',
    });
  }

  // helper:每个成功 swap 的 team 跑 — listAllMembers + lifecycle precheck + emit
  const processSwappedTeam = (teamId: string): void => {
    // v024 plan §Step D2 + Round 4 HIGH-1 实施 hint:集中 push adoptedTeamIdsList,
    // helper 内 push 让缺一处 implementer 改不漏（firstTeam path / rest loop 都调本
    // helper,push 集中后双 push 漂移风险消除）。在 helper 顶部 push 让后续 listAllMembers /
    // emit failures 不影响 adopt count 语义（swapLead 已成功,emit 是 side-effect notification）。
    adoptedTeamIdsList.push(teamId);
    // listAllMembers 拿 teammate(过滤 caller 已 demote + newSpawnedSid 自己 + leftAt 软退出)
    const teammates = listMembersFn(teamId).filter(
      (m) =>
        m.leftAt === null &&
        m.sessionId !== callerSessionId &&
        m.sessionId !== newSpawnedSid,
    );
    for (const tm of teammates) {
      const tmSession = getSessionFn(tm.sessionId);
      if (tmSession === null) {
        failedList.push({ sid: tm.sessionId, reason: 'session-missing', teamId });
        continue;
      }
      if (tmSession.lifecycle === 'closed') {
        failedList.push({ sid: tm.sessionId, reason: 'lifecycle-closed', teamId });
        continue;
      }
      // Phase 7 reviewer-codex MED 修法:archived teammate 也不算可 preserved
      // (与 send_message 的 findSharedActiveTeams 强制 sa.archived_at IS NULL +
      // sb.archived_at IS NULL 边界一致;archived teammate 列入 preserved 后新
      // session 调 send_message 必撞 no-shared-team)。reason='session-archived'
      // 与 'lifecycle-closed' 平行 — 都让 caller 通过 ok return.adopted.failed
      // 看到为啥 some teammate 没 preserve。
      if (tmSession.archivedAt !== null) {
        failedList.push({ sid: tm.sessionId, reason: 'session-archived', teamId });
        continue;
      }
      // 'active' / 'dormant' → preservedSet(Round 3 LOW Set 去重)
      preservedSet.add(tm.sessionId);
    }
    // N8 emit:caller 'left' + newSid 'joined' + notifyTeamMembershipChanged × 2
    // R2 reviewer-claude MED 修法:emit / notify 任一抛错(eventBus listener throw /
    // sessionRepo.get 撞 disposed connection / SQLite locked)若直 propagate 出
    // processSwappedTeam → 跳过 caller 处 slice(1) 循环 → 后续 team 永远不 swap
    // (DB transaction 已完成,但应用层 emit 漏)。每条 emit / notify 各自包 try/catch +
    // console.warn 兜底,不让 side-effect 异常打断 swap 主流程。
    const safeEmit = (label: string, fn: () => void) => {
      try {
        fn();
      } catch (e) {
        console.warn(
          `[mcp hand_off_session] processSwappedTeam(${teamId}) ${label} 失败 (continuing):`,
          e,
        );
      }
    };
    safeEmit('emit-left', () =>
      eventBus.emit('agent-deck-team-member-changed', {
        teamId,
        sessionId: callerSessionId,
        kind: 'left',
      }),
    );
    safeEmit('emit-joined', () =>
      eventBus.emit('agent-deck-team-member-changed', {
        teamId,
        sessionId: newSpawnedSid,
        kind: 'joined',
      }),
    );
    safeEmit('notify-caller', () =>
      sessionManager.notifyTeamMembershipChanged(callerSessionId),
    );
    safeEmit('notify-newSid', () =>
      sessionManager.notifyTeamMembershipChanged(newSpawnedSid),
    );
  };

  // firstTeam swapLead — 失败 fatal abort
  const firstTeamId = adoptedSnapshot.callerLeadTeamIds[0]!;
  let firstSwapResult: { swapped: true } | { swapped: false; reason: string };
  try {
    firstSwapResult = swapLeadFn(firstTeamId, callerSessionId, newSpawnedSid);
  } catch (e) {
    // try/catch 围 swapLead 调用(Round 6 claude LOW-1 修法 — throws 路径同款 fatal abort)
    firstSwapResult = {
      swapped: false,
      reason: `swap-lead-error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (firstSwapResult.swapped !== true) {
    // **fatal abort**:close newSpawnedSid + 不 archive caller + return error
    try {
      await closeSessionFn(newSpawnedSid);
    } catch (closeErr) {
      // close 失败 warn 不阻塞 — 仍 return error 让 caller 知道 fatal abort
      console.warn(
        `[mcp hand_off_session] adopt firstTeam fatal abort: close newSid ${newSpawnedSid} failed (continuing return err):`,
        closeErr,
      );
    }
    return {
      isError: true,
      result: err(
        `adopt firstTeam swap failed: ${firstSwapResult.reason}`,
        `firstTeamId=${firstTeamId},swapLead 软失败 reason=${firstSwapResult.reason}。caller 状态零变化(swapLead transaction 内 Phase A.0 precheck 短路 demote 未执行 / throws 自动 ROLLBACK),新 session ${newSpawnedSid} 已 close 避免交出 stale firstTeam anchor 的孤儿。caller 防御路径:① 修复 firstTeam(用户重新 spawn 同 team teammate / 修复 DB / 排查 swapLead 撞 invariant)+ 重试 hand_off_session ② 改走 default baton(adoptTeammates: false / 不传)放弃 adopt 走 normal hand-off。`,
      ),
    };
  }
  teamsAdoptedCount++;
  processSwappedTeam(firstTeamId);

  // firstTeam 成功后跑非 firstTeam(slice(1))— 软失败 push failed + continue
  for (const teamId of adoptedSnapshot.callerLeadTeamIds.slice(1)) {
    let swapResult: { swapped: true } | { swapped: false; reason: string };
    try {
      swapResult = swapLeadFn(teamId, callerSessionId, newSpawnedSid);
    } catch (e) {
      // catch + push failed 同款 throws 路径(非 firstTeam 不 fatal abort)
      failedList.push({
        sid: callerSessionId,
        teamId,
        reason: `swap-lead-error: ${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }
    if (swapResult.swapped !== true) {
      failedList.push({
        sid: callerSessionId,
        teamId,
        reason: `swap-lead-failed: ${swapResult.reason}`,
      });
      continue;
    }
    teamsAdoptedCount++;
    processSwappedTeam(teamId);
  }

  return {
    phase15Detail: {
      preserved: Array.from(preservedSet),
      failed: failedList,
      teamsAdopted: teamsAdoptedCount,
      adoptedTeamIds: adoptedTeamIdsList,
    },
  };
}
