import { useState, type JSX } from 'react';
import type { AgentEvent } from '@shared/types';
import { MarkdownText } from '@renderer/components/MarkdownText';
import { formatDisplayText } from '../format';
import { DEFAULT_RENDER_MODE, getAgentShortName, type RenderMode } from '../shared';

/** REVIEW_4 M16：thinking 内容默认折叠阈值。内容可能很长，阈值比 message 略低。 */
const COLLAPSE_THRESHOLD_CHARS = 600;

function thinkingCopy(agentId: string): { label: string; title: string; empty: string } {
  if (agentId === 'codex-cli') {
    return {
      label: 'REASONING SUMMARY',
      title: 'Codex reasoning summary from the model',
      empty: 'No reasoning summary for this turn',
    };
  }
  return {
    label: 'THINKING',
    title: '模型 THINKING 内容',
    empty: '暂无 THINKING 内容',
  };
}

/**
 * 模型提供的 thinking 内容。视觉与 MessageBubble 区分：dashed 边框 + 暗背景 + 斜体淡灰文字 +
 * 头部标签按 adapter 区分：Claude-family 显示 THINKING，Codex 保留 REASONING SUMMARY。
 * 默认 plaintext；超过 COLLAPSE_THRESHOLD_CHARS 字符默认折叠（max-height + 「展开」按钮）。
 */
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
  const otherName = getAgentShortName(agentId);
  const copy = thinkingCopy(agentId);
  const [mode, setMode] = useState<RenderMode>(DEFAULT_RENDER_MODE);
  // REVIEW_4 M16：超长 thinking 默认折叠
  const isLong = text.length > COLLAPSE_THRESHOLD_CHARS;
  const [expanded, setExpanded] = useState(false);
  const toggle = (): void => {
    setMode((cur) => (cur === 'markdown' ? 'plaintext' : 'markdown'));
  };
  const renderAsMarkdown = mode === 'markdown' && text.length > 0;

  return (
    <li className="flex justify-start">
      <div className="flex min-w-0 max-w-[88%] flex-col items-start">
        <div className="mb-0.5 flex items-center gap-1 text-[9px] text-deck-muted/60">
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
          {isLong && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              className="ml-1 rounded px-1 font-mono text-[9px] tracking-tight text-deck-muted/60 opacity-60 hover:bg-white/10 hover:text-deck-text hover:opacity-100"
            >
              {expanded ? '收起' : `展开（${text.length} 字）`}
            </button>
          )}
        </div>
        <div
          className={`min-w-0 max-w-full break-words rounded-lg border border-dashed border-deck-border/40 bg-white/[0.02] px-2.5 py-1.5 text-[11px] italic leading-relaxed text-deck-muted ${
            renderAsMarkdown ? '' : 'whitespace-pre-wrap'
          } ${isLong && !expanded ? 'max-h-56 overflow-auto scrollbar-deck' : ''}`}
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
