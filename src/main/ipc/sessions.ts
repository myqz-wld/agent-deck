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
  on(IpcInvoke.SessionGet, (_e, id) => sessionRepo.get(String(id)));
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
  on(IpcInvoke.SessionArchive, (_e, id) => {
    sessionManager.archive(parseStringId('sessionId', id));
    return true;
  });
  on(IpcInvoke.SessionUnarchive, (_e, id) => {
    sessionManager.unarchive(parseStringId('sessionId', id));
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
    return sessionRepo.listHistory(
      (filters ?? {}) as Parameters<typeof sessionRepo.listHistory>[0],
    );
  });
}
