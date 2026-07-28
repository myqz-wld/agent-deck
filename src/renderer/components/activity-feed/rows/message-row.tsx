import { useState, type JSX } from 'react';
import type { AgentEvent } from '@shared/types';
import { MarkdownText } from '@renderer/components/MarkdownText';
import { UploadedImageThumb } from '@renderer/components/UploadedImageThumb';
import { ReplyIcon } from '@renderer/components/icons';
import { DEFAULT_RENDER_MODE, type RenderMode } from '../shared';
import { MessageContentViewer } from '../viewers/MessageContentViewer';
import { activityEventIdentity } from '../viewers/activity-event-identity';
import {
  normalizeAgentMessage,
  productName,
} from '../viewers/message-content';

/** Prevent a single large prompt or log from dominating the activity list. */
const COLLAPSE_THRESHOLD_CHARS = 800;

/**
 * Each message owns its render mode. Errors remain plaintext so Markdown cannot obscure stacks.
 * User attachments are optional, which keeps older persisted events compatible.
 */
export function MessageBubble({
  event,
  agentId,
}: {
  event: AgentEvent;
  agentId: string;
}): JSX.Element {
  const message = normalizeAgentMessage(event);
  const {
    attachments,
    handOffContext,
    handOffDisclosureSummary,
    handOffLabel,
    handOffTooltip,
    isError,
    isUser,
    text,
    wireFrom,
    wireAdapter,
  } = message;
  const ts = new Date(event.ts).toLocaleTimeString('zh-CN', { hour12: false });
  const otherName = productName(agentId);

  // Render mode is local and intentionally resets when the bubble unmounts.
  const [mode, setMode] = useState<RenderMode>(DEFAULT_RENDER_MODE);
  const isLong = text.length > COLLAPSE_THRESHOLD_CHARS;

  const toggle = (): void => {
    setMode((cur) => (cur === 'markdown' ? 'plaintext' : 'markdown'));
  };

  // error 消息保留 plaintext，避免 markdown 解析掩盖错误堆栈结构
  const renderAsMarkdown = mode === 'markdown' && !isError && text.length > 0;
  // 「空消息」判定：纯文本时空; 但带附图就不算空
  const hasContent = text.length > 0 || (attachments && attachments.length > 0);

  return (
    <li className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`relative flex min-w-0 max-w-[88%] flex-col ${isUser ? 'items-end' : 'items-start'}`}>
        <MessageContentViewer
          sessionId={event.sessionId}
          messageId={activityEventIdentity(event)}
          revision={event.ts}
          title={`${isUser ? '你的' : otherName}消息详情`}
          message={message}
          mode={mode}
          onToggleMode={toggle}
        />
        <div
          className={`mb-0.5 flex min-h-11 items-center gap-1 pr-12 text-[9px] ${
            isUser ? 'text-status-working/80' : 'text-deck-muted/70'
          }`}
        >
          <span>{isUser ? '你' : otherName}</span>
          {wireFrom && (
            <span
              className="ml-0.5 inline-flex max-w-[16rem] items-center gap-0.5 truncate rounded bg-cyan-500/15 px-1 py-0.5 text-[9px] font-medium text-cyan-300"
              title={`来自 ${wireFrom}（${wireAdapter}）`}
            >
              <ReplyIcon className="mr-0.5 inline h-3 w-3" />{wireFrom}
            </span>
          )}
          {handOffLabel && (
            <span
              className="ml-0.5 inline-flex max-w-[20rem] items-center gap-0.5 truncate rounded bg-cyan-500/15 px-1 py-0.5 text-[9px] font-medium text-cyan-300"
              title={handOffTooltip ?? handOffLabel}
            >
              {handOffLabel}
            </span>
          )}
          <span className="text-deck-muted/50">·</span>
          <span className="font-mono tabular-nums text-deck-muted/50">{ts}</span>
          {!isError && text.length > 0 && (
            <button
              type="button"
              onClick={toggle}
              title={mode === 'markdown' ? '切换为纯文本' : '切换为 Markdown'}
              className="ml-1 rounded px-1 font-mono text-[9px] tracking-tight text-deck-muted/70 opacity-60 hover:bg-white/10 hover:text-deck-text hover:opacity-100"
            >
              {mode === 'markdown' ? 'MD' : 'TXT'}
            </button>
          )}
        </div>
        <div
          className={`min-w-0 max-w-full break-words rounded-lg px-2.5 py-1.5 text-[11px] leading-relaxed ${
            renderAsMarkdown ? '' : 'whitespace-pre-wrap'
          } ${
            isLong ? 'max-h-72 overflow-hidden pr-12' : 'pr-12'
          } ${
            isError
              ? 'border border-status-waiting/40 bg-status-waiting/10 text-status-waiting'
              : isUser
                ? 'bg-status-working/15 text-deck-text'
                : 'border border-deck-border bg-white/[0.04] text-deck-text'
          }`}
        >
          {handOffContext && (
            <details className="mb-1.5 rounded border border-cyan-500/30 bg-cyan-500/5 px-1.5 py-1">
              <summary className="cursor-pointer select-none text-[10px] text-cyan-300/80 hover:text-cyan-200">
                {handOffDisclosureSummary}
              </summary>
              <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[10px] leading-snug text-cyan-100/85">
                {handOffContext}
              </pre>
            </details>
          )}
          {text ? (
            renderAsMarkdown ? (
              <MarkdownText text={text} />
            ) : (
              text
            )
          ) : !hasContent ? (
            <span className="text-deck-muted">（空消息）</span>
          ) : null}
          {attachments && attachments.length > 0 && (
            <div className={`flex flex-wrap gap-1.5 ${text.length > 0 ? 'mt-1.5' : ''}`}>
              {attachments.map((a, i) => (
                <UploadedImageThumb
                  key={`${a.path}-${i}`}
                  path={a.path}
                  size={64}
                  alt={`附件图片 ${i + 1}`}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}
