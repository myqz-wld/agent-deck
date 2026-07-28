import type { IssueAppendix, LogsRef } from '@shared/types';
import type { JSX } from 'react';
import {
  ExpandableContent,
  type DiagnosticContentPayload,
} from '../expandable-content';
import { ExternalLinkIcon } from '../icons';

function formatTime(value: number): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function logsPayload(logsRef: LogsRef, text: string): DiagnosticContentPayload {
  return {
    kind: 'diagnostic',
    text,
    metadata: {
      date: logsRef.date,
      rangeStart: logsRef.tsRange?.start ?? null,
      rangeEnd: logsRef.tsRange?.end ?? null,
      scopes: logsRef.scopes ?? [],
      note: logsRef.note ?? null,
    },
  };
}

function LogsReferenceDetails({ logsRef }: { logsRef: LogsRef }): JSX.Element {
  return (
    <dl className="space-y-1 text-[11px] leading-relaxed text-deck-muted">
      <div>
        <dt className="inline font-medium text-deck-text">日志日期：</dt>
        <dd className="inline">{logsRef.date}</dd>
      </div>
      {logsRef.tsRange && (
        <div>
          <dt className="inline font-medium text-deck-text">相关时段：</dt>
          <dd className="inline">
            {formatTime(logsRef.tsRange.start)} 至 {formatTime(logsRef.tsRange.end)}
          </dd>
        </div>
      )}
      {(logsRef.scopes?.length ?? 0) > 0 && (
        <div>
          <dt className="inline font-medium text-deck-text">相关范围：</dt>
          <dd className="inline">{logsRef.scopes!.join('、')}</dd>
        </div>
      )}
      {logsRef.note && (
        <div>
          <dt className="font-medium text-deck-text">补充说明：</dt>
          <dd className="whitespace-pre-wrap break-words">{logsRef.note}</dd>
        </div>
      )}
    </dl>
  );
}

export function IssueLogsReference({
  issueId,
  sessionId,
  logsRef,
}: {
  issueId: string;
  sessionId: string;
  logsRef: LogsRef;
}): JSX.Element {
  const payload = logsPayload(logsRef, logsRef.note ?? '');
  return (
    <div className="relative rounded bg-white/[0.03] px-2 py-2 pr-12">
      <div className="mb-1 text-[10px] font-medium text-deck-muted">日志线索</div>
      <LogsReferenceDetails logsRef={logsRef} />
      <ExpandableContent<DiagnosticContentPayload>
        identity={{
          sessionId,
          kind: 'diagnostic',
          diagnosticId: `${issueId}:logs`,
        }}
        payload={payload}
        title="日志线索详情"
        triggerLabel="展开日志线索"
      >
        <div className="mx-auto w-full max-w-4xl rounded border border-deck-border bg-black/20 p-4">
          <LogsReferenceDetails logsRef={logsRef} />
        </div>
      </ExpandableContent>
    </div>
  );
}

function AppendixDetails({
  appendix,
  onOpenSession,
}: {
  appendix: IssueAppendix;
  onOpenSession?: (sessionId: string) => void;
}): JSX.Element {
  return (
    <div className="space-y-3">
      <div className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-deck-text">
        {appendix.body}
      </div>
      {appendix.logsRef && (
        <div className="rounded border border-deck-border/60 bg-black/20 p-3">
          <div className="mb-1 text-[10px] font-medium text-deck-text">关联日志线索</div>
          <LogsReferenceDetails logsRef={appendix.logsRef} />
        </div>
      )}
      {appendix.appendedSessionId && onOpenSession && (
        <button
          type="button"
          onClick={() => onOpenSession(appendix.appendedSessionId!)}
          className="text-[10px] text-status-working underline-offset-2 hover:underline"
        >
          打开补充记录的来源会话
          <ExternalLinkIcon className="ml-1 inline h-3 w-3" />
        </button>
      )}
    </div>
  );
}

export function IssueAppendices({
  issueId,
  sessionId,
  appendices,
  onOpenSession,
}: {
  issueId: string;
  sessionId: string;
  appendices: IssueAppendix[];
  onOpenSession?: (sessionId: string) => void;
}): JSX.Element | null {
  if (appendices.length === 0) return null;
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-medium text-deck-muted">
        补充记录（{appendices.length}）
      </h3>
      <ul className="space-y-1.5">
        {appendices.map((appendix) => {
          const payload: DiagnosticContentPayload = {
            kind: 'diagnostic',
            text: appendix.body,
            metadata: appendix.logsRef
              ? logsPayload(appendix.logsRef, appendix.body).metadata
              : {
                  appendedAt: appendix.appendedAt,
                  hasLogsReference: false,
                },
          };
          return (
            <li
              key={appendix.id}
              className="relative rounded bg-white/[0.03] px-2 py-1.5 pr-12 text-[11px] text-deck-text"
            >
              <div className="mb-1 text-[10px] text-deck-muted">
                {formatTime(appendix.appendedAt)}
                {appendix.appendedSessionId ? ' · 由相关会话补充' : ' · 来源会话已清理'}
                {appendix.logsRef ? ' · 含日志线索' : ''}
              </div>
              <div className="max-h-24 overflow-hidden whitespace-pre-wrap break-words">
                {appendix.body}
              </div>
              {appendix.logsRef && (
                <div className="mt-2 rounded border border-deck-border/50 bg-black/15 p-2">
                  <div className="mb-1 text-[10px] font-medium text-deck-text">
                    关联日志线索
                  </div>
                  <LogsReferenceDetails logsRef={appendix.logsRef} />
                </div>
              )}
              <ExpandableContent<DiagnosticContentPayload>
                identity={{
                  sessionId,
                  kind: 'diagnostic',
                  diagnosticId: `${issueId}:appendix:${appendix.id}`,
                }}
                payload={payload}
                title="补充记录详情"
                triggerLabel="展开补充记录"
              >
                <AppendixDetails appendix={appendix} onOpenSession={onOpenSession} />
              </ExpandableContent>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
