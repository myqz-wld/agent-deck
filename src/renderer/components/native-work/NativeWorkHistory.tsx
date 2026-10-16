import { useEffect, useState } from 'react';
import { nativeWorkAttemptKey, type NativeWorkSnapshot } from '@shared/native-work';
import { NativeWorkDetails } from './NativeWorkDetails';
import { CardSummary } from './NativeWorkCard';
import { useRememberedDisclosure } from './preferences';
import type { NativeWorkView } from './useNativeWork';
export function NativeWorkHistory({ view }: { view: NativeWorkView }) {
  const [tasks, setTasks] = useState<NativeWorkSnapshot[]>([]), [error, setError] = useState(false);
  const [cursor, setCursor] = useState<number | null>(null), [pages, setPages] = useState(1);
  useEffect(() => {
    let cancelled = false;
    const read = async () => {
      if (!view.transport) return;
      try {
        const tasks: NativeWorkSnapshot[] = []; let cursor: number | undefined;
        for (let index = 0; index < pages; index++) {
          const page = await view.transport.list({ sessionId: view.sessionId, history: true, ...(cursor ? { cursor } : {}) });
          tasks.push(...page.tasks); cursor = page.nextCursor ?? undefined; if (!cursor) break;
        }
        if (!cancelled) { setTasks(tasks); setCursor(cursor ?? null); setError(false); }
      } catch { if (!cancelled) setError(true); }
    };
    void read(); return () => { cancelled = true; };
  }, [view.transport, view.sessionId, view.tasks, pages]);
  return <section className="mb-4 min-w-0" aria-label="执行记录">
    <h3 className="mb-2 text-[11px] text-deck-muted">执行记录</h3>
    {(error || view.error) && <p className="text-[10px] text-status-error">执行记录读取失败，可稍后重试。</p>}
    {!tasks.length && !error && <p className="text-[10px] text-deck-muted">暂无子代理或后台任务记录。</p>}
    <div className="flex flex-col gap-2">{tasks.map(task => <HistoryRow key={nativeWorkAttemptKey(task.native)} task={task} view={view} />)}</div>
    {cursor !== null && <button className="rail-action" onClick={() => setPages(value => value + 1)}>加载更多</button>}
  </section>;
}
function HistoryRow({ task, view }: { task: NativeWorkSnapshot; view: NativeWorkView }) {
  const key = nativeWorkAttemptKey(task.native), [open, setOpen] = useRememberedDisclosure(`history:${key}`, false);
  return <div className="rounded border border-deck-border p-2">
    <button className="w-full text-left" aria-expanded={open} onClick={() => setOpen(value => !value)}><CardSummary task={task} expanded={open} /></button>
    {view.preferences.hidden.includes(key) && view.tasks.some(current => nativeWorkAttemptKey(current.native) === key) &&
      <button className="rail-action mt-1" onClick={() => view.show(key)}>重新显示在任务栏</button>}
    {open && view.transport && <div className="mt-2"><NativeWorkDetails task={task} transport={view.transport} /></div>}
  </div>;
}
