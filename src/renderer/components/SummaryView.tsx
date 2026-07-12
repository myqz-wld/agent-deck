import { useEffect, useState, type JSX } from 'react';
import type { SummaryRecord } from '@shared/types';
import { useSessionStore } from '@renderer/stores/session-store';
import { loadStableSnapshot } from '@renderer/lib/load-stable-snapshot';
import { errorMessage } from '@renderer/lib/error-message';
import { ChevronDownIcon, ChevronUpIcon } from './icons';

interface Props {
  sessionId: string;
}

const EMPTY_SUMMARIES: SummaryRecord[] = [];

export function SummaryView({ sessionId }: Props): JSX.Element {
  const local = useSessionStore((s) => s.summariesBySession.get(sessionId) ?? EMPTY_SUMMARIES);
  const setLocal = useSessionStore((s) => s.setSummaries);
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    setLoaded(false);
    setLoadError(null);
    let aborted = false;
    void loadStableSnapshot({
      readVersion: () =>
        useSessionStore.getState().summaryRevisionsBySession.get(sessionId) ?? 0,
      load: () => window.api.listSummaries(sessionId),
      apply: (rows) => setLocal(sessionId, rows as SummaryRecord[]),
      isCancelled: () => aborted,
    })
      .then((result) => {
        if (aborted) return;
        if (result === 'unstable') setLoadError('总结更新频繁，请稍后重试。');
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (aborted) return;
        setLoadError(`总结读取失败：${errorMessage(err)}`);
        setLoaded(true);
      });
    return () => {
      aborted = true;
    };
  }, [sessionId, setLocal]);

  if (!loaded && local.length === 0) {
    return <div className="px-2 py-3 text-[11px] text-deck-muted">加载中…</div>;
  }
  if (loadError && local.length === 0) {
    return <div className="px-2 py-3 text-[11px] text-status-waiting/90">{loadError}</div>;
  }
  if (local.length === 0) {
    return (
      <div className="px-2 py-3 text-[11px] text-deck-muted">
        {/* 术语约定（CHANGELOG_57 B4，与设置面板对齐）：用「间歇总结」而非「Summarizer」。 */}
        暂无总结。间歇总结会按时间或事件数自动触发。
      </div>
    );
  }

  const latest = local[0];
  const rest = local.slice(1);

  return (
    <div className="flex flex-col gap-2">
      <div className="rounded-md border border-deck-border bg-white/[0.04] px-2.5 py-2">
        <div className="text-[10px] uppercase tracking-wider text-deck-muted/70">
          最新 · {formatTrigger(latest.trigger)} · {formatGenerationSource(latest.generationSource)} · {new Date(latest.ts).toLocaleString('zh-CN', { hour12: false })}
        </div>
        <div className="mt-1 whitespace-pre-line text-[11px] leading-relaxed">{latest.content}</div>
      </div>
      {rest.length > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="self-start text-[10px] text-deck-muted hover:text-deck-text"
        >
          {expanded ? <ChevronUpIcon className="mr-1 inline h-3 w-3" /> : <ChevronDownIcon className="mr-1 inline h-3 w-3" />}
          {expanded ? '收起历史' : `展开 ${rest.length} 条历史`}
        </button>
      )}
      {expanded && rest.length > 0 && (
        <ol className="flex flex-col gap-1.5">
          {rest.map((s) => (
            <li key={s.id} className="rounded-md border border-deck-border/50 px-2.5 py-1.5">
              <div className="text-[9px] text-deck-muted/70">
                {formatTrigger(s.trigger)} · {formatGenerationSource(s.generationSource)} · {new Date(s.ts).toLocaleString('zh-CN', { hour12: false })}
              </div>
              <div className="mt-0.5 whitespace-pre-line text-[11px] leading-relaxed text-deck-muted">{s.content}</div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function formatTrigger(t: SummaryRecord['trigger']): string {
  return t === 'time' ? '⏱ 定时' : t === 'event-count' ? '📊 事件触发' : '✋ 手动';
}

function formatGenerationSource(source: SummaryRecord['generationSource']): string {
  if (source === 'llm') return 'AI 总结';
  if (source === 'legacy') return '历史总结';
  return '降级总结';
}
