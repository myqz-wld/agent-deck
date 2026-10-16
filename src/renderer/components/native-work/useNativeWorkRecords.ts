import { useEffect, useMemo, useState } from 'react';
import { nativeWorkAttemptKey, type NativeWorkDetail, type NativeWorkSnapshot } from '@shared/native-work';
import type { NativeWorkTransport } from './transport';

export function useNativeWorkRecords(task: NativeWorkSnapshot, transport: NativeWorkTransport) {
  const key = nativeWorkAttemptKey(task.native);
  const [records, setRecords] = useState<Array<NativeWorkDetail & { id: number }>>([]);
  const [pages, setPages] = useState(1), [hasMore, setHasMore] = useState(false);
  const [loaded, setLoaded] = useState(false), [error, setError] = useState(false), [retry, setRetry] = useState(0);
  useEffect(() => { setRecords([]); setPages(1); setLoaded(false); }, [key]);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const collected: Array<NativeWorkDetail & { id: number }> = [];
        let cursor: number | undefined;
        for (let index = 0; index < pages; index++) {
          const page = await transport.details({ ref: task.native, order: task.workKind === 'subagent' ? 'desc' : 'asc', ...(cursor ? { cursor } : {}) });
          if (cancelled) return;
          collected.push(...page.records);
          cursor = page.nextCursor ?? undefined;
          if (!cursor) break;
        }
        if (!cancelled) { setRecords(collected); setHasMore(cursor !== undefined); setLoaded(true); setError(false); }
      } catch { if (!cancelled) { setError(true); setLoaded(true); } }
    };
    void load(); return () => { cancelled = true; };
  }, [key, task.revision, task.updatedAt, task.native.runtimeId, task.workKind, transport, pages, retry]);
  const grouped = useMemo(() => {
    const groups = new Map<string, NativeWorkDetail[]>();
    const ordered = [...records].sort((a, b) => task.workKind === 'subagent' ? b.id - a.id : a.id - b.id);
    for (const record of ordered) {
      const previous = groups.get(record.recordId) ?? [];
      if (previous[0] && previous[0].recordRevision > record.recordRevision) continue;
      groups.set(record.recordId, [...(previous[0]?.recordRevision === record.recordRevision ? previous : []), record]);
    }
    return [...groups.values()].map(parts => {
      parts.sort((a, b) => a.part - b.part);
      return { ...parts[0], text: parts.map(part => part.text).join(''), incomplete: parts.length !== parts[0].parts };
    });
  }, [records, task.workKind]);
  return { grouped, loaded, error, hasMore, retry: () => setRetry(value => value + 1), loadMore: () => setPages(value => value + 1) };
}
