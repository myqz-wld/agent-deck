import { useState, type JSX } from 'react';
import type { AgentEvent, HandOffMetadata, UploadedAttachmentRef } from '@shared/types';
import {
  HAND_OFF_ADOPT_HEADER,
  HAND_OFF_SPAWN_HEADER,
} from '@shared/hand-off-headers';
import { parseWirePrefix } from '@shared/wire-prefix';
import { MarkdownText } from '@renderer/components/MarkdownText';
import { UploadedImageThumb } from '@renderer/components/UploadedImageThumb';
import { ImageLightbox } from '@renderer/components/ImageLightbox';
import { DEFAULT_RENDER_MODE, getAgentShortName, type RenderMode } from '../shared';

/** REVIEW_4 M16：超过此字符数的 message 默认折叠（max-height + 展开按钮），
 *  防止单条几十 KB 文本（罕见但 SDK 偶尔会推超长 system 提示 / 用户粘贴大段日志）
 *  把整列表撑成一面墙。阈值 800 ≈ 40-60 行普通文本，足够大多数对话不被打扰。 */
const COLLAPSE_THRESHOLD_CHARS = 800;

/**
 * CHANGELOG_100 / plan mcp-tool-simplify-20260514 B4 + plan handoff-render-and-image-batch-20260521
 * §Phase 2 Step 2.3:hand-off cold-start prompt 头部 lead context block 抽出到独立 disclosure
 * (默认收起)避免 cold-start prompt 平铺一大坨遮蔽 user 真正的 task prompt。
 *
 * **支持两种 marker**(plan §不变量 5 cross-adapter 对偶):
 * - `## Hand-off context (auto-injected by Agent Deck MCP)` — spawn 路径 lead 注入 lead context
 *   block(详 spawn.ts buildLeadContextBlock helper)
 * - `## You're the new lead — adopted teams context (auto-injected by Agent Deck MCP)` — adopt
 *   路径(hand_off_session adopt_teammates: true)装配 adoptedBlock(详 adopted-teams-context-block.ts)
 *
 * **识别条件**:marker 字面量精确匹配(2 种 HAND_OFF_HEADERS 之一)+ `\n---\n\n` 分隔符是
 * 唯一识别条件;任一不匹配 → 视为普通 message body 不抽 hand-off。注:理论上普通用户手贴
 * 这两个 marker 字面量 + 分隔符仍可能误识别,但概率极低(37+59 字符精确 marker + 后续分隔符 +
 * adopt block 的 multi-line context 段不会被简短用户输入命中)。
 *
 * **触发条件**(plan §Phase 2 Step 2.3 修订:解除 wirePrefix 前置):对所有 user message 都 try
 * parse,不再要求 wirePrefix 命中。原因:adopt 路径 cold-start prompt 是 SDK first message
 * (finalizeSessionStart emit)**无 wire prefix**,旧 wirePrefix 前置让 adopt 整个 adoptedBlock +
 * cold-start prompt 平铺一大坨 UX 缺陷。
 */
const HAND_OFF_HEADERS = [
  HAND_OFF_SPAWN_HEADER, // index 0 = spawn 路径
  HAND_OFF_ADOPT_HEADER, // index 1 = adopt 路径
] as const;
const HAND_OFF_SEPARATOR = '\n---\n\n';

type HandOffMarkerKind = 'spawn' | 'adopt';

function parseHandOffContext(body: string): {
  handOff: string | null;
  main: string;
  kind: HandOffMarkerKind | null;
} {
  for (let i = 0; i < HAND_OFF_HEADERS.length; i++) {
    const header = HAND_OFF_HEADERS[i]!;
    if (!body.startsWith(header)) continue;
    const sepIdx = body.indexOf(HAND_OFF_SEPARATOR);
    if (sepIdx < 0) continue;
    return {
      handOff: body.slice(0, sepIdx),
      main: body.slice(sepIdx + HAND_OFF_SEPARATOR.length),
      kind: i === 0 ? 'spawn' : 'adopt',
    };
  }
  return { handOff: null, main: body, kind: null };
}

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
    handOff?: HandOffMetadata;
  };
  const role = p.role === 'user' ? 'user' : 'assistant';
  const rawText = p.text ?? '';
  // Phase 5 Step 5.1（plan mcp-bug-and-feature-batch-20260513 §决策 5 方案 B）：解析
  // wire prefix（cross-session teammate message 顶部 `[from X @ Y][msg Z]\n`）—— 仅 user
  // role 才可能含 prefix（teammate 收 lead send_message → adapter.receiveTeammateMessage
  // → sendMessage → emit role='user' message event）。chip + 隐藏 prefix 让用户一眼区分
  // 「自己输入」vs「跨会话注入」。
  const wirePrefix = role === 'user' ? parseWirePrefix(rawText) : null;
  const wireBody = (wirePrefix?.body ?? rawText).trim();
  // plan handoff-render-and-image-batch-20260521 §Phase 2 Step 2.3 修订:**解除 wirePrefix 前置**,
  // 对所有 user message 都 try parse marker(spawn 路径有 wire prefix + marker;adopt 路径无 wire
  // prefix 但有 marker)。assistant message 不会有 marker(SDK 不会生成本应用专属 marker 文本)
  // → parse 返 kind=null 不影响。
  const {
    handOff: handOffContext,
    main,
    kind: handOffKind,
  } = role === 'user'
    ? parseHandOffContext(wireBody)
    : { handOff: null, main: wireBody, kind: null };
  const text = main;
  const isError = !!p.error;
  const isUser = role === 'user';
  const attachments = isUser && Array.isArray(p.attachments) ? p.attachments : null;
  // plan §Phase 2 Step 2.3 Hand-off badge:metadata 优先级链
  // 1. payload.handOff 有值 → 用 metadata.mode 作 badge 文字 + tooltip 含 planId / phaseLabel / fromCallerSid
  // 2. payload.handOff 无值 + marker 命中(向后兼容 old events / 不走本 plan plumbing 的 spawn 路径)→
  //    fallback `Hand-off · {kind}`(kind = 'spawn' | 'adopt')
  // 3. metadata 与 marker 都没命中 → 不显示 badge
  const handOffMeta = isUser ? p.handOff : undefined;
  const modeLabel = (m: string): string => (m === 'plan' ? '计划' : m === 'generic' ? '普通' : m);
  // handOffMeta 是真正的 hand_off_session metadata(plan/generic 模式) — 标「接力」。
  // handOffKind 是 parseHandOffContext 识别的 marker(spawn = spawn_session 给 teammate 注入 lead context;
  // adopt = hand_off_session adopt_teammates: true 接管 team 上下文)。
  // spawn 不是 hand_off,标「上下文」避免与「接力」语义混淆;adopt 仍属 hand_off 路径。
  const handOffBadgeLabel = handOffMeta
    ? `接力 · ${modeLabel(handOffMeta.mode)}`
    : handOffContext && handOffKind
      ? handOffKind === 'spawn'
        ? '上下文 · 派遣'
        : '接力 · 接管'
      : null;
  const handOffBadgeTooltip = handOffMeta
    ? `模式：${modeLabel(handOffMeta.mode)}${handOffMeta.planId ? ` · 计划：${handOffMeta.planId}` : ''}${
        handOffMeta.phaseLabel ? ` · 阶段：${handOffMeta.phaseLabel}` : ''
      } · 来源会话：${handOffMeta.fromCallerSid.slice(0, 8)}${
        handOffMeta.hasAdoptedBlock ? ' · 已接管团队' : ''
      }`
    : null;
  // adoptedBlock summary 文案区分(plan §Phase 2 Step 2.3):spawn 是 spawn_session 注入
  // lead context(非 hand-off),adopt 是 hand_off_session.adopt_teammates:true 真接力。
  const handOffDisclosureSummary =
    handOffKind === 'adopt'
      ? '会话接力：接管的团队和协作者（点开查看详情）'
      : '上下文：负责人提供的说明（点开查看详情）';
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
  // plan handoff-render-and-image-batch-20260521 §Phase 4 Step 4:lightbox 状态
  // (state 在 MessageBubble 内单独持有,多 bubble 互不干扰;条件 mount 规避 hook 数量变化)。
  const [lightboxPath, setLightboxPath] = useState<string | null>(null);

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
            // hover title 显示完整 adapter + msgId + senderSessionId，body 区只显示 displayName +
            // sid 8-char short hash 节省横向空间（CHANGELOG_100 B5 加 sid hash）。
            <span
              className="ml-0.5 inline-flex max-w-[16rem] items-center gap-0.5 truncate rounded bg-cyan-500/15 px-1 py-0.5 text-[9px] font-medium text-cyan-300"
              title={`来自 ${wirePrefix.from}（${wirePrefix.adapter}）`}
            >
              ↩ {wirePrefix.from}
              {wirePrefix.senderSessionId && (
                <span className="ml-0.5 font-mono text-cyan-300/70">
                  ·{wirePrefix.senderSessionId.slice(0, 8)}
                </span>
              )}
            </span>
          )}
          {handOffBadgeLabel && (
            // plan handoff-render-and-image-batch-20260521 §Phase 2 Step 2.3 Hand-off badge:
            // 与现有 wirePrefix chip 区分语义 — wirePrefix chip 表示「来自另一 SDK session 的
            // message」(送 chip);hand-off badge 表示「这是新 session 的 cold-start prompt」
            // (新 session 接力起点)。两者可同时显示(罕见:spawn 路径 lead context block + 自己
            // 也是 hand-off 起来的 session)互不冲突并排显示。配色用 cyan-500/15 与 wirePrefix
            // 同款风格保持视觉一致。
            <span
              className="ml-0.5 inline-flex max-w-[20rem] items-center gap-0.5 truncate rounded bg-cyan-500/15 px-1 py-0.5 text-[9px] font-medium text-cyan-300"
              title={handOffBadgeTooltip ?? handOffBadgeLabel}
            >
              {handOffBadgeLabel}
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
              {expanded ? '收起' : `展开（${text.length} 字）`}
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
          {handOffContext && (
            // CHANGELOG_100 B4 + plan handoff-render-and-image-batch-20260521 §Phase 2 Step 2.3:
            // hand-off cold-start prompt 头部 lead context block / adoptedBlock 抽出 disclosure
            // (默认收起)。summary 文案按 kind 区分(spawn vs adopt)。<details>/<summary> 原生折叠
            // widget,不需 React state;click summary 切展开 / 收起。pre 标签 + whitespace-pre-wrap
            // 保留 markdown 缩进与换行(lead context 含 code fence 与列表)。
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
      {/* plan handoff-render-and-image-batch-20260521 §Phase 4 Step 4:条件 mount lightbox
          规避 hook 数量变化 — lightboxPath==null 时整个组件不存在,非 null 时挂载+调 useImageBlob。
          R1 reviewer-claude LOW-2 修法:ImageLightbox 删 `open` prop,caller 通过条件 mount
          (`{lightboxPath && <ImageLightbox ... />}`)控制可见性。*/}
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
