import { useCallback, useEffect, useRef, useState } from 'react';
import { isTerminalNativeWork, nativeWorkAttemptKey, type NativeWorkSnapshot } from '@shared/native-work';
import { useNativeWorkPreferences } from './preferences';
import type { NativeWorkTransport } from './transport';
interface Pending { hide: boolean; timer: ReturnType<typeof setTimeout> }
export function useNativeWork(sessionId: string, scope: string, transport: NativeWorkTransport | null) {
  const [tasks, setTasks] = useState<NativeWorkSnapshot[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, { message: string; hide: boolean }>>({});
  const [pendingKeys, setPendingKeys] = useState<string[]>([]);
  const pending = useRef(new Map<string, Pending>());
  const [preferences, update] = useNativeWorkPreferences(scope);
  const alive = useRef(true);
  const poll = useRef<() => Promise<void>>(async () => {});
  const mutation = useRef(update); mutation.current = update;
  const dismiss = useCallback((key: string) => mutation.current(previous => ({ ...previous,
    hidden: [...new Set([...previous.hidden, key])], expanded: previous.expanded.filter(id => id !== key) })), []);
  useEffect(() => {
    alive.current = true;
    let cancelled = false, inFlight = false, queued = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setTasks([]); setError(null); setErrors({}); setPendingKeys([]);
    const sync = async () => {
      if (cancelled || !transport || !sessionId) return;
      if (inFlight) { queued = true; return; } inFlight = true;
      try {
        const result: NativeWorkSnapshot[] = [];
        let cursor: number | undefined;
        do {
          const page = await transport.list({ sessionId, ...(cursor ? { cursor } : {}) });
          if (cancelled) return;
          result.push(...page.tasks);
          if (page.nextCursor !== null && page.nextCursor <= (cursor ?? 0)) throw new Error('Invalid task cursor');
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        setTasks(result); setError(null);
        for (const task of result) {
          const key = nativeWorkAttemptKey(task.native), operation = pending.current.get(key);
          if (!operation || !isTerminalNativeWork(task.status)) continue;
          clearTimeout(operation.timer); pending.current.delete(key);
          if (operation.hide) dismiss(key);
          setPendingKeys([...pending.current.keys()]);
        }
      } catch { if (!cancelled) setError('读取执行记录失败，可稍后重试。'); }
      finally {
        inFlight = false;
        if (!cancelled && queued) { queued = false; timer = setTimeout(() => void sync(), 100); }
      }
    };
    poll.current = sync; void sync();
    const interval = setInterval(() => void sync(), 2000);
    const unsubscribe = transport?.subscribe?.(sessionId, () => { if (!timer) timer = setTimeout(() => { timer = undefined; void sync(); }, 120); });
    return () => { cancelled = true; alive.current = false; clearInterval(interval); if (timer) clearTimeout(timer); unsubscribe?.();
      for (const value of pending.current.values()) clearTimeout(value.timer); pending.current.clear(); };
  }, [sessionId, transport, scope, dismiss]);
  const stop = async (task: NativeWorkSnapshot, hide: boolean) => {
    const key = nativeWorkAttemptKey(task.native);
    if (isTerminalNativeWork(task.status)) { if (hide) dismiss(key); return; }
    if (!task.canStop || !transport) { setErrors(previous => ({ ...previous, [key]: { message: task.controlReason ?? '当前运行实例不支持单独停止', hide } })); return; }
    if (pending.current.has(key)) return;
    const fail = (message: string) => {
      const operation = pending.current.get(key); if (!operation) return;
      clearTimeout(operation.timer); pending.current.delete(key);
      if (alive.current) { setPendingKeys([...pending.current.keys()]); setErrors(previous => ({ ...previous, [key]: { message, hide } })); }
    };
    const operation: Pending = { hide, timer: setTimeout(() => fail('未收到停止确认，任务已恢复显示，可重试。'), 35000) };
    pending.current.set(key, operation); setPendingKeys([...pending.current.keys()]);
    setErrors(previous => { const next = { ...previous }; delete next[key]; return next; });
    try {
      const result = await transport.stop(task.native);
      if (!alive.current || pending.current.get(key) !== operation) return;
      if (result.status === 'already-terminal') {
        clearTimeout(operation.timer); pending.current.delete(key); if (hide) dismiss(key); setPendingKeys([...pending.current.keys()]);
      } else if (result.status !== 'accepted') fail(result.reason ?? '停止未成功，任务已恢复显示，可重试。');
      void poll.current();
    } catch { if (pending.current.get(key) === operation) fail('停止请求失败，任务已恢复显示，可重试。'); }
  };
  const visible = tasks.filter(task => { const key = nativeWorkAttemptKey(task.native);
    // Commands belong to their conversation tool rows; only child conversations need cards.
    if (task.workKind !== 'subagent') return false;
    return !task.hidden && !preferences.hidden.includes(key) && !pending.current.get(key)?.hide; });
  visible.sort((a, b) => {
    const position = (task: NativeWorkSnapshot) => { const index = preferences.order.indexOf(nativeWorkAttemptKey(task.native)); return index < 0 ? Number.MAX_SAFE_INTEGER : index; };
    return position(a) - position(b);
  });
  return { tasks, visible, preferences, updatePreferences: update, error, errors, pendingKeys, transport, scope, sessionId,
    refresh: () => poll.current(), stop, dismiss,
    show: (key: string) => update(previous => ({ ...previous, hidden: previous.hidden.filter(id => id !== key) })),
    reorder: (order: string[]) => update(previous => ({ ...previous, order })),
    expand: (key: string, open: boolean) => update(previous => ({ ...previous, expanded: open
      ? [...new Set([...previous.expanded, key])] : previous.expanded.filter(id => id !== key) })),
    collapse: () => update(previous => ({ ...previous, expanded: [] })),
  };
}
export type NativeWorkView = ReturnType<typeof useNativeWork>;
