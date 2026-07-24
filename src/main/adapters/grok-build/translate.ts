import type {
  AgentEvent,
} from '@shared/types';
import type {
  ContentBlock,
  SessionUpdate,
  ToolCallContent,
  Usage,
} from '@agentclientprotocol/sdk';

const AGENT_ID = 'grok-build';

export interface GrokTranslationState {
  toolNames: Map<string, string>;
  startedToolIds: Set<string>;
  pendingText: {
    kind: 'message' | 'thinking';
    messageId: string | null;
    chunks: string[];
  } | null;
  lastUsage: Usage | null;
}

export function createGrokTranslationState(): GrokTranslationState {
  return {
    toolNames: new Map(),
    startedToolIds: new Set(),
    pendingText: null,
    lastUsage: null,
  };
}

export function translateGrokUpdate(
  sessionId: string,
  cwd: string,
  update: SessionUpdate,
  state: GrokTranslationState,
): AgentEvent[] {
  const ts = Date.now();
  const event = (kind: AgentEvent['kind'], payload: unknown): AgentEvent => ({
    sessionId,
    agentId: AGENT_ID,
    kind,
    payload,
    ts,
    source: 'sdk',
  });

  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      return contentEvents(
        sessionId,
        update.content,
        update.messageId ?? null,
        'message',
        state,
        event,
      );
    case 'agent_thought_chunk':
      return contentEvents(
        sessionId,
        update.content,
        update.messageId ?? null,
        'thinking',
        state,
        event,
      );
    case 'user_message_chunk':
      // Agent Deck already persists accepted user input before the ACP turn starts.
      return [];
    case 'tool_call': {
      state.toolNames.set(update.toolCallId, update.title);
      state.startedToolIds.add(update.toolCallId);
      return [
        ...flushGrokTextUpdates(sessionId, state),
        event('tool-use-start', {
          toolName: update.title,
          toolInput: update.rawInput,
          toolUseId: update.toolCallId,
          status: normalizeToolStatus(update.status),
        }),
      ];
    }
    case 'tool_call_update': {
      const toolName =
        update.title ?? state.toolNames.get(update.toolCallId) ?? 'Grok tool';
      if (update.title) state.toolNames.set(update.toolCallId, update.title);
      const events = flushGrokTextUpdates(sessionId, state);
      if (update.status === 'completed' || update.status === 'failed') {
        if (!state.startedToolIds.has(update.toolCallId)) {
          events.push(
            event('tool-use-start', {
              toolName,
              toolUseId: update.toolCallId,
              toolInput: update.rawInput,
            }),
          );
        }
        events.push(
          event('tool-use-end', {
            toolName,
            toolUseId: update.toolCallId,
            toolResult: update.rawOutput ?? toolContentText(update.content),
            status: update.status === 'completed' ? 'success' : 'error',
          }),
        );
        state.startedToolIds.delete(update.toolCallId);
        state.toolNames.delete(update.toolCallId);
      } else if (!state.startedToolIds.has(update.toolCallId)) {
        state.startedToolIds.add(update.toolCallId);
        events.push(
          event('tool-use-start', {
            toolName,
            toolUseId: update.toolCallId,
            toolInput: update.rawInput,
            aggregatedOutput: toolContentText(update.content),
            status: normalizeToolStatus(update.status),
          }),
        );
      }
      for (const content of update.content ?? []) {
        if (content.type !== 'diff') continue;
        events.push(
          event('file-changed', {
            cwd,
            filePath: content.path,
            kind: 'text',
            before: content.oldText ?? null,
            after: content.newText,
            metadata: { source: 'grok-acp' },
            toolCallId: update.toolCallId,
          }),
        );
      }
      return events;
    }
    case 'plan':
      return [
        ...flushGrokTextUpdates(sessionId, state),
        event('thinking', {
          text: update.entries
            .map((entry) => `- [${entry.status === 'completed' ? 'x' : ' '}] ${entry.content}`)
            .join('\n'),
          plan: true,
        }),
      ];
    case 'plan_update':
      return [
        ...flushGrokTextUpdates(sessionId, state),
        event('thinking', {
          text: formatPlanUpdate(update),
          plan: true,
        }),
      ];
    case 'plan_removed':
      return flushGrokTextUpdates(sessionId, state);
    case 'available_commands_update':
    case 'current_mode_update':
    case 'config_option_update':
    case 'session_info_update':
    case 'usage_update':
      return [];
  }
}

export function flushGrokTextUpdates(
  sessionId: string,
  state: GrokTranslationState,
): AgentEvent[] {
  const pending = state.pendingText;
  state.pendingText = null;
  if (!pending) return [];
  const text = pending.chunks.join('');
  if (!text) return [];
  return [
    {
      sessionId,
      agentId: AGENT_ID,
      kind: pending.kind,
      payload:
        pending.kind === 'message'
          ? { text, role: 'assistant' }
          : { text },
      ts: Date.now(),
      source: 'sdk',
    },
  ];
}

export function translateGrokUsage(
  sessionId: string,
  model: string | null,
  usage: Usage | null | undefined,
  state: GrokTranslationState,
): AgentEvent | null {
  if (!usage) return null;
  const previous = state.lastUsage;
  state.lastUsage = usage;
  return {
    sessionId,
    agentId: AGENT_ID,
    kind: 'token-usage',
    payload: {
      messageId: null,
      model,
      inputTokens: delta(usage.inputTokens, previous?.inputTokens),
      outputTokens: delta(usage.outputTokens, previous?.outputTokens),
      reasoningTokens: delta(usage.thoughtTokens ?? 0, previous?.thoughtTokens ?? 0),
      cacheReadTokens: delta(usage.cachedReadTokens ?? 0, previous?.cachedReadTokens ?? 0),
      cacheCreationTokens: delta(
        usage.cachedWriteTokens ?? 0,
        previous?.cachedWriteTokens ?? 0,
      ),
    },
    ts: Date.now(),
    source: 'sdk',
  };
}

function contentEvents(
  sessionId: string,
  content: ContentBlock,
  messageId: string | null,
  kind: 'message' | 'thinking',
  state: GrokTranslationState,
  event: (kind: AgentEvent['kind'], payload: unknown) => AgentEvent,
): AgentEvent[] {
  if (content.type === 'text') {
    const flushed =
      state.pendingText &&
      (state.pendingText.kind !== kind || state.pendingText.messageId !== messageId)
        ? flushGrokTextUpdates(sessionId, state)
        : [];
    if (!state.pendingText) state.pendingText = { kind, messageId, chunks: [] };
    state.pendingText.chunks.push(content.text);
    return flushed;
  }
  if (content.type === 'image') {
    return [
      ...flushGrokTextUpdates(sessionId, state),
      event('message', {
        text: '[Grok returned an image]',
        role: 'assistant',
        image: {
          mime: content.mimeType,
          uri: content.uri ?? null,
          byteLength: Math.floor((content.data.length * 3) / 4),
        },
      }),
    ];
  }
  return flushGrokTextUpdates(sessionId, state);
}

function normalizeToolStatus(status: string | null | undefined): string | undefined {
  if (status === 'in_progress') return 'inProgress';
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'error';
  return status ?? undefined;
}

function toolContentText(content: ToolCallContent[] | null | undefined): unknown {
  if (!content?.length) return undefined;
  const values = content.map((item) => {
    if (item.type === 'content' && item.content.type === 'text') return item.content.text;
    if (item.type === 'diff') return `${item.path}\n${item.newText}`;
    if (item.type === 'terminal') return `[terminal ${item.terminalId}]`;
    return item;
  });
  return values.length === 1 ? values[0] : values;
}

function formatPlanUpdate(update: Extract<SessionUpdate, { sessionUpdate: 'plan_update' }>): string {
  if (update.plan.type === 'markdown') return update.plan.content;
  if (update.plan.type === 'file') return `Plan: ${update.plan.uri}`;
  return update.plan.entries
    .map((entry) => `- [${entry.status === 'completed' ? 'x' : ' '}] ${entry.content}`)
    .join('\n');
}

function delta(current: number, previous: number | undefined): number {
  return Math.max(0, current - (previous ?? 0));
}
