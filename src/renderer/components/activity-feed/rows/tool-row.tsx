import { useMemo, useState, type JSX, type KeyboardEvent, type MouseEvent } from 'react';
import type { AgentEvent } from '@shared/types';
import { DiffViewer } from '@renderer/components/diff/DiffViewer';
import { ImageThumb } from '@renderer/components/ImageThumb';
import { MarkdownText } from '@renderer/components/MarkdownText';
import { toolInputToDiff } from '@renderer/components/pending-rows';
import { describeToolInput } from '../describe';
import { formatDisplayText, formatToolInput, formatToolResult, parseImageReadResult } from '../format';
import { toolIcon } from '../tool-icons';

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
  const tool = formatDisplayText(p.toolName) || '工具';
  const detail = describeToolInput(tool, p.toolInput);
  const diff = toolInputToDiff(tool, p.toolInput);
  const ts = new Date(event.ts).toLocaleTimeString('zh-CN', { hour12: false });
  const hasInput = p.toolInput !== undefined;
  const [inputOpen, setInputOpen] = useState(false);
  /** REVIEW_4 M17：DiffViewer (含 Monaco) 改为点击展开。多条 Edit 同窗口时几十个 Monaco 实例
   *  同时 mount 是性能与内存灾难（千 MB 级）。默认显示 file_path 占位，点「展开」才挂。 */
  const [diffOpen, setDiffOpen] = useState(false);
  /** Task 工具：subagent prompt 折叠展开。同 diffOpen 模式，避免长 prompt 撑满列表。 */
  const [taskPromptOpen, setTaskPromptOpen] = useState(false);
  const toggleInput = (): void => {
    if (!hasInput) return;
    setInputOpen((v) => !v);
  };
  const handleInputHeaderClick = (clickEvent: MouseEvent<HTMLElement>): void => {
    if (isNestedInteractiveTarget(clickEvent.target)) return;
    toggleInput();
  };
  const handleInputHeaderKeyDown = (keyEvent: KeyboardEvent<HTMLElement>): void => {
    if (isNestedInteractiveTarget(keyEvent.target)) return;
    if (keyEvent.key !== 'Enter' && keyEvent.key !== ' ') return;
    keyEvent.preventDefault();
    toggleInput();
  };

  // ExitPlanMode：hook 通道走这条路（外部 CLI 跑 PreToolUse 时只能拿到 tool-use-start，
  // 拿不到 canUseTool 通路 → SDK 通道不会走这里）。直接展开 plan markdown 让用户能看到内容。
  // 不带按钮（hook 通道无法响应，必须回终端批准）。
  if (tool === 'ExitPlanMode') {
    const plan =
      typeof (p.toolInput as { plan?: unknown })?.plan === 'string'
        ? (p.toolInput as { plan: string }).plan
        : '';
    return (
      <li className="min-w-0 rounded-md border border-status-working/30 bg-status-working/[0.06] p-2 text-[11px]">
        <div
          role={hasInput ? 'button' : undefined}
          tabIndex={hasInput ? 0 : undefined}
          aria-expanded={hasInput ? inputOpen : undefined}
          onClick={handleInputHeaderClick}
          onKeyDown={handleInputHeaderKeyDown}
          className={`mb-1 flex min-w-0 items-center gap-1.5 text-[10px] ${hasInput ? 'cursor-pointer rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-status-working/60' : ''}`}
        >
          {hasInput && <span className="text-deck-muted/70">{inputOpen ? '▾' : '▸'}</span>}
          <span>{toolIcon('ExitPlanMode')}</span>
          <span className="font-mono">ExitPlanMode</span>
          <span className="text-deck-muted/80">收到一个执行计划</span>
          <span className="ml-auto font-mono tabular-nums text-[9px] text-deck-muted/60">{ts}</span>
        </div>
        <div className="rounded border border-deck-border/40 bg-black/20 p-2">
          <MarkdownText text={plan || '（计划内容为空）'} />
        </div>
        <ToolInputBlock input={p.toolInput} open={inputOpen} />
        <div className="mt-1.5 text-[10px] text-deck-muted">
          这是终端启动的只读会话，请回到原终端窗口批准
        </div>
      </li>
    );
  }

  // Task / Agent：spawn subagent 或执行 Codex collaboration 操作。
  // 单行摘要靠 describe.ts 的 Task case；prompt 全文较长（典型 review prompt 含 scope+focus+skip 上百行）
  // → 默认折叠，点「展开 prompt」才显示。subagent 的返回值由后续 ToolEndRow 的 ▸/▾ 展开。
  if (tool === 'Task' || tool === 'Agent') {
    const taskInput = (p.toolInput ?? {}) as {
      subagent_type?: unknown;
      prompt?: unknown;
      description?: unknown;
      collab_tool?: unknown;
      model?: unknown;
      reasoning_effort?: unknown;
      model_reasoning_effort?: unknown;
      receiver_thread_ids?: unknown;
      task_name?: unknown;
      agent_type?: unknown;
      target?: unknown;
      id?: unknown;
      targets?: unknown;
      timeout_ms?: unknown;
      fork_turns?: unknown;
      fork_context?: unknown;
      service_tier?: unknown;
      path_prefix?: unknown;
      interrupt?: unknown;
    };
    const subType = typeof taskInput.subagent_type === 'string' ? taskInput.subagent_type : '';
    const taskPrompt = typeof taskInput.prompt === 'string' ? taskInput.prompt : '';
    const taskDesc = typeof taskInput.description === 'string' ? taskInput.description : '';
    const collabTool = typeof taskInput.collab_tool === 'string' ? taskInput.collab_tool : '';
    const model = typeof taskInput.model === 'string' ? taskInput.model : '';
    const reasoningEffort =
      typeof taskInput.reasoning_effort === 'string'
        ? taskInput.reasoning_effort
        : typeof taskInput.model_reasoning_effort === 'string'
          ? taskInput.model_reasoning_effort
          : '';
    const receiverThreadIds = Array.isArray(taskInput.receiver_thread_ids)
      ? taskInput.receiver_thread_ids.filter((value): value is string => typeof value === 'string')
      : [];
    const taskName = typeof taskInput.task_name === 'string' ? taskInput.task_name : '';
    const agentType = typeof taskInput.agent_type === 'string' ? taskInput.agent_type : '';
    const target =
      typeof taskInput.target === 'string'
        ? taskInput.target
        : typeof taskInput.id === 'string'
          ? taskInput.id
          : '';
    const rawTargets = Array.isArray(taskInput.targets)
      ? taskInput.targets.filter((value): value is string => typeof value === 'string')
      : [];
    const timeoutMs =
      typeof taskInput.timeout_ms === 'number' && Number.isFinite(taskInput.timeout_ms)
        ? taskInput.timeout_ms
        : null;
    const timeoutText =
      timeoutMs === null
        ? ''
        : timeoutMs >= 1000 && timeoutMs % 1000 === 0
          ? `${timeoutMs / 1000} 秒`
          : `${timeoutMs} 毫秒`;
    const forkTurns = typeof taskInput.fork_turns === 'string' ? taskInput.fork_turns : '';
    const forkContext = typeof taskInput.fork_context === 'boolean' ? taskInput.fork_context : null;
    const forkText = forkTurns
      ? `fork_turns=${forkTurns}`
      : forkContext === null
        ? ''
        : forkContext
          ? '继承上下文'
          : '不继承上下文';
    const serviceTier = typeof taskInput.service_tier === 'string' ? taskInput.service_tier : '';
    const pathPrefix = typeof taskInput.path_prefix === 'string' ? taskInput.path_prefix : '';
    const interruptsTarget = taskInput.interrupt === true;
    const targetCount = receiverThreadIds.length || rawTargets.length;
    const targetIds = receiverThreadIds.length > 0 ? receiverThreadIds : rawTargets;
    const promptShort = taskPrompt.replace(/\s+/g, ' ').trim().slice(0, 80) + (taskPrompt.length > 80 ? '…' : '');
    const canExpand = taskPrompt.length > 0;
    return (
      <li className="min-w-0 rounded-md border border-status-working/30 bg-status-working/[0.04] p-2 text-[11px]">
        <div
          role={hasInput ? 'button' : undefined}
          tabIndex={hasInput ? 0 : undefined}
          aria-expanded={hasInput ? inputOpen : undefined}
          onClick={handleInputHeaderClick}
          onKeyDown={handleInputHeaderKeyDown}
          className={`flex min-w-0 items-center gap-1.5 ${hasInput ? 'cursor-pointer rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-status-working/60' : ''}`}
        >
          {hasInput && <span className="text-deck-muted/70">{inputOpen ? '▾' : '▸'}</span>}
          <span>{toolIcon(tool)}</span>
          <span className="font-mono">{tool}</span>
          {subType && (
            <span
              className="min-w-0 truncate rounded bg-status-working/20 px-1 py-0.5 font-mono text-[9px] text-status-working"
              title={`subagent_type: ${subType}`}
            >
              → {subType}
            </span>
          )}
          {(taskName || agentType) && (
            <span
              className="min-w-0 truncate rounded bg-status-working/20 px-1 py-0.5 font-mono text-[9px] text-status-working"
              title={taskName ? `task_name: ${taskName}` : `agent_type: ${agentType}`}
            >
              {taskName ? `任务 ${taskName}` : `类型 ${agentType}`}
            </span>
          )}
          {target && (
            <span
              className="min-w-0 truncate rounded bg-status-working/20 px-1 py-0.5 font-mono text-[9px] text-status-working"
              title={`target/id: ${target}`}
            >
              → {target}
            </span>
          )}
          {collabTool && (
            <span
              className="rounded bg-white/8 px-1 py-0.5 font-mono text-[9px] text-deck-muted"
              title={`collab_tool: ${collabTool}`}
            >
              {collabTool}
            </span>
          )}
          {(model || reasoningEffort) && (
            <span
              className="min-w-0 truncate rounded bg-white/8 px-1 py-0.5 font-mono text-[9px] text-deck-muted"
              title={`model: ${model || 'default'}; reasoning_effort: ${reasoningEffort || 'default'}`}
            >
              {model || '默认模型'}{reasoningEffort ? ` · ${reasoningEffort}` : ''}
            </span>
          )}
          {targetCount > 0 && (
            <span
              className="rounded bg-white/8 px-1 py-0.5 font-mono text-[9px] text-deck-muted"
              title={`targets: ${targetIds.join(', ')}`}
            >
              {targetCount} 个目标
            </span>
          )}
          {forkText && (
            <span
              className="rounded bg-white/8 px-1 py-0.5 font-mono text-[9px] text-deck-muted"
              title={forkTurns ? `fork_turns: ${forkTurns}` : `fork_context: ${forkContext}`}
            >
              {forkText}
            </span>
          )}
          {serviceTier && (
            <span
              className="rounded bg-white/8 px-1 py-0.5 font-mono text-[9px] text-deck-muted"
              title={`service_tier: ${serviceTier}`}
            >
              service_tier={serviceTier}
            </span>
          )}
          {pathPrefix && (
            <span
              className="min-w-0 truncate rounded bg-white/8 px-1 py-0.5 font-mono text-[9px] text-deck-muted"
              title={`path_prefix: ${pathPrefix}`}
            >
              范围 {pathPrefix}
            </span>
          )}
          {interruptsTarget && (
            <span className="rounded bg-white/8 px-1 py-0.5 text-[9px] text-deck-muted" title="interrupt: true">
              先中断
            </span>
          )}
          {timeoutText && (
            <span
              className="rounded bg-white/8 px-1 py-0.5 font-mono text-[9px] text-deck-muted"
              title={`timeout_ms: ${timeoutMs}`}
            >
              超时 {timeoutText}
            </span>
          )}
          {canExpand && (
            <button
              type="button"
              onClick={() => setTaskPromptOpen((v) => !v)}
              aria-expanded={taskPromptOpen}
              className="rounded bg-white/8 px-1.5 py-0.5 text-[9px] text-deck-muted hover:bg-white/15 hover:text-deck-text"
            >
              {taskPromptOpen ? '收起指令' : '查看指令'}
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
        <ToolInputBlock input={p.toolInput} open={inputOpen} />
      </li>
    );
  }

  return (
    <li className="min-w-0 rounded-md border border-deck-border/60 bg-white/[0.02] p-2 text-[11px]">
      <div
        role={hasInput ? 'button' : undefined}
        tabIndex={hasInput ? 0 : undefined}
        aria-expanded={hasInput ? inputOpen : undefined}
        onClick={handleInputHeaderClick}
        onKeyDown={handleInputHeaderKeyDown}
        className={`flex min-w-0 items-center gap-1.5 ${hasInput ? 'cursor-pointer rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-deck-accent/60' : ''}`}
      >
        {hasInput && <span className="text-deck-muted/70">{inputOpen ? '▾' : '▸'}</span>}
        <span>{toolIcon(tool)}</span>
        <span className="min-w-0 truncate font-mono">{tool}</span>
        {detail && <span className="truncate text-[10px] text-deck-muted">· {detail}</span>}
        {diff && (
          <button
            type="button"
            onClick={() => setDiffOpen((v) => !v)}
            aria-expanded={diffOpen}
            className="rounded bg-white/8 px-1.5 py-0.5 text-[9px] text-deck-muted hover:bg-white/15 hover:text-deck-text"
          >
            {diffOpen ? '收起改动' : '查看改动'}
          </button>
        )}
        <span className="ml-auto font-mono tabular-nums text-[9px] text-deck-muted/60">{ts}</span>
      </div>
      <ToolInputBlock input={p.toolInput} open={inputOpen} />
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
 *
 * `startEvent` 是同 toolUseId 的 tool-use-start 事件（由 ActivityFeed 反查传入）。
 * tool-use-end payload 不带 toolInput，所以 detail（如「✨ Skill 完成 · agent-deck:deep-code-review」）
 * 必须从 startEvent.toolInput 反查；同时 startEvent.toolName 也作为 toolName 兜底（覆盖修 toolName
 * 漏传 bug 之前持久化的老 events，只要前一条 start 还在 RECENT_LIMIT 窗口里）。
 */
export function ToolEndRow({
  event,
  sessionId,
  startEvent,
}: {
  event: AgentEvent;
  sessionId: string;
  startEvent?: AgentEvent;
}): JSX.Element {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const startPayload = (startEvent?.payload ?? {}) as Record<string, unknown>;
  const tool =
    formatDisplayText(p.toolName) || formatDisplayText(startPayload.toolName) || '工具';
  const result = p.toolResult ?? p.toolResponse;
  const [open, setOpen] = useState(false);
  const ts = new Date(event.ts).toLocaleTimeString('zh-CN', { hour12: false });

  // CHANGELOG_<X> A1：跨 adapter 统一 status 显示。
  // - codex translate.ts:119 emit status: i.status (completed / failed)
  // - claude sdk-message-translate.ts:118 emit status: block.is_error ? failed : completed
  // 兜底：缺 status 字段视作成功（老事件 / 老 hook）；exitCode != 0 也视为 failed（codex Bash）
  const isFailed =
    p.status === 'failed' ||
    p.error != null ||
    (typeof p.exitCode === 'number' && p.exitCode !== 0);

  // REVIEW_4 M15：formatToolResult / parseImageReadResult 都含 JSON.stringify / JSON.parse，
  // 大结果场景下每次父级 rerender 都重做开销巨大；锁定到 [result] 引用。
  // imageRead 即便 closed 也要算（顶部需要显示「🖼 ImageRead」标题）；text 仅在 open 时才需要，
  // 不过 hasContent 判断也需要 text 长度，所以这里仍每次算（便宜的 string trim）。
  const text = useMemo(() => formatToolResult(result), [result]);
  const imageRead = useMemo(() => parseImageReadResult(result), [result]);
  const hasContent = text && text.trim().length > 0;
  const statusText = toolStatusText(p.status);
  const inputForDisplay = mergeToolInputs(startPayload.toolInput, p.toolInput);
  // 借 start 事件的 toolInput 拼 detail —— 让「✨ Skill 完成」补回「· agent-deck:deep-code-review」。
  // imageRead 自己带 [provider · model] 后缀就不再叠 detail，避免一行三段信息太挤。
  const detail = useMemo(
    () => (imageRead ? null : describeToolInput(tool, inputForDisplay)),
    [tool, inputForDisplay, imageRead],
  );

  // 失败：红色边框 + 浅红背景，与 status-error 色对齐（与 SessionDetail 错误消息同色）
  const containerClass = isFailed
    ? 'min-w-0 rounded-md border border-status-error/40 bg-status-error/[0.05] p-2 text-[11px]'
    : 'min-w-0 rounded-md border border-deck-border/40 bg-white/[0.015] p-2 text-[11px]';

  return (
    <li className={containerClass}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex min-w-0 w-full items-center gap-1.5 text-left"
      >
        <span>{open ? '▾' : '▸'}</span>
        <span className="min-w-0 truncate">
          {imageRead ? '🖼 ImageRead' : `${toolIcon(tool)} ${tool}`}{' '}
          {isFailed ? (
            <span className="text-status-error/90">失败</span>
          ) : (
            '完成'
          )}
          {imageRead?.provider && (
            <span className="ml-1.5 text-[9px] text-deck-muted/70">
              [{imageRead.provider}
              {imageRead.model ? ` · ${imageRead.model}` : ''}]
            </span>
          )}
          {detail && (
            <span className="ml-1.5 truncate text-[10px] text-deck-muted/85">
              · {detail}
            </span>
          )}
          {isFailed && typeof p.exitCode === 'number' && (
            <span className="ml-1.5 rounded bg-status-error/20 px-1 py-0.5 font-mono text-[9px] text-status-error/90">
              退出码 {String(p.exitCode)}
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
      {/* REVIEW_52 B1：移除 disabled={!hasContent}，总是允许 ▸/▾ 展开。
         空结果展开（codex 无 stdout 命令 mkdir/cd / mcp_tool_call 返 [] / null）显示
         status / exitCode 元信息，避免「点不动 + 没解释」UX 卡住感。imageRead 由
         上面 mt-2 分支独立渲染，本块仅文本结果路径。*/}
      {open && !imageRead && (hasContent ? (
        <pre className="mt-1 max-h-64 overflow-auto scrollbar-deck rounded bg-black/30 p-1.5 text-[10px] leading-snug text-deck-muted">
          {text}
        </pre>
      ) : (
        <div className="mt-1 px-1.5 py-1 text-[10px] italic text-deck-muted/70">
          （无输出
          {statusText && ` · 状态：${statusText}`}
          {typeof p.exitCode === 'number' && ` · 退出码: ${p.exitCode}`}
          ）
        </div>
      ))}
    </li>
  );
}

function ToolInputBlock({ input, open }: { input: unknown; open: boolean }): JSX.Element | null {
  if (input === undefined || !open) return null;
  return (
    <pre className="mt-1.5 max-h-64 overflow-auto scrollbar-deck rounded bg-black/30 p-1.5 text-[10px] leading-snug text-deck-muted">
      {formatToolInput(input)}
    </pre>
  );
}

function mergeToolInputs(startInput: unknown, endInput: unknown): unknown {
  const start = objectRecord(startInput);
  const end = objectRecord(endInput);
  if (!start || !end) return endInput ?? startInput;
  const merged: Record<string, unknown> = { ...start };
  for (const [key, value] of Object.entries(end)) {
    if (value !== null && value !== undefined) merged[key] = value;
    else if (!(key in merged)) merged[key] = value;
  }
  return merged;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isNestedInteractiveTarget(target: EventTarget): boolean {
  return target instanceof Element && target.closest('button,a,input,textarea,select') !== null;
}

function toolStatusText(status: unknown): string | null {
  if (status === 'completed' || status == null) return null;
  switch (status) {
    case 'failed':
      return '失败';
    case 'cancelled':
      return '已取消';
    case 'error':
      return '出错';
    case 'inProgress':
    case 'in_progress':
    case 'running':
      return '执行中';
    default:
      return typeof status === 'string' ? '状态未知' : null;
  }
}
