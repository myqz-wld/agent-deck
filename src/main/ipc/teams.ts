/**
 * Agent Teams (M2/M3) IPC：TeamList / TeamGet / TeamSubscribe(Inbox) /
 * TeamUnsubscribe(Inbox) / TeamForceCleanup / TeamRespondPermission /
 * TeamListPendingPermissions + Summarizer 诊断。
 *
 * 重点护栏（保持不变 / CHANGELOG_45-47 / REVIEW_17）：
 * - TeamForceCleanup：M3 C 方案盲区修复，主动 unset team_name（不依赖 chokidar 兜底）
 *   + 走 teamCoordinator.unsetTeamFromAllSessions 收口（30s dedup）
 * - TeamRespondPermission：写完 inbox + markResponded + emit team-permission-resolved
 * - TeamListPendingPermissions：走 inbox-watcher.listPendingRequestIds（REVIEW_17 R1 / H2）
 */
import { IpcInvoke } from '@shared/ipc-channels';
import { sessionRepo } from '@main/store/session-repo';
import { eventRepo } from '@main/store/event-repo';
import { eventBus } from '@main/event-bus';
import { summarizer } from '@main/session/summarizer';
import { forceCleanupTeam, getTeamSnapshot, listTeams } from '@main/teams/team-fs';
import { teamCoordinator } from '@main/teams/team-coordinator';
import { teamWatcher } from '@main/teams/team-watcher';
import { inboxWatcher } from '@main/teams/inbox-watcher';
import { appendInboxMessage, buildPermissionResponse } from '@main/teams/inbox-protocol';
import type { SessionRecord, TeamSnapshot, TeamSummary } from '@shared/types';
import { on, IpcInputError, parseTeamName } from './_helpers';

export function registerTeamsIpc(): void {
  // Summarizer 诊断：拉取最近一次失败原因（by sessionId）。CHANGELOG_20 / G。
  on(IpcInvoke.SummarizerLastErrors, () => summarizer.getLastErrors());

  // ─────────── Agent Teams (M2) ───────────
  // TeamList：合 SQL distinctTeamNames + fs ~/.claude/teams/，返回简表。TeamHub 列表用。
  on(IpcInvoke.TeamList, async (): Promise<TeamSummary[]> => {
    const distinct = sessionRepo.distinctTeamNames();
    const sessionsByName = new Map<string, SessionRecord[]>();
    for (const name of distinct) {
      sessionsByName.set(name, sessionRepo.findByTeamName(name));
    }
    return listTeams(distinct, sessionsByName);
  });
  // TeamGet：拉一个 team 的完整 snapshot（sessions + config.json + task list + 最近 team-* events）。TeamDetail 用。
  on(IpcInvoke.TeamGet, async (_e, name): Promise<TeamSnapshot | null> => {
    const teamName = parseTeamName(name);
    if (!teamName) {
      throw new IpcInputError('name', 'team name required');
    }
    const sessions = sessionRepo.findByTeamName(teamName);
    const events = eventRepo.findTeamEvents(teamName, 100);
    return getTeamSnapshot(teamName, sessions, events);
  });
  // TeamSubscribe：renderer 进入某 team 的 fs 视图时调（chokidar 引用计数 +1）。
  on(IpcInvoke.TeamSubscribe, async (_e, name): Promise<{ ok: true }> => {
    const teamName = parseTeamName(name);
    if (!teamName) {
      throw new IpcInputError('name', 'team name required');
    }
    teamWatcher.subscribe(teamName);
    return { ok: true };
  });
  // TeamUnsubscribe：renderer 离开某 team 时调（引用计数 -1，60s grace 后真 close）。
  on(IpcInvoke.TeamUnsubscribe, async (_e, name): Promise<{ ok: true }> => {
    const teamName = parseTeamName(name);
    if (!teamName) {
      throw new IpcInputError('name', 'team name required');
    }
    teamWatcher.unsubscribe(teamName);
    return { ok: true };
  });
  // TeamForceCleanup：手动清理 ~/.claude/teams/<name>/ 与 ~/.claude/tasks/<name>/ 残留。
  // 兜底 Claude in-process cleanup 上游 bug。返回实际删掉的目录列表（让 UI confirm）。
  //
  // M3 C 方案盲区修复：除了 rm -rf fs 外，**主动**调 sessionRepo.clearTeamName 把
  // 该 team 名下所有 sessions 的 team_name 设 NULL + emit upserts 让 renderer 同步。
  // 不依赖 chokidar unlinkDir 事件——因为「fs 早就被外部清干净，应用 DB 还残留 team_name」
  // 这种状态下 force-cleanup 调用时根本没东西可删，watcher 不会触发 unlinkDir，
  // C 方案纯靠 watcher 路径会漏掉。按钮语义本就是「让这个 team 彻底消失」，所以主动 unset。
  on(IpcInvoke.TeamForceCleanup, async (_e, name): Promise<{ removed: string[]; unsetSessions: number }> => {
    const teamName = parseTeamName(name);
    if (!teamName) {
      throw new IpcInputError('name', 'team name required');
    }
    const fsResult = await forceCleanupTeam(teamName);
    // 总是 unset team_name（即便 fs 没东西可删）—— 让 TeamHub 彻底移除该 team。
    // REVIEW_17 R1 / M6：走 teamCoordinator.unsetTeamFromAllSessions 收口（30s dedup
    // 让随后 chokidar unlinkDir 兜底 unset 直接 no-op，避免 N+1 SQL 浪费）。
    const affected = teamCoordinator.unsetTeamFromAllSessions(teamName);
    return { ...fsResult, unsetSessions: affected.length };
  });
  // ───────── Agent Teams in-process backend permission inbox（CHANGELOG_45） ─────────
  // TeamSubscribeInbox：renderer 进入某 team 视图时调（chokidar 引用计数 +1）。
  // 应用层在 main bootstrap 也按 active session 自动订阅，UI 订阅是补强 + 让 grace 期内
  // 切回的视图能立刻见到旧 watcher 重用。
  on(IpcInvoke.TeamSubscribeInbox, async (_e, name): Promise<{ ok: true }> => {
    const teamName = parseTeamName(name);
    if (!teamName) {
      throw new IpcInputError('name', 'team name required');
    }
    inboxWatcher.subscribe(teamName);
    return { ok: true };
  });
  on(IpcInvoke.TeamUnsubscribeInbox, async (_e, name): Promise<{ ok: true }> => {
    const teamName = parseTeamName(name);
    if (!teamName) {
      throw new IpcInputError('name', 'team name required');
    }
    inboxWatcher.unsubscribe(teamName);
    return { ok: true };
  });
  // TeamRespondPermission：写 permission_response 文本到 teammate inbox 文件（与 CLI 同
  // proper-lockfile 协议）。同时在 inbox-watcher 标记该 requestId 已响应，避免下次文件
  // change 又把这条重新弹给用户。
  on(
    IpcInvoke.TeamRespondPermission,
    async (
      _e,
      teamNameRaw,
      fromMemberSlugRaw,
      requestIdRaw,
      decisionRaw,
      updatedInputRaw,
    ): Promise<{ ok: true }> => {
      const teamName = parseTeamName(teamNameRaw);
      if (!teamName) {
        throw new IpcInputError('teamName', 'team name required');
      }
      // member slug 用同款字符集校验（已经被 slugify 过，应当满足 [A-Za-z0-9_-]）
      const fromMemberSlug = typeof fromMemberSlugRaw === 'string' ? fromMemberSlugRaw : '';
      if (!fromMemberSlug || !/^[A-Za-z0-9._-]{1,128}$/.test(fromMemberSlug)) {
        throw new IpcInputError('fromMemberSlug', 'invalid member slug');
      }
      const requestId = typeof requestIdRaw === 'string' ? requestIdRaw : '';
      if (!requestId || requestId.length > 256) {
        throw new IpcInputError('requestId', 'invalid request id');
      }
      const decision = decisionRaw === 'allow' || decisionRaw === 'deny' ? decisionRaw : null;
      if (!decision) {
        throw new IpcInputError('decision', 'decision must be "allow" or "deny"');
      }
      const updatedInput =
        updatedInputRaw && typeof updatedInputRaw === 'object' && !Array.isArray(updatedInputRaw)
          ? (updatedInputRaw as Record<string, unknown>)
          : undefined;
      const sub = buildPermissionResponse(requestId, decision, { updatedInput });
      await appendInboxMessage(teamName, fromMemberSlug, sub, { fromAgentId: 'team-lead' });
      // 标记已响应：避免 inbox 文件下次 change（如 lead 端读消息修改 read 标记）又重新 emit
      inboxWatcher.markResponded(teamName, requestId);
      // 通知所有 renderer 把 pending 列表里这条删掉
      eventBus.emit('team-permission-resolved', { teamName, requestId });
      return { ok: true };
    },
  );
  // TeamListPendingPermissions：返回当前真正 pending 的 permission_request id 列表
  // （走 inbox-watcher.activePermissions.keys()，对应 processInboxFile set 后、
  // markResponded / idle_notification cancel delete 之间的 in-memory 状态）。
  // REVIEW_17 R1 / H2 修复：原来错走 listSeenRequestIds 返回的是「已见过 / 已响应」
  // 的去重集合（含 `idle:<from>:<timestamp>` 脏键），与 IPC 通道名 `TeamListPendingPermissions`
  // 承诺的「pending」语义完全反。preload 当前没暴露 facade，是预埋陷阱，未来 wire
  // 上时直接走对的语义。
  on(IpcInvoke.TeamListPendingPermissions, async (_e, name): Promise<{ requestIds: string[] }> => {
    const teamName = parseTeamName(name);
    if (!teamName) {
      throw new IpcInputError('name', 'team name required');
    }
    return { requestIds: inboxWatcher.listPendingRequestIds(teamName) };
  });
}
