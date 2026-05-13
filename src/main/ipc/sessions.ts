/**
 * Session 列表 / 详情 / 归档 / 删除 / 历史 IPC handler。
 */
import { IpcInvoke } from '@shared/ipc-channels';
import { sessionManager } from '@main/session/manager';
import { sessionRepo } from '@main/store/session-repo';
import { eventRepo } from '@main/store/event-repo';
import { fileChangeRepo } from '@main/store/file-change-repo';
import { summaryRepo } from '@main/store/summary-repo';
import { on, parseStringId, parsePositiveInt, parseStringIdArray } from './_helpers';

export function registerSessionsIpc(): void {
  // Session
  on(IpcInvoke.SessionList, () => sessionManager.list());
  // plan team-cohesion-fix-20260513 Phase A：走 sessionManager.get 而非 sessionRepo.get，
  // 让 SessionRecord.teams[] enrich 透明生效。
  on(IpcInvoke.SessionGet, (_e, id) => sessionManager.get(String(id)));
  on(IpcInvoke.SessionListEvents, (_e, id, limit) => {
    const sid = parseStringId('sessionId', id);
    // limit 上限 5000：renderer 默认 100/200，留空间给 history 详情页拉更多
    const lim = parsePositiveInt('limit', limit, { fallback: 200, min: 1, max: 5000 });
    return eventRepo.listForSession(sid, lim);
  });
  on(IpcInvoke.SessionListFileChanges, (_e, id) =>
    fileChangeRepo.listForSession(parseStringId('sessionId', id)),
  );
  on(IpcInvoke.SessionListSummaries, (_e, id) =>
    summaryRepo.listForSession(parseStringId('sessionId', id)),
  );
  on(IpcInvoke.SessionLatestSummaries, (_e, ids) => {
    const arr = parseStringIdArray('ids', ids ?? []);
    return summaryRepo.latestForSessions(arr);
  });
  on(IpcInvoke.SessionArchive, async (_e, id) => {
    await sessionManager.archive(parseStringId('sessionId', id));
    return true;
  });
  on(IpcInvoke.SessionUnarchive, async (_e, id) => {
    await sessionManager.unarchive(parseStringId('sessionId', id));
    return true;
  });
  on(IpcInvoke.SessionReactivate, (_e, id) => {
    sessionManager.reactivate(parseStringId('sessionId', id));
    return true;
  });
  on(IpcInvoke.SessionDelete, async (_e, id) => {
    await sessionManager.delete(parseStringId('sessionId', id));
    return true;
  });

  // History
  on(IpcInvoke.SessionListHistory, (_e, filters) => {
    // plan team-cohesion-fix-20260513 Phase A：history 列表也 batch enrich teams[]，让历史 session
    // detail 也能正确显示 team chip。
    return sessionManager.enrichWithTeamsBatch(
      sessionRepo.listHistory(
        (filters ?? {}) as Parameters<typeof sessionRepo.listHistory>[0],
      ),
    );
  });
}
