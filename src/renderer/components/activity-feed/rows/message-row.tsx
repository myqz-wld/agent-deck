import { useState, type JSX } from 'react';
import type { AgentEvent } from '@shared/types';
import { MarkdownText } from '@renderer/components/MarkdownText';
import { DEFAULT_RENDER_MODE, getAgentShortName, type RenderMode } from '../shared';

/**
 * 普通消息气泡（user / assistant）。每条独立持有 MD/TXT mode（CHANGELOG_34/35：
 * 切单条不级联到全局，无 localStorage 持久化）。error 消息强制 plaintext 避免
 * markdown 解析掩盖错误堆栈结构。
 */
export function MessageBubble({
  event,
  agentId,
}: {
  event: AgentEvent;
  agentId: string;
}): JSX.Element {
  const p = (event.payload ?? {}) as { text?: string; role?: 'user' | 'assistant'; error?: boolean };
  const role = p.role === 'user' ? 'user' : 'assistant';
  const text = (p.text ?? '').trim();
  const isError = !!p.error;
  const isUser = role === 'user';
  const ts = new Date(event.ts).toLocaleTimeString('zh-CN', { hour12: false });
  const otherName = getAgentShortName(agentId);

  // 渲染模式：每条消息**独立**持有 mode state，互不级联（CHANGELOG_34 推翻
  // CHANGELOG_27「切单条 = 切全局」的取舍）。默认 plaintext，切换 toggle 只改本条
  // 本地 state；不再有 localStorage 持久化（CHANGELOG_35 删 render-mode.ts）。
  // 副作用：切过的 bubble 卸载（切会话 / 重启）后回到默认；这是有意为之，
  // 不引入「按 message id 持久化偏好 map」的复杂度。
  const [mode, setMode] = useState<RenderMode>(DEFAULT_RENDER_MODE);

  const toggle = (): void => {
    setMode((cur) => (cur === 'markdown' ? 'plaintext' : 'markdown'));
  };

  // error 消息保留 plaintext，避免 markdown 解析掩盖错误堆栈结构
  const renderAsMarkdown = mode === 'markdown' && !isError && text.length > 0;

  return (
    <li className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`flex max-w-[88%] flex-col ${isUser ? 'items-end' : 'items-start'}`}>
        <div
          className={`mb-0.5 flex items-center gap-1 text-[9px] ${
            isUser ? 'text-status-working/80' : 'text-deck-muted/70'
          }`}
        >
          <span>{isUser ? '你' : otherName}</span>
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
          className={`break-words rounded-lg px-2.5 py-1.5 text-[11px] leading-relaxed ${
            renderAsMarkdown ? '' : 'whitespace-pre-wrap'
          } ${
            isError
              ? 'border border-status-waiting/40 bg-status-waiting/10 text-status-waiting'
              : isUser
                ? 'bg-status-working/15 text-deck-text'
                : 'border border-deck-border bg-white/[0.04] text-deck-text'
          }`}
        >
          {text ? (
            renderAsMarkdown ? (
              <MarkdownText text={text} />
            ) : (
              text
            )
          ) : (
            <span className="text-deck-muted">（空消息）</span>
          )}
        </div>
      </div>
    </li>
  );
}
