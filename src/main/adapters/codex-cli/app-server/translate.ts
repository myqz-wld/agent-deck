import type { CodexAppServerNotification } from './client';
import { APPEND_AGGREGATED_OUTPUT } from '@shared/agent-event-merge';
import {
  classifyStreamErrorEvent,
  extractRetryProgress,
} from '../stream-error-classifier';
import type { AgentEventKind } from '@shared/types';
import {
  isEffectiveCodexFileChange,
  isIncompleteCodexFileChangeStatus,
} from '@shared/codex-file-change';
import log from '@main/utils/logger';

const logger = log.scope('codex-app-server-translate');
const GENERIC_SKILL_TOOL_NAMES = new Set(['skill', 'invoke', 'invoke_skill', 'skill.invoke']);

type AnyRecord = Record<string, unknown>;
type EmitFn = (kind: AgentEventKind, payload: unknown) => void;

export interface CodexAppServerTranslateState {
  reasoningSummaryByItemId: Map<string, string[]>;
}

export function createCodexAppServerTranslateState(): CodexAppServerTranslateState {
  return { reasoningSummaryByItemId: new Map() };
}

export function translateCodexAppServerNotification(
  notification: CodexAppServerNotification,
  emit: EmitFn,
  opts?: { model?: string | null; state?: CodexAppServerTranslateState },
): void {
  switch (notification.method) {
    case 'thread/started':
    case 'thread/status/changed':
    case 'turn/started':
    case 'item/agentMessage/delta':
    case 'item/reasoning/textDelta':
    case 'item/plan/delta':
    case 'turn/diff/updated':
    case 'turn/plan/updated':
      return;

    case 'item/reasoning/summaryTextDelta': {
      trackReasoningSummaryDelta(notification.params, opts?.state);
      return;
    }

    case 'thread/tokenUsage/updated': {
      translateTokenUsage(notification.params, emit, opts);
      return;
    }

    case 'turn/completed': {
      translateTurnCompleted(notification.params, emit);
      return;
    }

    case 'error': {
      translateErrorNotification(notification.params, emit);
      return;
    }

    case 'item/started': {
      const item = getItem(notification.params);
      if (item) translateItemStarted(item, emit);
      return;
    }

    case 'item/completed': {
      const item = getItem(notification.params);
      if (item) translateItemCompleted(item, emit, opts?.state);
      return;
    }

    case 'item/commandExecution/outputDelta': {
      translateCommandOutputDelta(notification.params, emit);
      return;
    }

    case 'item/mcpToolCall/progress':
    case 'serverRequest/resolved':
    case 'rawResponseItem/completed':
    case 'warning':
    case 'guardianWarning':
    case 'configWarning':
    case 'deprecationNotice':
      return;
  }
}

function translateTurnCompleted(params: unknown, emit: EmitFn): void {
  const turn = asRecord(params)?.turn;
  if (!turn || typeof turn !== 'object') {
    emit('finished', { ok: true, subtype: 'success' });
    return;
  }
  const status = (turn as AnyRecord).status;
  if (status === 'completed') {
    emit('finished', { ok: true, subtype: 'success' });
    return;
  }
  if (status === 'interrupted') {
    emit('finished', { ok: false, subtype: 'interrupted' });
    return;
  }
  if (status === 'failed') {
    const err = asRecord((turn as AnyRecord).error);
    const msg = typeof err?.message === 'string' ? err.message : 'Codex turn failed';
    emit('message', { text: `⚠ Codex 错误：${msg}`, error: true });
    emit('finished', { ok: false, subtype: 'failed' });
    return;
  }
  emit('finished', { ok: false, subtype: 'error' });
}

function translateTokenUsage(
  params: unknown,
  emit: EmitFn,
  opts?: { model?: string | null },
): void {
  const usage = asRecord(asRecord(params)?.tokenUsage);
  const last = asRecord(usage?.last);
  if (!last) return;
  emit('token-usage', {
    messageId: null,
    model: opts?.model ?? null,
    inputTokens: numberField(last.inputTokens),
    outputTokens: numberField(last.outputTokens) + numberField(last.reasoningOutputTokens),
    reasoningTokens: numberField(last.reasoningOutputTokens),
    cacheReadTokens: numberField(last.cachedInputTokens),
    cacheCreationTokens: 0,
  });
}

function translateErrorNotification(params: unknown, emit: EmitFn): void {
  const record = asRecord(params);
  const err = asRecord(record?.error);
  const msg = typeof err?.message === 'string' ? err.message : 'Unknown Codex app-server error';
  if (record?.willRetry === true || classifyStreamErrorEvent(msg) === 'transient') {
    const progress = extractRetryProgress(msg);
    emit('message', { text: `🔄 Codex 正在重连...${progress}` });
    return;
  }
  emit('message', { text: `⚠ Codex 流级错误：${msg}`, error: true });
  emit('finished', { ok: false, subtype: 'error' });
}

function translateItemStarted(item: AnyRecord, emit: EmitFn): void {
  const type = item.type;
  if (type === 'commandExecution') {
    emit('tool-use-start', {
      toolName: 'Bash',
      toolInput: { command: item.command },
      toolUseId: item.id,
    });
  } else if (type === 'mcpToolCall') {
    emit('tool-use-start', {
      toolName: `mcp__${String(item.server)}__${String(item.tool)}`,
      toolInput: item.arguments,
      toolUseId: item.id,
    });
  } else if (type === 'dynamicToolCall') {
    const tool = dynamicToolDisplay(item);
    emit('tool-use-start', {
      toolName: tool.toolName,
      toolInput: tool.toolInput,
      toolUseId: item.id,
    });
  } else if (type === 'collabAgentToolCall') {
    emit('tool-use-start', {
      toolName: 'Agent',
      toolInput: collabAgentToolInput(item),
      toolUseId: item.id,
    });
  }
}

function translateCommandOutputDelta(params: unknown, emit: EmitFn): void {
  const record = asRecord(params);
  if (!record) return;
  const itemId = typeof record.itemId === 'string' ? record.itemId : null;
  const delta = typeof record.delta === 'string' ? record.delta : null;
  if (!itemId || !delta) return;
  emit('tool-use-start', {
    toolName: 'Bash',
    toolUseId: itemId,
    aggregatedOutput: delta,
    [APPEND_AGGREGATED_OUTPUT]: true,
    status: 'inProgress',
  });
}

function translateItemCompleted(
  item: AnyRecord,
  emit: EmitFn,
  state?: CodexAppServerTranslateState,
): void {
  switch (item.type) {
    case 'agentMessage': {
      emitAssistantMessageIfPresent(item, emit);
      return;
    }

    case 'reasoning': {
      const summary = stringArray(item.summary);
      const deltaSummary = consumeReasoningSummaryDelta(item, state);
      const summaryText = summary.join('\n');
      const text = summaryText || deltaSummary;
      if (text) emit('thinking', { text });
      return;
    }

    case 'plan': {
      emitAssistantMessageIfPresent(item, emit);
      return;
    }

    case 'commandExecution': {
      emit('tool-use-end', {
        toolUseId: item.id,
        toolName: 'Bash',
        ...(typeof item.command === 'string' ? { toolInput: { command: item.command } } : {}),
        toolResult: item.aggregatedOutput ?? '',
        exitCode: item.exitCode ?? null,
        status: item.status,
      });
      return;
    }

    case 'fileChange': {
      if (isIncompleteCodexFileChangeStatus(item.status)) return;
      const changes = Array.isArray(item.changes) ? item.changes : [];
      for (const change of changes) {
        const c = asRecord(change);
        const filePath = typeof c?.path === 'string' ? c.path : null;
        if (!filePath) continue;
        const changeKind = codexFileChangeKind(c?.kind);
        const diff = typeof c?.diff === 'string' ? c.diff : undefined;
        if (!isEffectiveCodexFileChange(changeKind, diff)) continue;
        emit('file-changed', {
          filePath,
          kind: 'text',
          before: null,
          after: null,
          metadata: {
            source: 'codex',
            changeKind,
            patchStatus: item.status,
            diff,
          },
          toolCallId: item.id,
        });
      }
      return;
    }

    case 'mcpToolCall': {
      const result = asRecord(item.result);
      const error = asRecord(item.error);
      emit('tool-use-end', {
        toolUseId: item.id,
        toolName: `mcp__${String(item.server)}__${String(item.tool)}`,
        toolResult: result?.content,
        error: typeof error?.message === 'string' ? error.message : undefined,
        status: item.status,
      });
      return;
    }

    case 'dynamicToolCall': {
      const tool = dynamicToolDisplay(item);
      emit('tool-use-end', {
        toolUseId: item.id,
        toolName: tool.toolName,
        toolResult: item.contentItems,
        status: item.status,
        error: item.success === false ? 'Dynamic tool call failed' : undefined,
      });
      return;
    }

    case 'webSearch': {
      emit('tool-use-start', {
        toolName: 'WebSearch',
        toolInput: { query: item.query },
        toolUseId: item.id,
      });
      emit('tool-use-end', {
        toolUseId: item.id,
        toolName: 'WebSearch',
        toolResult: { query: item.query, action: item.action ?? null },
        status: 'completed',
      });
      return;
    }

    case 'hookPrompt': {
      const text = itemText(item);
      emit('message', {
        text: text ? `🪝 Hook prompt\n\n${text}` : '🪝 Hook prompt',
        role: 'assistant',
      });
      return;
    }

    case 'contextCompaction': {
      const text = itemText(item);
      emit('message', {
        text: text ? `🧭 上下文已压缩\n\n${text}` : '🧭 上下文已压缩',
        role: 'assistant',
      });
      return;
    }

    case 'enteredReviewMode': {
      emit('message', { text: '🔎 已进入 review 模式', role: 'assistant' });
      return;
    }

    case 'exitedReviewMode': {
      emit('message', { text: '🔎 已退出 review 模式', role: 'assistant' });
      return;
    }

    case 'collabAgentToolCall': {
      emit('tool-use-end', {
        toolUseId: item.id,
        toolName: 'Agent',
        toolResult: item.result ?? item.output ?? item.content ?? item.contentItems ?? '',
        status: item.status,
        error:
          itemErrorMessage(item) ??
          (item.success === false ? 'Collab agent tool call failed' : undefined),
      });
      return;
    }

    case 'imageView':
    case 'imageGeneration':
    case 'userMessage':
      return;

    default:
      logger.debug(`[codex-app-server-translate] ignored item type: ${String(item.type)}`);
  }
}

function emitAssistantMessageIfPresent(item: AnyRecord, emit: EmitFn): void {
  const text = stringField(item.text);
  if (!text.trim()) return;
  emit('message', { text, role: 'assistant' });
}

function trackReasoningSummaryDelta(
  params: unknown,
  state?: CodexAppServerTranslateState,
): void {
  if (!state) return;
  const record = asRecord(params);
  const itemId = stringField(record?.itemId) || stringField(asRecord(record?.item)?.id);
  const delta = stringField(record?.delta);
  if (!itemId || !delta) return;
  const chunks = state.reasoningSummaryByItemId.get(itemId) ?? [];
  chunks.push(delta);
  state.reasoningSummaryByItemId.set(itemId, chunks);
}

function consumeReasoningSummaryDelta(
  item: AnyRecord,
  state?: CodexAppServerTranslateState,
): string {
  if (!state) return '';
  const itemId = stringField(item.id);
  if (!itemId) return '';
  const chunks = state.reasoningSummaryByItemId.get(itemId);
  if (!chunks) return '';
  state.reasoningSummaryByItemId.delete(itemId);
  return chunks.join('');
}

function getItem(params: unknown): AnyRecord | null {
  const item = asRecord(params)?.item;
  return asRecord(item);
}

function asRecord(value: unknown): AnyRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as AnyRecord)
    : null;
}

function numberField(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
}

function formatDynamicToolName(item: AnyRecord): string {
  const tool = stringField(item.tool);
  const namespace = typeof item.namespace === 'string' && item.namespace ? item.namespace : null;
  return namespace ? `${namespace}.${tool}` : tool || 'DynamicTool';
}

function dynamicToolDisplay(item: AnyRecord): { toolName: string; toolInput: unknown } {
  const skill = dynamicToolSkillName(item);
  if (skill) {
    const args = asRecord(item.arguments);
    const argText =
      stringField(args?.args) ||
      stringField(args?.arguments) ||
      stringField(args?.input) ||
      stringField(args?.prompt) ||
      stringifyField(args?.args ?? args?.arguments ?? args?.input ?? args?.prompt);
    return {
      toolName: 'Skill',
      toolInput: argText ? { skill, args: argText } : { skill },
    };
  }
  return {
    toolName: formatDynamicToolName(item),
    toolInput: item.arguments,
  };
}

function dynamicToolSkillName(item: AnyRecord): string | null {
  const namespace = stringField(item.namespace).toLowerCase();
  const tool = stringField(item.tool).toLowerCase();
  if (
    namespace !== 'skill' &&
    namespace !== 'skills' &&
    tool !== 'skill' &&
    tool !== 'invoke_skill' &&
    tool !== 'skill.invoke'
  ) {
    return null;
  }
  const args = asRecord(item.arguments);
  const skill =
    stringField(args?.skill) ||
    stringField(args?.skillName) ||
    stringField(args?.name) ||
    stringField(item.name);
  if (skill) return skill;
  const toolName = stringField(item.tool);
  return toolName && !GENERIC_SKILL_TOOL_NAMES.has(toolName.toLowerCase()) ? toolName : null;
}

function collabAgentToolInput(item: AnyRecord): Record<string, string> {
  const prompt =
    stringField(item.prompt) ||
    stringField(item.instructions) ||
    stringField(item.input) ||
    stringField(item.task);
  const description =
    stringField(item.description) || stringField(item.title) || stringField(item.summary);
  return {
    subagent_type:
      stringField(item.subagent_type) ||
      stringField(item.subagentType) ||
      stringField(item.agentName) ||
      stringField(item.agent) ||
      stringField(item.name) ||
      'codex-collab-agent',
    ...(prompt ? { prompt } : {}),
    ...(description ? { description } : {}),
  };
}

function itemText(item: AnyRecord): string {
  const parts = [
    stringField(item.text),
    stringField(item.message),
    stringField(item.summary),
    stringField(item.prompt),
    ...stringArray(item.content),
  ].filter(Boolean);
  return parts.join('\n\n').trim();
}

function itemErrorMessage(item: AnyRecord): string | undefined {
  const err = asRecord(item.error);
  return stringField(err?.message) || stringField(item.errorMessage) || undefined;
}

function codexFileChangeKind(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  const record = asRecord(value);
  return stringField(record?.type) || undefined;
}

function stringifyField(value: unknown): string {
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
