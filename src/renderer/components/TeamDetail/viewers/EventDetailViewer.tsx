import { useMemo, useState, type JSX } from 'react';
import type { AgentEvent, DiffPayload, ImageSource } from '@shared/types';
import {
  ExpandableContent,
  type DiagnosticContentPayload,
  type ExpandableContentPayload,
  type ExpandableHeavyViewSpec,
  type MessageContentPayload,
  type ToolContentPayload,
} from '@renderer/components/expandable-content';
import { DiffViewer } from '@renderer/components/diff/DiffViewer';
import {
  localDiffContent,
  toolPayload,
} from '@renderer/components/activity-feed/viewers/content-reference';
import {
  createMessageContentPayload,
  normalizeAgentMessage,
  type NormalizedAgentMessage,
} from '@renderer/components/activity-feed/viewers/message-content';
import { ExpandedMessage } from '@renderer/components/activity-feed/viewers/MessageContentViewer';
import {
  formatToolDuration,
  providerTruncationLabel,
  toolStatusView,
} from '@renderer/components/activity-feed/tool-status';
import {
  formatDisplayText,
  formatToolInput,
  formatToolResult,
} from '@renderer/components/activity-feed/format';
import { DEFAULT_RENDER_MODE, type RenderMode } from '@renderer/components/activity-feed/shared';
import { eventKindLabel } from '../helpers';

type EventModel =
  | {
      kind: 'message';
      payload: MessageContentPayload;
      message: NormalizedAgentMessage;
    }
  | {
      kind: 'tool';
      payload: ToolContentPayload;
    }
  | {
      kind: 'diff';
      payload: ExpandableContentPayload;
      heavyView: ExpandableHeavyViewSpec;
    }
  | {
      kind: 'structured';
      payload: DiagnosticContentPayload;
    };

export function EventDetailViewer({
  event,
  eventId,
}: {
  event: AgentEvent;
  eventId: number;
}): JSX.Element {
  const [messageMode, setMessageMode] = useState<RenderMode>(DEFAULT_RENDER_MODE);
  const model = useMemo(
    () => buildEventModel(event, eventId, messageMode),
    [event, eventId, messageMode],
  );
  const label = eventLabel(event);
  return (
    <ExpandableContent
      identity={{
        sessionId: event.sessionId,
        kind: 'event',
        eventId: String(eventId),
        revision: event.ts,
      }}
      payload={model.payload}
      title={`${label}详情`}
      triggerLabel={`展开${label}详情`}
      heavyView={model.kind === 'diff' ? model.heavyView : undefined}
      actions={model.kind === 'message' && model.message.text && !model.message.isError ? (
        <button
          type="button"
          onClick={() => {
            setMessageMode((current) => current === 'markdown' ? 'plaintext' : 'markdown');
          }}
          className="min-h-11 rounded px-3 text-xs text-deck-muted hover:bg-white/10 hover:text-deck-text"
        >
          {messageMode === 'markdown' ? '显示纯文本' : '显示 Markdown'}
        </button>
      ) : null}
    >
      <ExpandedEvent event={event} model={model} messageMode={messageMode} />
    </ExpandableContent>
  );
}

function eventLabel(event: AgentEvent): string {
  if (event.kind === 'thinking') {
    return event.agentId === 'codex-cli' ? '推理摘要' : '思考';
  }
  return eventKindLabel(event.kind, event.agentId);
}

function buildEventModel(
  event: AgentEvent,
  eventId: number,
  messageMode: RenderMode,
): EventModel {
  const value = event.payload && typeof event.payload === 'object'
    ? event.payload as Record<string, unknown>
    : {};
  if (event.kind === 'message') {
    const message = normalizeAgentMessage(event);
    return {
      kind: 'message',
      message,
      payload: createMessageContentPayload(message, messageMode, {
        source: event.source ?? null,
      }),
    };
  }
  if (event.kind === 'tool-use-start' || event.kind === 'tool-use-end') {
    const status = event.kind === 'tool-use-end' ? toolStatusView(value) : null;
    const rawResult = value.toolResult ?? value.toolResponse;
    const reason = formatToolResult(value.reason);
    const failure = formatToolResult(value.error);
    return {
      kind: 'tool',
      payload: toolPayload({
        toolName: formatDisplayText(value.toolName) || '工具',
        toolInput: value.toolInput,
        resultStatus: event.kind === 'tool-use-start'
          ? 'pending'
          : status?.isError ? 'error' : 'success',
        resultValue: rawResult,
        resultText: event.kind === 'tool-use-end' ? formatToolResult(rawResult) : undefined,
        statusLabel: status?.label ?? '准备执行',
        statusDetail: status?.detail,
        duration: formatToolDuration(value.durationMs),
        truncation: providerTruncationLabel(value),
        reason,
        failure,
      }),
    };
  }
  if (event.kind === 'file-changed') {
    const diff = eventDiff(value, event.ts);
    if (diff) {
      const content = localDiffContent({
        sessionId: event.sessionId,
        eventId: String(eventId),
        toolName: '文件改动',
        diff,
      });
      return {
        kind: 'diff',
        payload: content.payload,
        heavyView: {
          id: `team-event-diff-${event.sessionId}-${eventId}`,
          kind: diff.kind === 'image' ? 'image-diff' : 'monaco',
          render: () => {
            const resolved = content.resolve(content.payload.reference);
            return resolved ? (
              <div className="min-h-[20rem] flex-1">
                <DiffViewer payload={resolved} sessionId={event.sessionId} expanded />
              </div>
            ) : <UnavailableContent />;
          },
        },
      };
    }
  }
  return {
    kind: 'structured',
    payload: {
      kind: 'diagnostic',
      text: fullPayloadText(event.payload),
      severity: event.kind === 'session-end' ? 'warning' : 'info',
      metadata: { eventKind: event.kind, timestamp: event.ts },
    },
  };
}

function ExpandedEvent({
  event,
  model,
  messageMode,
}: {
  event: AgentEvent;
  model: EventModel;
  messageMode: RenderMode;
}): JSX.Element {
  if (model.kind === 'message') {
    return (
      <ExpandedMessage
        payload={model.payload}
        mode={messageMode}
        isError={model.message.isError}
        attachmentRefs={model.message.attachments}
        handOffContext={model.message.handOffContext}
      />
    );
  }
  if (model.kind === 'tool') {
    return <ExpandedTool event={event} payload={model.payload} />;
  }
  if (model.kind === 'structured') {
    return (
      <pre className="max-h-[60vh] min-w-0 overflow-auto whitespace-pre-wrap break-words rounded bg-black/30 p-3 text-xs scrollbar-deck">
        {model.payload.text}
      </pre>
    );
  }
  return <div className="text-xs text-deck-muted">完整内容显示在下方查看器中。</div>;
}

function ExpandedTool({
  event,
  payload,
}: {
  event: AgentEvent;
  payload: ToolContentPayload;
}): JSX.Element {
  const value = event.payload && typeof event.payload === 'object'
    ? event.payload as Record<string, unknown>
    : {};
  const status = String(payload.metadata?.status ?? '');
  const detail = payload.metadata?.statusDetail;
  const duration = payload.metadata?.duration;
  const truncation = payload.metadata?.truncation;
  const reason = payload.metadata?.reason;
  const failure = payload.metadata?.failure;
  return (
    <div className="mb-3 min-w-0 space-y-3 text-sm">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
        <dt className="text-deck-muted">工具</dt>
        <dd className="break-all font-mono">{payload.toolName}</dd>
        <dt className="text-deck-muted">状态</dt>
        <dd>{status}{detail ? ` · ${String(detail)}` : ''}</dd>
        {duration && <><dt className="text-deck-muted">耗时</dt><dd>{String(duration)}</dd></>}
        {truncation && (
          <><dt className="text-deck-muted">完整性</dt><dd>{String(truncation)}</dd></>
        )}
      </dl>
      <section>
        <h3 className="mb-1 text-xs text-deck-muted">完整输入</h3>
        <pre className="max-h-[40vh] overflow-auto whitespace-pre-wrap break-words rounded bg-black/30 p-3 text-xs scrollbar-deck">
          {formatToolInput(value.toolInput)}
        </pre>
      </section>
      {event.kind === 'tool-use-end' && (
        <section>
          <h3 className="mb-1 text-xs text-deck-muted">完整结果</h3>
          <pre className="max-h-[40vh] overflow-auto whitespace-pre-wrap break-words rounded bg-black/30 p-3 text-xs scrollbar-deck">
            {payload.result?.text || '（无输出）'}
          </pre>
        </section>
      )}
      {reason && (
        <section>
          <h3 className="mb-1 text-xs text-deck-muted">原因</h3>
          <pre className="max-h-[30vh] overflow-auto whitespace-pre-wrap break-words rounded bg-black/30 p-3 text-xs scrollbar-deck">
            {String(reason)}
          </pre>
        </section>
      )}
      {failure && (
        <section>
          <h3 className="mb-1 text-xs text-deck-muted">失败信息</h3>
          <pre className="max-h-[30vh] overflow-auto whitespace-pre-wrap break-words rounded bg-black/30 p-3 text-xs scrollbar-deck">
            {String(failure)}
          </pre>
        </section>
      )}
    </div>
  );
}

function fullPayloadText(payload: unknown): string {
  if (payload === undefined) return '（无载荷）';
  if (typeof payload === 'string') return payload || '（空载荷）';
  return formatToolInput(payload);
}

function eventDiff(payload: Record<string, unknown>, timestamp: number): DiffPayload | null {
  if (typeof payload.filePath !== 'string' || !payload.filePath) return null;
  const inferredKind = typeof payload.kind === 'string'
    ? payload.kind
    : isImageSource(payload.before) || isImageSource(payload.after) ? 'image' : 'text';
  return {
    kind: inferredKind,
    filePath: payload.filePath,
    before: payload.before ?? null,
    after: payload.after ?? null,
    metadata: payload.metadata && typeof payload.metadata === 'object'
      ? payload.metadata as Record<string, unknown>
      : undefined,
    ts: timestamp,
  };
}

function isImageSource(value: unknown): value is ImageSource {
  return !!value
    && typeof value === 'object'
    && ((value as { kind?: unknown }).kind === 'path'
      || (value as { kind?: unknown }).kind === 'snapshot');
}

function UnavailableContent(): JSX.Element {
  return (
    <div className="flex min-h-64 items-center justify-center text-sm text-deck-muted">
      内容引用已失效
    </div>
  );
}
