import { useEffect, useMemo, useState } from 'react';
import { nativeWorkAttemptKey, type NativeWorkDetail, type NativeWorkSnapshot } from '@shared/native-work';
import { MarkdownText } from '../MarkdownText';
import { useRememberedDisclosure } from './preferences';
import type { NativeWorkTransport } from './transport';

export function NativeWorkDetails({ task, transport }: { task: NativeWorkSnapshot; transport: NativeWorkTransport }) {
  const key = nativeWorkAttemptKey(task.native);
  const [records, setRecords] = useState<Array<NativeWorkDetail & { id: number }>>([]);
  const [pages, setPages] = useState(1), [hasMore, setHasMore] = useState(false);
  const [loaded, setLoaded] = useState(false), [error, setError] = useState(false), [retry, setRetry] = useState(0);
  const [outputOnly, setOutputOnly] = useRememberedDisclosure(`${key}:output-tab`, false);
  const [plaintext, setPlaintext] = useRememberedDisclosure(`${key}:plaintext`, false);
  useEffect(() => { setRecords([]); setPages(1); setLoaded(false); }, [key]);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const collected: Array<NativeWorkDetail & { id: number }> = [];
        let cursor: number | undefined;
        for (let index = 0; index < pages; index++) {
          const page = await transport.details({ ref: task.native, ...(cursor ? { cursor } : {}) });
          if (cancelled) return;
          collected.push(...page.records);
          cursor = page.nextCursor ?? undefined;
          if (!cursor) break;
        }
        if (!cancelled) { setRecords(collected); setHasMore(cursor !== undefined); setLoaded(true); setError(false); }
      } catch { if (!cancelled) { setError(true); setLoaded(true); } }
    };
    void load();
    return () => { cancelled = true; };
  }, [key, task.revision, task.updatedAt, task.native.runtimeId, transport, pages, retry]);
  const grouped = useMemo(() => {
    const groups = new Map<string, NativeWorkDetail[]>();
    for (const record of records) {
      const previous = groups.get(record.recordId) ?? [];
      if (previous[0] && previous[0].recordRevision > record.recordRevision) continue;
      groups.set(record.recordId, [...(previous[0]?.recordRevision === record.recordRevision ? previous : []), record]);
    }
    return [...groups.values()].map(parts => {
      parts.sort((a, b) => a.part - b.part);
      return { ...parts[0], text: parts.map(part => part.text).join(''), incomplete: parts.length !== parts[0].parts };
    });
  }, [records]);
  return <div className="min-w-0 text-[11px]">
    <div className="mb-2 flex items-center gap-3 text-[10px]">
      <button aria-pressed={!outputOnly} onClick={() => setOutputOnly(false)}>活动</button>
      <button aria-pressed={outputOnly} onClick={() => setOutputOnly(true)}>输出</button>
      <button className="ml-auto text-deck-muted" onClick={() => setPlaintext(value => !value)}>{plaintext ? 'Markdown' : '纯文本'}</button>
    </div>
    {!loaded && <p className="text-deck-muted">正在读取…</p>}
    {error && <p role="alert" className="text-status-error">读取详情失败。<button onClick={() => setRetry(value => value + 1)}>重试</button></p>}
    {task.detailStatus === 'partial' && <p className="mb-2 text-deck-muted">上游只提供了部分记录。</p>}
    {loaded && !grouped.length && <p className="text-deck-muted">{task.summary ?? '此运行实例尚未提供可读取的详情。'}</p>}
    <div className="flex min-w-0 flex-col gap-2">
      {grouped.filter(record => !outputOnly || ['output', 'message', 'tool-use-end'].includes(record.kind)).map(record =>
        <DetailRecord key={record.recordId} record={record} plaintext={plaintext} taskKey={key} />)}
    </div>
    {hasMore && <button className="rail-action mt-2" onClick={() => setPages(value => value + 1)}>加载更多</button>}
  </div>;
}
function DetailRecord({ record, plaintext, taskKey }: { record: NativeWorkDetail & { incomplete: boolean }; plaintext: boolean; taskKey: string }) {
  const [expanded, setExpanded] = useRememberedDisclosure(`${taskKey}:${record.recordId}`, record.kind === 'output' || record.kind === 'message');
  const label = record.toolName ?? ({ message: '消息', thinking: '思考', output: '输出', 'tool-use-start': '工具调用', 'tool-use-end': '工具结果', 'file-changed': '文件改动' }[record.kind]);
  return <section className="min-w-0">
    <button className="mb-1 flex w-full items-center gap-1 text-left text-[10px] text-deck-muted" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      <span aria-hidden>{expanded ? '▾' : '▸'}</span>{label}
      {(record.sourceTruncated || record.incomplete) && <span> · 部分内容</span>}
    </button>
    {expanded && (plaintext ? <pre className="whitespace-pre-wrap break-words text-[10px]">{record.text}</pre> : <MarkdownText text={record.text} />)}
  </section>;
}
