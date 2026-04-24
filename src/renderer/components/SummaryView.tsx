import { useEffect, useState, type JSX } from 'react';
import type { SummaryRecord } from '@shared/types';
import { useSessionStore } from '@renderer/stores/session-store';

interface Props {
  sessionId: string;
}

const EMPTY_SUMMARIES: SummaryRecord[] = [];

export function SummaryView({ sessionId }: Props): JSX.Element {
  const local = useSessionStore((s) => s.summariesBySession.get(sessionId) ?? EMPTY_SUMMARIES);
  const setLocal = useSessionStore((s) => s.setSummaries);
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setLoaded(false);
    let aborted = false;
    void window.api.listSummaries(sessionId).then((rows) => {
      if (aborted) return;
      setLocal(sessionId, rows as SummaryRecord[]);
      setLoaded(true);
    });
    return () => {
      aborted = true;
    };
  }, [sessionId, setLocal]);

  if (!loaded && local.length === 0) {
    return <div className="px-2 py-3 text-[11px] text-deck-muted">加载中…</div>;
  }
  if (local.length === 0) {
    return (
      <div className="px-2 py-3 text-[11px] text-deck-muted">
        暂无总结。Summarizer 会按时间或事件数自动触发。
      </div>
    );
  }

  const latest = local[0];
  const rest = local.slice(1);

  return (
    <div className="flex flex-col gap-2">
      <div className="rounded-md border border-deck-border bg-white/[0.04] px-2.5 py-2">
        <div className="text-[10px] uppercase tracking-wider text-deck-muted/70">
          最新 · {formatTrigger(latest.trigger)} · {new Date(latest.ts).toLocaleString('zh-CN', { hour12: false })}
        </div>
        <div className="mt-1 text-[11px] leading-relaxed">{latest.content}</div>
      </div>
      {rest.length > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="self-start text-[10px] text-deck-muted hover:text-deck-text"
        >
          {expanded ? '收起历史' : `展开 ${rest.length} 条历史`}
        </button>
      )}
      {expanded && rest.length > 0 && (
        <ol className="flex flex-col gap-1.5">
          {rest.map((s) => (
            <li key={s.id} className="rounded-md border border-deck-border/50 px-2.5 py-1.5">
              <div className="text-[9px] text-deck-muted/70">
                {formatTrigger(s.trigger)} · {new Date(s.ts).toLocaleString('zh-CN', { hour12: false })}
              </div>
              <div className="mt-0.5 text-[11px] leading-relaxed text-deck-muted">{s.content}</div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function formatTrigger(t: SummaryRecord['trigger']): string {
  return t === 'time' ? '⏱ 周期' : t === 'event-count' ? '📊 事件' : '✋ 手动';
}
