import { useMemo } from 'react';
import { nativeWorkAttemptKey, type NativeWorkDetail, type NativeWorkSnapshot } from '@shared/native-work';
import { MarkdownText } from '../MarkdownText';
import { ActivityRecordsView } from '../activity-feed/records-view';
import { nativeWorkConversationEvents } from './conversation-events';
import { useNativeWorkRecords } from './useNativeWorkRecords';
import { useRememberedDisclosure } from './preferences';
import type { NativeWorkTransport } from './transport';

export function NativeWorkDetails({ task, transport }: { task: NativeWorkSnapshot; transport: NativeWorkTransport }) {
  const key = nativeWorkAttemptKey(task.native);
  const { grouped, loaded, error, hasMore, retry, loadMore } = useNativeWorkRecords(task, transport);
  const conversation = useMemo(() => nativeWorkConversationEvents(task, grouped), [task, grouped]);
  return <div className="min-w-0 text-[11px]">
    {!loaded && <p className="text-deck-muted">正在读取…</p>}
    {error && <p role="alert" className="text-status-error">读取详情失败。<button onClick={retry}>重试</button></p>}
    {(task.detailStatus === 'partial' || grouped.some(record => record.incomplete || record.sourceTruncated)) &&
      <p className="mb-2 text-deck-muted">当前仅显示部分记录，可继续加载可用内容。</p>}
    {loaded && !grouped.length && <p className="text-deck-muted">{task.summary ?? '此运行实例尚未提供可读取的详情。'}</p>}
    {task.workKind === 'subagent' && grouped.length > 0 ?
      <ActivityRecordsView events={conversation} loaded={loaded} loadError={null}
        sessionId={task.native.sessionId} agentId={task.native.provider} isSdk={false}
        allowLocalAssets={false} interactivePending={false} /> : <div className="flex min-w-0 flex-col gap-2">
      {grouped.map(record =>
        <DetailRecord key={record.recordId} record={record} taskKey={key} />)}
    </div>}
    {hasMore && <button className="rail-action mt-2" onClick={loadMore}>{task.workKind === 'subagent' ? '加载更早记录' : '加载更多'}</button>}
  </div>;
}
function DetailRecord({ record, taskKey }: { record: NativeWorkDetail & { incomplete: boolean }; taskKey: string }) {
  const [expanded, setExpanded] = useRememberedDisclosure(`${taskKey}:${record.recordId}`, record.kind === 'output' || record.kind === 'message');
  const label = record.toolName ?? ({ message: '消息', thinking: '思考', output: '输出', 'tool-use-start': '工具调用', 'tool-use-end': '工具结果', 'file-changed': '文件改动' }[record.kind]);
  return <section className="min-w-0">
    <button className="mb-1 flex w-full items-center gap-1 text-left text-[10px] text-deck-muted" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      <span aria-hidden>{expanded ? '▾' : '▸'}</span>{label}
      {(record.sourceTruncated || record.incomplete) && <span> · 部分内容</span>}
    </button>
    {expanded && <MarkdownText text={record.text} />}
  </section>;
}
