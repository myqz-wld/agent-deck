import { useState, type JSX } from 'react';
import type { AgentEvent } from '@shared/types';
import { MarkdownText } from '@renderer/components/MarkdownText';
import { formatDisplayText } from '../format';
import {
  DEFAULT_RENDER_MODE,
  getAgentShortName,
  type RenderMode,
} from '../shared';
import { ChevronDownIcon, ChevronUpIcon } from '../../icons';
import { PlanProgress } from './plan-progress';

/** Thinking is often verbose, so use a slightly lower compact-list threshold. */
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

/** Model thinking with adapter-specific labels and the original inline long-text disclosure. */
export function ThinkingBubble({
  event,
  agentId,
}: {
  event: AgentEvent;
  agentId: string;
}): JSX.Element {
  const p = (event.payload ?? {}) as { text?: string; plan?: boolean; entries?: unknown; explanation?: unknown };
  const text = formatDisplayText(p.text).trim();
  const ts = new Date(event.ts).toLocaleTimeString('zh-CN', { hour12: false });
  const otherName = getAgentShortName(agentId);
  const copy = p.plan ? { label: 'PLAN', title: '计划进度', empty: '暂无计划内容' } : thinkingCopy(agentId);
  const [mode, setMode] = useState<RenderMode>(DEFAULT_RENDER_MODE);
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
              onClick={() => setExpanded((value) => !value)}
              aria-expanded={expanded}
              className="ml-1 rounded px-1 font-mono text-[9px] tracking-tight text-deck-muted/60 opacity-60 hover:bg-white/10 hover:text-deck-text hover:opacity-100"
            >
              {expanded
                ? <ChevronUpIcon className="mr-0.5 inline h-3 w-3" />
                : <ChevronDownIcon className="mr-0.5 inline h-3 w-3" />}
              {expanded ? '收起' : `展开（${text.length} 字）`}
            </button>
          )}
        </div>
        <div
          className={`min-w-0 max-w-full break-words rounded-lg border border-deck-border/60 bg-black/[0.08] px-2.5 py-1.5 text-[11px] leading-relaxed text-deck-muted ${
            renderAsMarkdown ? '' : 'whitespace-pre-wrap'
          } ${isLong && !expanded ? 'max-h-56 overflow-auto scrollbar-deck' : ''}`}
        >
          {p.plan && typeof p.explanation === 'string' && <div className="mb-2">{p.explanation}</div>}
          {p.plan && mode === 'markdown' && Array.isArray(p.entries) && p.entries.length > 0 ? <PlanProgress entries={p.entries} /> : text ? (
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
