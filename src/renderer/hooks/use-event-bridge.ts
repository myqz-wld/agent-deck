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
      // 仅当是「之前没见过的会话」才懒拉一次 latest summary（让卡片即时显示「在干嘛」）。
      // 已存在的会话走 upsert 路径不再重拉 —— manager.ingest 现在仅在状态真变化时
      // 广播 session-upserted，但即便如此 latestSummary 只在 summarizer 跑完后才会变，
      // 高频会话场景下每次 upsert 都拉一次属于纯 IPC 浪费。新 summary 通过 onSummaryAdded
      // 事件直接推进 latestSummaryBySession，不依赖这条 fetch。
      const isNew = !useSessionStore.getState().sessions.has(s.id);
      upsert(s);
      if (isNew) {
        void window.api.latestSummaries([s.id]).then(setLatestSummaries);
      }
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
