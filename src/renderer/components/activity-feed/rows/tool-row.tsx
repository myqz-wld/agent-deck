import {
  useMemo,
  useState,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import type { AgentEvent } from '@shared/types';
import { DiffViewer } from '@renderer/components/diff/DiffViewer';
import { ImageThumb } from '@renderer/components/ImageThumb';
import { MarkdownText } from '@renderer/components/MarkdownText';
import { toolInputToDiff } from '@renderer/components/pending-rows';
import { describeToolInput } from '../describe';
import {
  formatDisplayText,
  formatToolInput,
  formatToolResult,
  parseImageReadResult,
} from '../format';
import { toolIcon } from '../tool-icons';
import {
  formatToolDuration,
  providerTruncationLabel,
  toolStatusView,
} from '../tool-status';
import { ChevronDownIcon, ChevronRightIcon, ImageIcon } from '../../icons';

export function ToolStartRow({
  event,
  sessionId,
}: {
  event: AgentEvent;
  sessionId: string;
}): JSX.Element {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const tool = formatDisplayText(payload.toolName) || '工具';
  const detail = describeToolInput(tool, payload.toolInput);
  const diff = toolInputToDiff(tool, payload.toolInput);
  const timestamp = new Date(event.ts).toLocaleTimeString('zh-CN', { hour12: false });
  const hasInput = payload.toolInput !== undefined;
  const [inputOpen, setInputOpen] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const [taskPromptOpen, setTaskPromptOpen] = useState(false);

  const toggleInput = (): void => {
    if (hasInput) setInputOpen((value) => !value);
  };
  const handleInputHeaderClick = (event: MouseEvent<HTMLElement>): void => {
    if (!isNestedInteractiveTarget(event.target)) toggleInput();
  };
  const handleInputHeaderKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (isNestedInteractiveTarget(event.target)) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    toggleInput();
  };

  if (tool === 'ExitPlanMode') {
    const plan =
      typeof (payload.toolInput as { plan?: unknown })?.plan === 'string'
        ? (payload.toolInput as { plan: string }).plan
        : '';
    return (
      <li className="min-w-0 rounded-md border border-status-working/30 bg-status-working/[0.06] p-2 text-[11px]">
        <div
          role={hasInput ? 'button' : undefined}
          tabIndex={hasInput ? 0 : undefined}
          aria-expanded={hasInput ? inputOpen : undefined}
          onClick={handleInputHeaderClick}
          onKeyDown={handleInputHeaderKeyDown}
          className={`mb-1 flex min-w-0 items-center gap-1.5 text-[10px] ${
            hasInput
              ? 'cursor-pointer rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-status-working/60'
              : ''
          }`}
        >
          {hasInput && (
            <span className="text-deck-muted/70">
              {inputOpen
                ? <ChevronDownIcon className="h-3 w-3" />
                : <ChevronRightIcon className="h-3 w-3" />}
            </span>
          )}
          <span>{toolIcon('ExitPlanMode')}</span>
          <span className="font-mono">ExitPlanMode</span>
          <span className="text-deck-muted/80">收到一个执行计划</span>
          <span className="ml-auto font-mono text-[9px] tabular-nums text-deck-muted/60">
            {timestamp}
          </span>
        </div>
        <div className="rounded border border-deck-border/40 bg-black/20 p-2">
          <MarkdownText text={plan || '（计划内容为空）'} />
        </div>
        <ToolInputBlock input={payload.toolInput} open={inputOpen} />
        <div className="mt-1.5 text-[10px] text-deck-muted">
          这是终端启动的只读会话，请回到原终端窗口批准
        </div>
      </li>
    );
  }

  if (tool === 'Task' || tool === 'Agent') {
    const taskInput = (payload.toolInput ?? {}) as {
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
    const subType =
      typeof taskInput.subagent_type === 'string' ? taskInput.subagent_type : '';
    const taskPrompt = typeof taskInput.prompt === 'string' ? taskInput.prompt : '';
    const taskDescription =
      typeof taskInput.description === 'string' ? taskInput.description : '';
    const collabTool =
      typeof taskInput.collab_tool === 'string' ? taskInput.collab_tool : '';
    const model = typeof taskInput.model === 'string' ? taskInput.model : '';
    const reasoningEffort =
      typeof taskInput.reasoning_effort === 'string'
        ? taskInput.reasoning_effort
        : typeof taskInput.model_reasoning_effort === 'string'
          ? taskInput.model_reasoning_effort
          : '';
    const receiverThreadIds = Array.isArray(taskInput.receiver_thread_ids)
      ? taskInput.receiver_thread_ids.filter(
        (value): value is string => typeof value === 'string',
      )
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
    const forkTurns =
      typeof taskInput.fork_turns === 'string' ? taskInput.fork_turns : '';
    const forkContext =
      typeof taskInput.fork_context === 'boolean' ? taskInput.fork_context : null;
    const forkText = forkTurns
      ? `fork_turns=${forkTurns}`
      : forkContext === null
        ? ''
        : forkContext
          ? '继承上下文'
          : '不继承上下文';
    const serviceTier =
      typeof taskInput.service_tier === 'string' ? taskInput.service_tier : '';
    const pathPrefix =
      typeof taskInput.path_prefix === 'string' ? taskInput.path_prefix : '';
    const interruptsTarget = taskInput.interrupt === true;
    const targetCount = receiverThreadIds.length || rawTargets.length;
    const targetIds = receiverThreadIds.length > 0 ? receiverThreadIds : rawTargets;
    const normalizedPrompt = taskPrompt.replace(/\s+/g, ' ').trim();
    const promptShort =
      normalizedPrompt.slice(0, 80) + (normalizedPrompt.length > 80 ? '…' : '');
    const canExpand = taskPrompt.length > 0;

    return (
      <li className="min-w-0 rounded-md border border-status-working/30 bg-status-working/[0.04] p-2 text-[11px]">
        <div
          role={hasInput ? 'button' : undefined}
          tabIndex={hasInput ? 0 : undefined}
          aria-expanded={hasInput ? inputOpen : undefined}
          onClick={handleInputHeaderClick}
          onKeyDown={handleInputHeaderKeyDown}
          className={`flex min-w-0 items-center gap-1.5 ${
            hasInput
              ? 'cursor-pointer rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-status-working/60'
              : ''
          }`}
        >
          {hasInput && (
            <span className="text-deck-muted/70">
              {inputOpen
                ? <ChevronDownIcon className="h-3 w-3" />
                : <ChevronRightIcon className="h-3 w-3" />}
            </span>
          )}
          <span>{toolIcon(tool, payload.toolKind)}</span>
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
            <span
              className="rounded bg-white/8 px-1 py-0.5 text-[9px] text-deck-muted"
              title="interrupt: true"
            >
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
              onClick={() => setTaskPromptOpen((value) => !value)}
              aria-expanded={taskPromptOpen}
              className="rounded bg-white/8 px-1.5 py-0.5 text-[9px] text-deck-muted hover:bg-white/15 hover:text-deck-text"
            >
              {taskPromptOpen
                ? <ChevronDownIcon className="mr-0.5 inline h-3 w-3" />
                : <ChevronRightIcon className="mr-0.5 inline h-3 w-3" />}
              {taskPromptOpen ? '收起指令' : '查看指令'}
            </button>
          )}
          <span className="ml-auto font-mono text-[9px] tabular-nums text-deck-muted/60">
            {timestamp}
          </span>
        </div>
        {taskDescription && (
          <div className="mt-1 truncate text-[10px] text-deck-muted/85" title={taskDescription}>
            {taskDescription}
          </div>
        )}
        {!taskPromptOpen && promptShort && (
          <div className="mt-1 truncate text-[10px] text-deck-muted/70" title={taskPrompt}>
            {promptShort}
          </div>
        )}
        {taskPromptOpen && taskPrompt && (
          <div className="mt-1.5 max-h-96 overflow-auto rounded border border-deck-border/40 bg-black/20 p-2 scrollbar-deck">
            <MarkdownText text={taskPrompt} />
          </div>
        )}
        <ToolInputBlock input={payload.toolInput} open={inputOpen} />
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
        className={`flex min-w-0 items-center gap-1.5 ${
          hasInput
            ? 'cursor-pointer rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-deck-accent/60'
            : ''
        }`}
      >
        {hasInput && (
          <span className="text-deck-muted/70">
            {inputOpen
              ? <ChevronDownIcon className="h-3 w-3" />
              : <ChevronRightIcon className="h-3 w-3" />}
          </span>
        )}
        <span>{toolIcon(tool, payload.toolKind)}</span>
        <span className="min-w-0 truncate font-mono">{tool}</span>
        {detail && <span className="truncate text-[10px] text-deck-muted">· {detail}</span>}
        {diff && (
          <button
            type="button"
            onClick={() => setDiffOpen((value) => !value)}
            aria-expanded={diffOpen}
            className="rounded bg-white/8 px-1.5 py-0.5 text-[9px] text-deck-muted hover:bg-white/15 hover:text-deck-text"
          >
            {diffOpen
              ? <ChevronDownIcon className="mr-0.5 inline h-3 w-3" />
              : <ChevronRightIcon className="mr-0.5 inline h-3 w-3" />}
            {diffOpen ? '收起改动' : '查看改动'}
          </button>
        )}
        <span className="ml-auto font-mono text-[9px] tabular-nums text-deck-muted/60">
          {timestamp}
        </span>
      </div>
      <ToolInputBlock input={payload.toolInput} open={inputOpen} />
      {diff && diffOpen && (
        <div className="mt-1 h-72 overflow-hidden rounded border border-white/5">
          <DiffViewer payload={diff} sessionId={sessionId} />
        </div>
      )}
    </li>
  );
}

export function ToolEndRow({
  event,
  sessionId,
  startEvent,
}: {
  event: AgentEvent;
  sessionId: string;
  startEvent?: AgentEvent;
}): JSX.Element {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const startPayload = (startEvent?.payload ?? {}) as Record<string, unknown>;
  const tool =
    formatDisplayText(payload.toolName)
    || formatDisplayText(startPayload.toolName)
    || '工具';
  const result =
    payload.toolResult
    ?? payload.toolResponse
    ?? payload.error
    ?? payload.reason;
  const [open, setOpen] = useState(false);
  const timestamp = new Date(event.ts).toLocaleTimeString('zh-CN', { hour12: false });
  const status = toolStatusView(payload);
  const duration = formatToolDuration(payload.durationMs);
  const truncation = providerTruncationLabel(payload);
  const text = useMemo(() => formatToolResult(result), [result]);
  const imageRead = useMemo(() => parseImageReadResult(result), [result]);
  const hasContent = text.trim().length > 0;
  const inputForDisplay = mergeToolInputs(startPayload.toolInput, payload.toolInput);
  const detail = useMemo(
    () => imageRead ? null : describeToolInput(tool, inputForDisplay),
    [imageRead, inputForDisplay, tool],
  );
  const containerClass = status.isError
    ? 'min-w-0 rounded-md border border-status-error/40 bg-status-error/[0.05] p-2 text-[11px]'
    : 'min-w-0 rounded-md border border-deck-border/40 bg-white/[0.015] p-2 text-[11px]';

  return (
    <li className={containerClass}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-1.5 text-left"
      >
        <span>
          {open
            ? <ChevronDownIcon className="h-3 w-3" />
            : <ChevronRightIcon className="h-3 w-3" />}
        </span>
        <span className="min-w-0 truncate">
          {imageRead
            ? <><ImageIcon className="mr-1 inline h-3 w-3" />ImageRead</>
            : `${toolIcon(tool, payload.toolKind ?? startPayload.toolKind)} ${tool}`}{' '}
          {status.isError ? (
            <span className="text-status-error/90">{status.label}</span>
          ) : status.label}
          {imageRead?.provider && (
            <span className="ml-1.5 text-[9px] text-deck-muted/70">
              [{imageRead.provider}{imageRead.model ? ` · ${imageRead.model}` : ''}]
            </span>
          )}
          {detail && (
            <span className="ml-1.5 truncate text-[10px] text-deck-muted/85">
              · {detail}
            </span>
          )}
          {status.isError && typeof payload.exitCode === 'number' && (
            <span className="ml-1.5 rounded bg-status-error/20 px-1 py-0.5 font-mono text-[9px] text-status-error/90">
              退出码 {String(payload.exitCode)}
            </span>
          )}
          {duration && (
            <span className="ml-1.5 text-[9px] text-deck-muted/70">{duration}</span>
          )}
          {truncation && (
            <span className="ml-1.5 text-[9px] text-amber-300/90">{truncation}</span>
          )}
        </span>
        <span className="ml-auto font-mono text-[9px] tabular-nums text-deck-muted/60">
          {timestamp}
        </span>
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
            <div className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap text-[11px] text-deck-text/90 scrollbar-deck">
              {imageRead.description}
            </div>
          </div>
        </div>
      )}
      {open && !imageRead && (
        hasContent ? (
          <pre className="mt-1 max-h-64 overflow-auto rounded bg-black/30 p-1.5 text-[10px] leading-snug text-deck-muted scrollbar-deck">
            {text}
          </pre>
        ) : (
          <div className="mt-1 px-1.5 py-1 text-[10px] italic text-deck-muted/70">
            （无输出
            {status.detail && ` · 状态：${status.detail}`}
            {typeof payload.exitCode === 'number' && ` · 退出码: ${payload.exitCode}`}
            ）
          </div>
        )
      )}
    </li>
  );
}

function ToolInputBlock({
  input,
  open,
}: {
  input: unknown;
  open: boolean;
}): JSX.Element | null {
  if (input === undefined || !open) return null;
  return (
    <pre className="mt-1.5 max-h-64 overflow-auto rounded bg-black/30 p-1.5 text-[10px] leading-snug text-deck-muted scrollbar-deck">
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
    ? value as Record<string, unknown>
    : null;
}

function isNestedInteractiveTarget(target: EventTarget): boolean {
  return target instanceof Element
    && target.closest('button,a,input,textarea,select') !== null;
}
