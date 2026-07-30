import { useState, type JSX } from 'react';
import type { AgentEvent } from '@shared/types';
import { MarkdownText } from '@renderer/components/MarkdownText';
import { UploadedImageThumb } from '@renderer/components/UploadedImageThumb';
import { ImageLightbox } from '@renderer/components/ImageLightbox';
import {
  ChevronDownIcon,
  ChevronUpIcon,
  ReplyIcon,
} from '@renderer/components/icons';
import {
  DEFAULT_RENDER_MODE,
  getAgentShortName,
  type RenderMode,
} from '../shared';
import { normalizeAgentMessage } from '../viewers/message-content';

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
    isSystem,
    isUser,
    text,
    wireFrom,
    wireAdapter,
  } = message;
  const ts = new Date(event.ts).toLocaleTimeString('zh-CN', { hour12: false });
  const otherName = getAgentShortName(agentId);

  // Render mode is local and intentionally resets when the bubble unmounts.
  const [mode, setMode] = useState<RenderMode>(DEFAULT_RENDER_MODE);
  const isLong = !isSystem && text.length > COLLAPSE_THRESHOLD_CHARS;
  const [expanded, setExpanded] = useState(false);
  const [lightboxPath, setLightboxPath] = useState<string | null>(null);

  const toggle = (): void => {
    setMode((cur) => (cur === 'markdown' ? 'plaintext' : 'markdown'));
  };

  // error 消息保留 plaintext，避免 markdown 解析掩盖错误堆栈结构
  const renderAsMarkdown =
    !isSystem && mode === 'markdown' && !isError && text.length > 0;
  // 「空消息」判定：纯文本时空; 但带附图就不算空
  const hasContent = text.length > 0 || (attachments && attachments.length > 0);

  return (
    <li className={`flex ${
      isSystem ? 'justify-center' : isUser ? 'justify-end' : 'justify-start'
    }`}>
      <div className={`flex min-w-0 ${
        isSystem ? 'max-w-[92%] items-center' : `max-w-[88%] ${isUser ? 'items-end' : 'items-start'}`
      } flex-col`}>
        <div
          className={`mb-0.5 flex items-center gap-1 text-[9px] ${
            isUser ? 'text-status-working/80' : 'text-deck-muted/70'
          }`}
        >
          <span>{isSystem ? '系统' : isUser ? '你' : otherName}</span>
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
          {!isSystem && !isError && text.length > 0 && (
            <button
              type="button"
              onClick={toggle}
              title={mode === 'markdown' ? '切换为纯文本' : '切换为 Markdown'}
              className="ml-1 rounded px-1 font-mono text-[9px] tracking-tight text-deck-muted/70 opacity-60 hover:bg-white/10 hover:text-deck-text hover:opacity-100"
            >
              {mode === 'markdown' ? 'MD' : 'TXT'}
            </button>
          )}
          {isLong && (
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              aria-expanded={expanded}
              className="ml-1 rounded px-1 font-mono text-[9px] tracking-tight text-deck-muted/70 opacity-60 hover:bg-white/10 hover:text-deck-text hover:opacity-100"
            >
              {expanded
                ? <ChevronUpIcon className="mr-0.5 inline h-3 w-3" />
                : <ChevronDownIcon className="mr-0.5 inline h-3 w-3" />}
              {expanded ? '收起' : `展开（${text.length} 字）`}
            </button>
          )}
        </div>
        <div
          className={`min-w-0 max-w-full break-words rounded-lg px-2.5 py-1.5 text-[11px] leading-relaxed ${
            renderAsMarkdown ? '' : 'whitespace-pre-wrap'
          } ${
            isLong && !expanded ? 'max-h-72 overflow-auto scrollbar-deck' : ''
          } ${
            isError
              ? 'border border-status-waiting/40 bg-status-waiting/10 text-status-waiting'
              : isSystem
                ? 'border border-deck-border/70 bg-white/[0.025] px-2 py-1 text-[10px] text-deck-muted'
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
                  onClick={() => setLightboxPath(a.path)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
      {lightboxPath && (
        <ImageLightbox
          onClose={() => setLightboxPath(null)}
          path={lightboxPath}
          alt="放大的附件图片"
        />
      )}
    </li>
  );
}
