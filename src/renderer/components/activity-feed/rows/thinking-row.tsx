import { useState, type JSX } from 'react';
import type { AgentEvent } from '@shared/types';
import { MarkdownText } from '@renderer/components/MarkdownText';
import { formatDisplayText } from '../format';
import { DEFAULT_RENDER_MODE, type RenderMode } from '../shared';
import { ThinkingContentViewer } from '../viewers/ThinkingContentViewer';
import { activityEventIdentity } from '../viewers/activity-event-identity';

/** Thinking is often verbose, so use a slightly lower compact-list threshold. */
const COLLAPSE_THRESHOLD_CHARS = 600;

function thinkingCopy(agentId: string): { label: string; title: string; empty: string } {
  if (agentId === 'codex-cli') {
    return {
      label: '推理摘要',
      title: 'Codex CLI 模型推理摘要',
      empty: '本轮暂无推理摘要',
    };
  }
  return {
    label: '思考',
    title: '模型思考内容',
    empty: '暂无思考内容',
  };
}

function agentDisplayName(agentId: string): string {
  if (agentId === 'codex-cli') return 'Codex CLI';
  if (agentId === 'grok-build') return 'Grok Build';
  return 'Claude Code';
}

/** Model thinking with adapter-specific, concise Chinese labels and a full detail viewer. */
export function ThinkingBubble({
  event,
  agentId,
}: {
  event: AgentEvent;
  agentId: string;
}): JSX.Element {
  const p = (event.payload ?? {}) as { text?: string };
  const text = formatDisplayText(p.text).trim();
  const ts = new Date(event.ts).toLocaleTimeString('zh-CN', { hour12: false });
  const otherName = agentDisplayName(agentId);
  const copy = thinkingCopy(agentId);
  const [mode, setMode] = useState<RenderMode>(DEFAULT_RENDER_MODE);
  const isLong = text.length > COLLAPSE_THRESHOLD_CHARS;
  const toggle = (): void => {
    setMode((cur) => (cur === 'markdown' ? 'plaintext' : 'markdown'));
  };
  const renderAsMarkdown = mode === 'markdown' && text.length > 0;

  return (
    <li className="flex justify-start">
      <div className="relative flex min-w-0 max-w-[88%] flex-col items-start">
        <ThinkingContentViewer
          sessionId={event.sessionId}
          eventId={activityEventIdentity(event)}
          revision={event.ts}
          text={text}
          title={`${otherName} · ${copy.label}`}
          mode={mode}
          onToggleMode={toggle}
        />
        <div className="mb-0.5 flex min-h-11 items-center gap-1 pr-12 text-[9px] text-deck-muted/60">
          <span>{otherName}</span>
          <span className="text-deck-muted/40">·</span>
          <span className="font-mono uppercase tracking-wider" title={copy.title}>
            {copy.label}
          </span>
          <span className="text-deck-muted/40">·</span>
          <span className="font-mono tabular-nums text-deck-muted/40">{ts}</span>
          {text.length > 0 && (
            <button
              type="button"
              onClick={toggle}
              title={mode === 'markdown' ? '切换为纯文本' : '切换为 Markdown'}
              className="ml-1 rounded px-1 font-mono text-[9px] tracking-tight text-deck-muted/60 opacity-60 hover:bg-white/10 hover:text-deck-text hover:opacity-100"
            >
              {mode === 'markdown' ? 'MD' : 'TXT'}
            </button>
          )}
        </div>
        <div
          className={`min-w-0 max-w-full break-words rounded-lg border border-dashed border-deck-border/40 bg-white/[0.02] px-2.5 py-1.5 text-[11px] italic leading-relaxed text-deck-muted ${
            renderAsMarkdown ? '' : 'whitespace-pre-wrap'
          } ${isLong ? 'max-h-56 overflow-hidden pr-12' : 'pr-12'}`}
        >
          {text ? (
            renderAsMarkdown ? (
              <MarkdownText text={text} />
            ) : (
              text
            )
          ) : (
            <span className="text-deck-muted/60">{copy.empty}</span>
          )}
        </div>
      </div>
    </li>
  );
}
