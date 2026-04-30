import { useMemo, useState, type JSX } from 'react';
import type { AgentEvent } from '@shared/types';
import { DiffViewer } from '@renderer/components/diff/DiffViewer';
import { ImageThumb } from '@renderer/components/ImageThumb';
import { MarkdownText } from '@renderer/components/MarkdownText';
import { toolInputToDiff } from '@renderer/components/pending-rows';
import { describeToolInput } from '../describe';
import { formatToolResult, parseImageReadResult } from '../format';

/**
 * tool-use-start：内嵌 diff（Edit/Write/MultiEdit）/ ExitPlanMode 走特殊 plan 渲染路径
 * （hook 通道无法在此响应，必须回终端批准）。
 */
export function ToolStartRow({
  event,
  sessionId,
}: {
  event: AgentEvent;
  sessionId: string;
}): JSX.Element {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const tool = (p.toolName as string) ?? '工具';
  const detail = describeToolInput(tool, p.toolInput);
  const diff = toolInputToDiff(tool, p.toolInput);
  const ts = new Date(event.ts).toLocaleTimeString('zh-CN', { hour12: false });
  /** REVIEW_4 M17：DiffViewer (含 Monaco) 改为点击展开。多条 Edit 同窗口时几十个 Monaco 实例
   *  同时 mount 是性能与内存灾难（千 MB 级）。默认显示 file_path 占位，点「展开」才挂。 */
  const [diffOpen, setDiffOpen] = useState(false);
  /** Task 工具：subagent prompt 折叠展开。同 diffOpen 模式，避免长 prompt 撑满列表。 */
  const [taskPromptOpen, setTaskPromptOpen] = useState(false);

  // ExitPlanMode：hook 通道走这条路（外部 CLI 跑 PreToolUse 时只能拿到 tool-use-start，
  // 拿不到 canUseTool 通路 → SDK 通道不会走这里）。直接展开 plan markdown 让用户能看到内容。
  // 不带按钮（hook 通道无法响应，必须回终端批准）。
  if (tool === 'ExitPlanMode') {
    const plan =
      typeof (p.toolInput as { plan?: unknown })?.plan === 'string'
        ? (p.toolInput as { plan: string }).plan
        : '';
    return (
      <li className="rounded-md border border-status-working/30 bg-status-working/[0.06] p-2 text-[11px]">
        <div className="mb-1 flex items-center gap-1.5 text-[10px]">
          <span>📋</span>
          <span className="font-mono">ExitPlanMode</span>
          <span className="text-deck-muted/80">外部 CLI 提议执行计划</span>
          <span className="ml-auto font-mono tabular-nums text-[9px] text-deck-muted/60">{ts}</span>
        </div>
        <div className="rounded border border-deck-border/40 bg-black/20 p-2">
          <MarkdownText text={plan || '(plan 内容为空)'} />
        </div>
        <div className="mt-1.5 text-[10px] text-deck-muted">
          外部 CLI 会话无法在此批准，请回到对应终端窗口操作
        </div>
      </li>
    );
  }

  // Task：spawn subagent。当前会话起 reviewer-claude / reviewer-codex / general-purpose 等都走这条。
  // 单行摘要靠 describe.ts 的 Task case；prompt 全文较长（典型 review prompt 含 scope+focus+skip 上百行）
  // → 默认折叠，点「展开 prompt」才显示。subagent 的返回值由后续 ToolEndRow 的 ▸/▾ 展开。
  if (tool === 'Task') {
    const taskInput = (p.toolInput ?? {}) as { subagent_type?: unknown; prompt?: unknown; description?: unknown };
    const subType = typeof taskInput.subagent_type === 'string' ? taskInput.subagent_type : '';
    const taskPrompt = typeof taskInput.prompt === 'string' ? taskInput.prompt : '';
    const taskDesc = typeof taskInput.description === 'string' ? taskInput.description : '';
    const promptShort = taskPrompt.replace(/\s+/g, ' ').trim().slice(0, 80) + (taskPrompt.length > 80 ? '…' : '');
    const canExpand = taskPrompt.length > 0;
    return (
      <li className="rounded-md border border-status-working/30 bg-status-working/[0.04] p-2 text-[11px]">
        <div className="flex items-center gap-1.5">
          <span>🤖</span>
          <span className="font-mono">Task</span>
          {subType && (
            <span
              className="rounded bg-status-working/20 px-1 py-0.5 font-mono text-[9px] text-status-working"
              title={`subagent_type: ${subType}`}
            >
              → {subType}
            </span>
          )}
          {canExpand && (
            <button
              type="button"
              onClick={() => setTaskPromptOpen((v) => !v)}
              aria-expanded={taskPromptOpen}
              className="rounded bg-white/8 px-1.5 py-0.5 text-[9px] text-deck-muted hover:bg-white/15 hover:text-deck-text"
            >
              {taskPromptOpen ? '收起 prompt' : '展开 prompt'}
            </button>
          )}
          <span className="ml-auto font-mono tabular-nums text-[9px] text-deck-muted/60">{ts}</span>
        </div>
        {taskDesc && (
          <div className="mt-1 truncate text-[10px] text-deck-muted/85" title={taskDesc}>
            {taskDesc}
          </div>
        )}
        {!taskPromptOpen && promptShort && (
          <div className="mt-1 truncate text-[10px] text-deck-muted/70" title={taskPrompt}>
            {promptShort}
          </div>
        )}
        {taskPromptOpen && taskPrompt && (
          <div className="mt-1.5 max-h-96 overflow-auto scrollbar-deck rounded border border-deck-border/40 bg-black/20 p-2">
            <MarkdownText text={taskPrompt} />
          </div>
        )}
      </li>
    );
  }

  return (
    <li className="rounded-md border border-deck-border/60 bg-white/[0.02] p-2 text-[11px]">
      <div className="flex items-center gap-1.5">
        <span>🔧</span>
        <span className="font-mono">{tool}</span>
        {detail && <span className="truncate text-[10px] text-deck-muted">· {detail}</span>}
        {diff && (
          <button
            type="button"
            onClick={() => setDiffOpen((v) => !v)}
            aria-expanded={diffOpen}
            className="rounded bg-white/8 px-1.5 py-0.5 text-[9px] text-deck-muted hover:bg-white/15 hover:text-deck-text"
          >
            {diffOpen ? '收起 diff' : '展开 diff'}
          </button>
        )}
        <span className="ml-auto font-mono tabular-nums text-[9px] text-deck-muted/60">{ts}</span>
      </div>
      {diff && diffOpen && (
        <div className="mt-1 h-72 overflow-hidden rounded border border-white/5">
          <DiffViewer payload={diff} sessionId={sessionId} />
        </div>
      )}
    </li>
  );
}

/**
 * tool-use-end：result 折叠/展开（点击行头 ▸/▾）+ image-read 缩略图卡片走特殊渲染（缩略图 + 描述）。
 * 其他 image-* kinds 不需要在 ToolEndRow 显示 — 由 file-changed → ImageDiffRenderer 接管。
 */
export function ToolEndRow({
  event,
  sessionId,
}: {
  event: AgentEvent;
  sessionId: string;
}): JSX.Element {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const tool = (p.toolName as string) ?? '工具';
  const result = p.toolResult ?? p.toolResponse;
  const [open, setOpen] = useState(false);
  const ts = new Date(event.ts).toLocaleTimeString('zh-CN', { hour12: false });

  // REVIEW_4 M15：formatToolResult / parseImageReadResult 都含 JSON.stringify / JSON.parse，
  // 大结果场景下每次父级 rerender 都重做开销巨大；锁定到 [result] 引用。
  // imageRead 即便 closed 也要算（顶部需要显示「🖼 ImageRead」标题）；text 仅在 open 时才需要，
  // 不过 hasContent 判断也需要 text 长度，所以这里仍每次算（便宜的 string trim）。
  const text = useMemo(() => formatToolResult(result), [result]);
  const imageRead = useMemo(() => parseImageReadResult(result), [result]);
  const hasContent = text && text.trim().length > 0;

  return (
    <li className="rounded-md border border-deck-border/40 bg-white/[0.015] p-2 text-[11px]">
      <button
        type="button"
        onClick={() => hasContent && setOpen((v) => !v)}
        disabled={!hasContent}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 text-left disabled:cursor-default"
      >
        <span>{hasContent ? (open ? '▾' : '▸') : '·'}</span>
        <span>
          {imageRead ? '🖼 ImageRead' : tool} 完成
          {imageRead?.provider && (
            <span className="ml-1.5 text-[9px] text-deck-muted/70">
              [{imageRead.provider}
              {imageRead.model ? ` · ${imageRead.model}` : ''}]
            </span>
          )}
        </span>
        <span className="ml-auto font-mono tabular-nums text-[9px] text-deck-muted/60">{ts}</span>
      </button>
      {imageRead && (
        <div className="mt-2 flex gap-2">
          <ImageThumb
            sessionId={sessionId}
            source={{ kind: 'path', path: imageRead.file }}
            size="md"
          />
          <div className="flex-1 overflow-hidden">
            <div className="text-[9px] uppercase tracking-wider text-deck-muted">描述</div>
            <div className="mt-0.5 max-h-40 overflow-auto scrollbar-deck whitespace-pre-wrap text-[11px] text-deck-text/90">
              {imageRead.description}
            </div>
          </div>
        </div>
      )}
      {open && hasContent && (
        <pre className="mt-1 max-h-64 overflow-auto scrollbar-deck rounded bg-black/30 p-1.5 text-[10px] leading-snug text-deck-muted">
          {text}
        </pre>
      )}
    </li>
  );
}
