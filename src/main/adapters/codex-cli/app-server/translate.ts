import type { CodexAppServerNotification } from './client';
import {
  classifyStreamErrorEvent,
  extractRetryProgress,
  type EmitFn,
} from '../translate';
import log from '@main/utils/logger';

const logger = log.scope('codex-app-server-translate');

type AnyRecord = Record<string, unknown>;

export function translateCodexAppServerNotification(
  notification: CodexAppServerNotification,
  emit: EmitFn,
  opts?: { model?: string | null },
): void {
  switch (notification.method) {
    case 'thread/started':
    case 'thread/status/changed':
    case 'turn/started':
    case 'item/agentMessage/delta':
    case 'item/reasoning/textDelta':
    case 'item/reasoning/summaryTextDelta':
    case 'item/plan/delta':
    case 'turn/diff/updated':
    case 'turn/plan/updated':
      return;

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
      if (item) translateItemCompleted(item, emit);
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
    emit('tool-use-start', {
      toolName: formatDynamicToolName(item),
      toolInput: item.arguments,
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
    status: 'inProgress',
  });
}

function translateItemCompleted(item: AnyRecord, emit: EmitFn): void {
  switch (item.type) {
    case 'agentMessage': {
      emit('message', { text: stringField(item.text), role: 'assistant' });
      return;
    }

    case 'reasoning': {
      const content = stringArray(item.content);
      const summary = stringArray(item.summary);
      const text = content.length > 0 ? content.join('\n') : summary.join('\n');
      if (text) emit('thinking', { text });
      return;
    }

    case 'plan': {
      emit('message', { text: stringField(item.text), role: 'assistant' });
      return;
    }

    case 'commandExecution': {
      emit('tool-use-end', {
        toolUseId: item.id,
        toolName: 'Bash',
        toolResult: item.aggregatedOutput ?? '',
        exitCode: item.exitCode ?? null,
        status: item.status,
      });
      return;
    }

    case 'fileChange': {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      for (const change of changes) {
        const c = asRecord(change);
        const filePath = typeof c?.path === 'string' ? c.path : null;
        if (!filePath) continue;
        emit('file-changed', {
          filePath,
          kind: 'text',
          before: null,
          after: null,
          metadata: {
            source: 'codex',
            changeKind: c?.kind,
            patchStatus: item.status,
            diff: c?.diff,
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
      emit('tool-use-end', {
        toolUseId: item.id,
        toolName: formatDynamicToolName(item),
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

    case 'imageView':
    case 'imageGeneration':
    case 'userMessage':
    case 'hookPrompt':
    case 'contextCompaction':
    case 'enteredReviewMode':
    case 'exitedReviewMode':
    case 'collabAgentToolCall':
      return;

    default:
      logger.debug(`[codex-app-server-translate] ignored item type: ${String(item.type)}`);
  }
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
