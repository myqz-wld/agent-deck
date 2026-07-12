import { useEffect } from 'react';
import { useSessionStore } from '@renderer/stores/session-store';
import { loadStableSnapshot } from '@renderer/lib/load-stable-snapshot';
import log from '@renderer/utils/logger';

const logger = log.scope('renderer-event-bridge');

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
    let cancelled = false;
    // 启动顺序：先挂订阅再拉快照。
    // 快照请求期间的任何增删改都会推进 sessionRevision；晚到响应会被丢弃并重拉，
    // 因而既能安全全量替换/prune，也不会覆盖较新的实时记录。
    const offUp = window.api.onSessionUpserted((s) => {
      // 仅当是「之前没见过的会话」才懒拉一次 latest summary（让卡片即时显示「在干嘛」）。
      // 已存在的会话走 upsert 路径不再重拉 —— manager.ingest 现在仅在状态真变化时
      // 广播 session-upserted，但即便如此 latestSummary 只在 summarizer 跑完后才会变，
      // 高频会话场景下每次 upsert 都拉一次属于纯 IPC 浪费。新 summary 通过 onSummaryAdded
      // 事件直接推进 latestSummaryBySession，不依赖这条 fetch。
      const isNew = !useSessionStore.getState().sessions.has(s.id);
      upsert(s);
      if (isNew) {
        void window.api
          .latestSummaries([s.id])
          .then(setLatestSummaries)
          .catch((err: unknown) => {
            logger.warn('[event-bridge] latest summary read failed', { sessionId: s.id }, err);
          });
      }
    });
    const offRm = window.api.onSessionRemoved((id) => remove(id));
    const offRen = window.api.onSessionRenamed(({ from, to }) => renameSession(from, to));
    const offEv = window.api.onAgentEvent((e) => pushEvent(e));
    const offSum = window.api.onSummaryAdded((s) => pushSummary(s));

    // 初始快照稳定后再全量替换，清掉 HMR 留下的孤儿缓存；随后补最新摘要。
    void (async () => {
      let ids: string[] = [];
      const result = await loadStableSnapshot({
        readVersion: () => useSessionStore.getState().sessionRevision,
        load: () => window.api.listSessions(),
        apply: (list) => {
          setSessions(list);
          ids = list.map((s) => s.id);
        },
        isCancelled: () => cancelled,
      });
      if (result === 'unstable') {
        logger.warn('[event-bridge] session snapshot stayed unstable; kept live state');
        return;
      }
      if (result !== 'applied' || cancelled) return;
      if (ids.length > 0) {
        const map = await window.api.latestSummaries(ids);
        if (!cancelled) setLatestSummaries(map);
      }
    })().catch((err: unknown) => {
      if (!cancelled) logger.warn('[event-bridge] initial session snapshot failed', err);
    });

    return () => {
      cancelled = true;
      offUp();
      offRm();
      offRen();
      offEv();
      offSum();
    };
  }, [upsert, remove, pushEvent, pushSummary, setSessions, setLatestSummaries, renameSession]);
}
