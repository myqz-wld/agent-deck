import { useMemo, type JSX } from 'react';
import type { AgentDeckMessage } from '@shared/types';
import {
  ExpandableContent,
  type MessageContentPayload,
} from '@renderer/components/expandable-content';
import { MarkdownText } from '@renderer/components/MarkdownText';

export const MESSAGE_EXPAND_THRESHOLD = 600;

export function MessageDetailViewer({
  message,
  fromLabel,
  toLabel,
}: {
  message: AgentDeckMessage;
  fromLabel: string;
  toLabel: string;
}): JSX.Element {
  const payload = useMemo<MessageContentPayload>(() => ({
    kind: 'message',
    text: message.body,
    attachments: [],
    metadata: {
      from: fromLabel,
      to: toLabel,
      status: message.status,
      sentAt: message.sentAt,
      attemptCount: message.attemptCount,
      isReply: message.replyToMessageId !== null,
      ...(message.statusReason ? { statusReason: message.statusReason } : {}),
    },
  }), [fromLabel, message, toLabel]);

  return (
    <ExpandableContent<MessageContentPayload>
      identity={{
        sessionId: message.fromSessionId,
        kind: 'message',
        messageId: message.id,
        revision: `${message.status}:${message.deliveredAt ?? message.sentAt}`,
      }}
      payload={payload}
      title="跨会话消息详情"
      triggerLabel="展开完整消息"
    >
      {({ payload: selected }) => (
        <div className="min-w-0 space-y-3">
          <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 rounded border border-deck-border bg-white/[0.02] p-3 text-xs">
            <dt className="text-deck-muted">来源</dt><dd>{fromLabel}</dd>
            <dt className="text-deck-muted">接收方</dt><dd>{toLabel}</dd>
            <dt className="text-deck-muted">状态</dt><dd>{messageStatusLabel(message.status)}</dd>
            {message.replyToMessageId && <><dt className="text-deck-muted">关联</dt><dd>回复消息</dd></>}
            {message.statusReason && <><dt className="text-deck-muted">说明</dt><dd>{message.statusReason}</dd></>}
          </dl>
          <div className="min-w-0 break-words text-sm leading-relaxed">
            <MarkdownText text={selected.text} />
          </div>
        </div>
      )}
    </ExpandableContent>
  );
}

function messageStatusLabel(status: AgentDeckMessage['status']): string {
  switch (status) {
    case 'pending': return '等待投递';
    case 'delivering': return '正在投递';
    case 'delivered': return '已投递';
    case 'failed': return '投递失败';
    case 'cancelled': return '已取消';
  }
}
