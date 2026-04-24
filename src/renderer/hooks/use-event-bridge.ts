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
    // 启动顺序：先挂订阅再拉快照。
    // REVIEW_2 修：原本先 await listSessions().then(setSessions(...)) 再注册 listener，
    // await 期间收到的 session-upserted 会被 setSessions 全量覆盖抹掉。
    // 现在先订阅，listSessions 返回后用 upsert 逐条 merge 而不是 setSessions 替换，
    // 这样期间到达的 upsert 不会被覆盖；同 id 重复 upsert 是幂等的。
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

    // 初始快照：先全量 setSessions（能 prune 掉 store 里已经被服务端删掉的孤儿），
    // 再拉 latest summary。setSessions 已实现「按 id 集合 prune by-session 缓存」+
    // 「保留同 id 的内容覆盖」语义，对 listener 已 upsert 的新会话不会丢——
    // 服务端这边 listSessions 永远包含已存在的所有会话，新会话也会在快照里。
    void (async () => {
      const list = await window.api.listSessions();
      setSessions(list);
      const ids = list.map((s) => s.id);
      if (ids.length > 0) {
        const map = await window.api.latestSummaries(ids);
        setLatestSummaries(map);
      }
    })();

    return () => {
      offUp();
      offRm();
      offRen();
      offEv();
      offSum();
    };
  }, [upsert, remove, pushEvent, pushSummary, setSessions, setLatestSummaries, renameSession]);
}
