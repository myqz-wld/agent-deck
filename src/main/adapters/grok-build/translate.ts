import type {
  AgentEvent,
  ContextRuntimeIdentityEvidence,
  GrokUsageWatermark,
} from '@shared/types';
import { normalizeAgentToolKind } from '@shared/tool-kind';
import type {
  ContentBlock,
  SessionUpdate,
  ToolCall,
  ToolCallContent,
  ToolCallUpdate,
} from '@agentclientprotocol/sdk';

import {
  handleGrokTextForLiveRateCore,
  NOOP_GROK_LIVE_RATE_OBSERVER,
  type GrokLiveRateObserver,
} from './live-token-rate-core';
import type { GrokTranslationState } from './translation-types';

const AGENT_ID = 'grok-build';
export type { GrokTranslationState } from './translation-types';
export {
  beginGrokTurn,
  clearGrokTurnLiveRate,
  completeGrokTurnLiveRate,
  markGrokStandardUsageEmitted,
  translateGrokTurnUsage,
  translateGrokUsage,
  waitForGrokStandardUsage,
} from './usage-translate';

export function createGrokTranslationState(options: {
  lastUsage?: GrokUsageWatermark | null;
  liveRateObserver?: GrokLiveRateObserver;
} = {}): GrokTranslationState {
  return {
    toolNames: new Map(),
    toolKinds: new Map(),
    startedToolIds: new Set(),
    thinkingToolIds: new Set(),
    pendingText: null,
    assistantObservedForCurrentTurn: false,
    currentAssistantText: '',
    lastUsage: options.lastUsage ?? null,
    standardUsageObservedForCurrentTurn: false,
    extensionUsageForCurrentTurn: false,
    usageSource: 'none',
    pendingStandardUsage: null,
    turnStartUsage: options.lastUsage ?? null,
    currentTurnUsageId: null,
    currentTurnStartedAt: null,
    currentProviderPromptId: null,
    currentExtensionPromptId: null,
    currentExtensionUsage: null,
    currentStandardUsageEvent: null,
    currentStandardUsageSnapshot: null,
    uncorrelatedStandardUsage: [],
    extensionUsageByPromptId: new Map(),
    canonicalUsageByPromptId: new Map(),
    baselineTrackedPromptIds: new Set(),
    frontierCoveredMetricScopeByPromptId: new Map(),
    completedProviderPromptIds: new Set(),
    liveRate: null,
    liveRateObserver:
      options.liveRateObserver ?? NOOP_GROK_LIVE_RATE_OBSERVER,
  };
}

export function createGrokContextUsageEvent(
  sessionId: string,
  usage: { usedTokens: number; windowTokens: number },
  runtimeIdentity: ContextRuntimeIdentityEvidence | null | undefined,
  ts = Date.now(),
): AgentEvent {
  return {
    sessionId,
    agentId: AGENT_ID,
    kind: 'context-usage',
    payload: {
      usedTokens: usage.usedTokens,
      windowTokens: usage.windowTokens,
      ...(runtimeIdentity
        ? {
            runtimeIdentity: { ...runtimeIdentity },
            capacitySource: 'runtime-usage',
          }
        : {}),
    },
    ts,
    source: 'sdk',
  };
}

export function translateGrokUpdate(
  sessionId: string,
  cwd: string,
  update: SessionUpdate,
  state: GrokTranslationState,
  runtimeIdentity?: ContextRuntimeIdentityEvidence | null,
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
      state.assistantObservedForCurrentTurn = true;
      if (update.content.type === 'text') {
        state.currentAssistantText += update.content.text;
      }
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
      // Current Grok builds usually omit this optional ACP id. Preserve it when present as a
      // same-turn hint, but do not assume ACP messageId and xAI prompt_id are interchangeable.
      if (typeof update.messageId === 'string' && update.messageId.trim()) {
        state.currentProviderPromptId = update.messageId;
      }
      return [];
    case 'tool_call': {
      const toolName = grokToolName(update);
      const toolKind = normalizeAgentToolKind(update.kind, toolName);
      state.toolNames.set(update.toolCallId, toolName);
      state.toolKinds.set(update.toolCallId, toolKind);
      if (toolKind === 'think') {
        state.thinkingToolIds.add(update.toolCallId);
        const text = toolThinkingText(update);
        const events = [
          ...flushGrokTextUpdates(sessionId, state),
          ...(text ? [event('thinking', { text, tool: true })] : []),
        ];
        if (update.status === 'completed' || update.status === 'failed') {
          state.thinkingToolIds.delete(update.toolCallId);
          state.toolKinds.delete(update.toolCallId);
          state.toolNames.delete(update.toolCallId);
        }
        return events;
      }
      const events = [
        ...flushGrokTextUpdates(sessionId, state),
        event('tool-use-start', {
          toolName,
          toolKind,
          toolInput: update.rawInput,
          toolUseId: update.toolCallId,
          status: normalizeToolStatus(update.status),
        }),
      ];
      if (update.status === 'completed' || update.status === 'failed') {
        events.push(
          event('tool-use-end', {
            toolName,
            toolKind,
            toolUseId: update.toolCallId,
            toolResult: update.rawOutput ?? toolContentText(update.content),
            status: update.status,
          }),
        );
        state.toolKinds.delete(update.toolCallId);
        state.toolNames.delete(update.toolCallId);
        return events;
      }
      state.startedToolIds.add(update.toolCallId);
      return events;
    }
    case 'tool_call_update': {
      // ACP `title` is a mutable human-readable progress label. Keep the identity chosen for the
      // start event so the matching completion row cannot drift when Grok patches that title.
      // ACP 1.3 `name` is the programmatic identity and wins when the initial call has it.
      const toolName =
        state.toolNames.get(update.toolCallId) ?? rememberGrokToolName(update, state);
      const toolKind = normalizeAgentToolKind(
        update.kind ?? state.toolKinds.get(update.toolCallId),
        toolName,
      );
      state.toolKinds.set(update.toolCallId, toolKind);
      if (toolKind === 'think' || state.thinkingToolIds.has(update.toolCallId)) {
        const events = flushGrokTextUpdates(sessionId, state);
        const text = toolThinkingText(update);
        if (text) events.push(event('thinking', { text, tool: true }));
        if (update.status === 'completed' || update.status === 'failed') {
          state.thinkingToolIds.delete(update.toolCallId);
          state.toolKinds.delete(update.toolCallId);
          state.toolNames.delete(update.toolCallId);
        }
        return events;
      }

      const events = flushGrokTextUpdates(sessionId, state);
      if (update.status === 'completed' || update.status === 'failed') {
        if (!state.startedToolIds.has(update.toolCallId)) {
          events.push(
            event('tool-use-start', {
              toolName,
              toolKind,
              toolUseId: update.toolCallId,
              toolInput: update.rawInput,
            }),
          );
        }
        events.push(
          event('tool-use-end', {
            toolName,
            toolKind,
            toolUseId: update.toolCallId,
            toolResult: update.rawOutput ?? toolContentText(update.content),
            status: update.status,
          }),
        );
        state.startedToolIds.delete(update.toolCallId);
        state.toolKinds.delete(update.toolCallId);
        state.toolNames.delete(update.toolCallId);
      } else if (!state.startedToolIds.has(update.toolCallId)) {
        state.startedToolIds.add(update.toolCallId);
        events.push(
          event('tool-use-start', {
            toolName,
            toolKind,
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
    case 'compaction_update':
    case 'compaction_summary_chunk':
      // Agent Deck does not advertise ACP compaction support. Keep the new protocol variants
      // exhaustively recognized without surfacing updates whose lifecycle the app cannot retain.
      return [];
    case 'usage_update':
      if (
        !Number.isFinite(update.used) ||
        update.used < 0 ||
        !Number.isFinite(update.size) ||
        update.size <= 0
      ) {
        return [];
      }
      return [
        createGrokContextUsageEvent(
          sessionId,
          {
            usedTokens: Math.trunc(update.used),
            windowTokens: Math.trunc(update.size),
          },
          runtimeIdentity,
          ts,
        ),
      ];
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
      payload: pending.kind === 'message' ? { text, role: 'assistant' } : { text },
      ts: Date.now(),
      source: 'sdk',
    },
  ];
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
    handleGrokTextForLiveRateCore(
      state,
      content.text,
      Date.now(),
      state.liveRateObserver,
    );
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
  return status ?? undefined;
}

function grokToolName(update: { name?: string | null; title?: string | null }): string {
  for (const value of [update.name, update.title]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return 'Grok tool';
}

function rememberGrokToolName(
  update: ToolCallUpdate,
  state: GrokTranslationState,
): string {
  const toolName = grokToolName(update);
  state.toolNames.set(update.toolCallId, toolName);
  return toolName;
}

function toolThinkingText(update: ToolCall | ToolCallUpdate): string | null {
  for (const value of [update.rawOutput, update.rawInput]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    for (const key of ['text', 'thought', 'thinking', 'reasoning', 'content']) {
      const text = record[key];
      if (typeof text === 'string' && text.trim()) return text.trim();
    }
  }
  const contentText = toolContentText(update.content);
  return typeof contentText === 'string' && contentText.trim() ? contentText.trim() : null;
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
