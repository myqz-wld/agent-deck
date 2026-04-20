import { useEffect } from 'react';
import { useSessionStore } from '@renderer/stores/session-store';

/**
 * 桥接主进程事件 → Zustand store。整个应用只挂载一次。
 */
export function useEventBridge(): void {
  const upsert = useSessionStore((s) => s.upsertSession);
  const remove = useSessionStore((s) => s.removeSession);
  const pushEvent = useSessionStore((s) => s.pushEvent);
  const pushSummary = useSessionStore((s) => s.pushSummary);
  const setSessions = useSessionStore((s) => s.setSessions);
  const setLatestSummaries = useSessionStore((s) => s.setLatestSummaries);
  const renameSession = useSessionStore((s) => s.renameSession);

  useEffect(() => {
    // 初始拉取：先 sessions，再批量拿每个 session 的 latest summary
    void (async () => {
      const list = await window.api.listSessions();
      setSessions(list);
      const ids = list.map((s) => s.id);
      if (ids.length > 0) {
        const map = await window.api.latestSummaries(ids);
        setLatestSummaries(map);
      }
    })();

    const offUp = window.api.onSessionUpserted((s) => {
      upsert(s);
      // 新出现的会话懒拉一次 latest summary，让卡片即时显示「在干嘛」
      void window.api.latestSummaries([s.id]).then(setLatestSummaries);
    });
    const offRm = window.api.onSessionRemoved((id) => remove(id));
    const offRen = window.api.onSessionRenamed(({ from, to }) => renameSession(from, to));
    const offEv = window.api.onAgentEvent((e) => pushEvent(e));
    const offSum = window.api.onSummaryAdded((s) => pushSummary(s));

    return () => {
      offUp();
      offRm();
      offRen();
      offEv();
      offSum();
    };
  }, [upsert, remove, pushEvent, pushSummary, setSessions, setLatestSummaries, renameSession]);
}
