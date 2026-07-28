import { useEffect, useMemo, useState, type JSX } from 'react';
import {
  ExpandableContent,
  type DiagnosticContentPayload,
} from '@renderer/components/expandable-content';
import log from '@renderer/utils/logger';
import { safeErrorData } from '../activity-feed/viewers/safe-error-data';

const logger = log.scope('renderer-summarizer-errors');

/**
 * 显示 summarizer 最近一次失败原因（by sessionId），在「间歇总结」section 末尾。
 * 用户能直接看到「为什么这个会话没总结」，不必去 Console / 主进程 stderr 翻。
 *
 * 行为：
 * - mount 时拉一次。不订阅事件——错误数量低，开/关设置面板就重新拉够用
 * - 按 ts desc 显示前 5 条；空时显示「最近无 LLM 错误」
 * - 不带"清空"按钮：成功 summarize 后 main 端会自动清掉对应 sessionId
 */
export function SummarizerErrorsDiagnostic(): JSX.Element {
  const [errors, setErrors] = useState<Record<string, { message: string; ts: number }> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    void window.api
      .summarizerLastErrors()
      .then(setErrors)
      .catch((err: unknown) => {
        logger.warn('summarizer diagnostics load failed', {
          action: 'load-summarizer-diagnostics',
          agentId: null,
          sessionId: null,
          teamId: null,
          source: 'settings-summarizer',
          count: null,
          ...safeErrorData(err),
        });
        setError('读取诊断列表失败，请稍后重试。');
      });
  }, []);

  if (error) {
    return <div className="text-[10px] text-status-waiting leading-snug">{error}</div>;
  }

  if (errors === null) {
    return <div className="text-[10px] text-deck-muted leading-snug">读取诊断中…</div>;
  }

  const entries = Object.entries(errors).sort((a, b) => b[1].ts - a[1].ts);
  if (entries.length === 0) {
    return (
      <div className="text-[10px] text-deck-muted/70 leading-snug">最近无总结失败记录</div>
    );
  }

  return (
    <div className="flex flex-col gap-1 text-[10px] leading-snug">
      <div className="text-deck-muted/70">最近总结失败记录（前 5 条）</div>
      <ul className="flex flex-col gap-0.5">
        {entries.slice(0, 5).map(([sid, info]) => (
          <DiagnosticEntry key={sid} sessionId={sid} info={info} />
        ))}
      </ul>
    </div>
  );
}

function DiagnosticEntry({
  sessionId,
  info,
}: {
  sessionId: string;
  info: { message: string; ts: number };
}): JSX.Element {
  const payload = useMemo<DiagnosticContentPayload>(() => ({
    kind: 'diagnostic',
    text: info.message,
    severity: 'error',
    metadata: { timestamp: info.ts, category: 'summarizer' },
  }), [info.message, info.ts]);
  return (
    <li className="relative flex flex-col gap-0.5 rounded border border-status-waiting/30 bg-status-waiting/10 py-1.5 pl-1.5 pr-12">
      <ExpandableContent<DiagnosticContentPayload>
        identity={{
          sessionId,
          kind: 'diagnostic',
          diagnosticId: 'summarizer-last-error',
          revision: info.ts,
        }}
        payload={payload}
        title="总结失败诊断"
        triggerLabel="展开完整诊断"
      >
        {({ payload: selected }) => (
          <div className="min-w-0 whitespace-pre-wrap break-all text-sm leading-relaxed text-status-waiting">
            {selected.text}
          </div>
        )}
      </ExpandableContent>
      <div className="min-h-11 text-[9px] text-status-waiting/80">
        {new Date(info.ts).toLocaleTimeString()} · 会话诊断
      </div>
      <div className="max-h-20 overflow-hidden break-all text-status-waiting/90">
        {info.message.slice(0, 200)}
      </div>
      <div className="text-[9px] text-status-waiting/60">
        可检查模型名称、网络或账号权限后重试。
      </div>
    </li>
  );
}
