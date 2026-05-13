import { useState, type JSX } from 'react';
import type { AgentEvent, UploadedAttachmentRef } from '@shared/types';
import { parseWirePrefix } from '@shared/wire-prefix';
import { MarkdownText } from '@renderer/components/MarkdownText';
import { UploadedImageThumb } from '@renderer/components/UploadedImageThumb';
import { DEFAULT_RENDER_MODE, getAgentShortName, type RenderMode } from '../shared';

/** REVIEW_4 M16：超过此字符数的 message 默认折叠（max-height + 展开按钮），
 *  防止单条几十 KB 文本（罕见但 SDK 偶尔会推超长 system 提示 / 用户粘贴大段日志）
 *  把整列表撑成一面墙。阈值 800 ≈ 40-60 行普通文本，足够大多数对话不被打扰。 */
const COLLAPSE_THRESHOLD_CHARS = 800;

/**
 * 普通消息气泡（user / assistant）。每条独立持有 MD/TXT mode（CHANGELOG_34/35：
 * 切单条不级联到全局，无 localStorage 持久化）。error 消息强制 plaintext 避免
 * markdown 解析掩盖错误堆栈结构。
 *
 * 附图渲染（CHANGELOG_<X>）：role='user' 且 payload.attachments?.length > 0 时，
 * 文字气泡下方栅格显示缩略图。**无 schema migration**：老 events 行
 * `payload.attachments === undefined`，optional chaining 自然等价于「无图」。
 */
export function MessageBubble({
  event,
  agentId,
}: {
  event: AgentEvent;
  agentId: string;
}): JSX.Element {
  const p = (event.payload ?? {}) as {
    text?: string;
    role?: 'user' | 'assistant';
    error?: boolean;
    attachments?: UploadedAttachmentRef[];
  };
  const role = p.role === 'user' ? 'user' : 'assistant';
  const rawText = p.text ?? '';
  // Phase 5 Step 5.1（plan mcp-bug-and-feature-batch-20260513 §决策 5 方案 B）：解析
  // wire prefix（cross-session teammate message 顶部 `[from X @ Y][msg Z]\n`）—— 仅 user
  // role 才可能含 prefix（teammate 收 lead send_message → adapter.receiveTeammateMessage
  // → sendMessage → emit role='user' message event）。chip + 隐藏 prefix 让用户一眼区分
  // 「自己输入」vs「跨会话注入」。
  const wirePrefix = role === 'user' ? parseWirePrefix(rawText) : null;
  const text = (wirePrefix?.body ?? rawText).trim();
  const isError = !!p.error;
  const isUser = role === 'user';
  const attachments = isUser && Array.isArray(p.attachments) ? p.attachments : null;
  const ts = new Date(event.ts).toLocaleTimeString('zh-CN', { hour12: false });
  const otherName = getAgentShortName(agentId);

  // 渲染模式：每条消息**独立**持有 mode state，互不级联（CHANGELOG_34 推翻
  // CHANGELOG_27「切单条 = 切全局」的取舍）。默认 plaintext，切换 toggle 只改本条
  // 本地 state；不再有 localStorage 持久化（CHANGELOG_35 删 render-mode.ts）。
  // 副作用：切过的 bubble 卸载（切会话 / 重启）后回到默认；这是有意为之，
  // 不引入「按 message id 持久化偏好 map」的复杂度。
  const [mode, setMode] = useState<RenderMode>(DEFAULT_RENDER_MODE);
  // REVIEW_4 M16：超长文本默认折叠
  const isLong = text.length > COLLAPSE_THRESHOLD_CHARS;
  const [expanded, setExpanded] = useState(false);

  const toggle = (): void => {
    setMode((cur) => (cur === 'markdown' ? 'plaintext' : 'markdown'));
  };

  // error 消息保留 plaintext，避免 markdown 解析掩盖错误堆栈结构
  const renderAsMarkdown = mode === 'markdown' && !isError && text.length > 0;
  // 「空消息」判定：纯文本时空; 但带附图就不算空
  const hasContent = text.length > 0 || (attachments && attachments.length > 0);

  return (
    <li className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`flex max-w-[88%] flex-col ${isUser ? 'items-end' : 'items-start'}`}>
        <div
          className={`mb-0.5 flex items-center gap-1 text-[9px] ${
            isUser ? 'text-status-working/80' : 'text-deck-muted/70'
          }`}
        >
          <span>{isUser ? '你' : otherName}</span>
          {wirePrefix && (
            // Phase 5 Step 5.1：cross-session teammate message chip。区分「自己输入」vs
            // 「另一个 SDK session 注入的 message」—— 配合 hidden wire prefix（body-only render），
            // 避免用户疑惑 "为啥 user message 里有 [from ... ] 前缀"。
            // hover title 显示完整 adapter + msgId，body 区只显示 displayName 节省横向空间。
            <span
              className="ml-0.5 inline-flex max-w-[12rem] items-center gap-0.5 truncate rounded bg-cyan-500/15 px-1 py-0.5 text-[9px] font-medium text-cyan-300"
              title={`来自 ${wirePrefix.from} @ ${wirePrefix.adapter}${
                wirePrefix.msgId ? ` · msg ${wirePrefix.msgId}` : ''
              }`}
            >
              ↩ {wirePrefix.from}
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
          {isLong && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              className="ml-1 rounded px-1 font-mono text-[9px] tracking-tight text-deck-muted/70 opacity-60 hover:bg-white/10 hover:text-deck-text hover:opacity-100"
            >
              {expanded ? '收起' : `展开 (${text.length}字)`}
            </button>
          )}
        </div>
        <div
          className={`break-words rounded-lg px-2.5 py-1.5 text-[11px] leading-relaxed ${
            renderAsMarkdown ? '' : 'whitespace-pre-wrap'
          } ${
            isLong && !expanded ? 'max-h-72 overflow-auto scrollbar-deck' : ''
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
                  alt={`attachment ${i + 1}`}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}
