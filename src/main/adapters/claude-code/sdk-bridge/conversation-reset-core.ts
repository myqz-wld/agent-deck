import type { AgentEvent } from '@shared/types';
import type { InternalSession } from './types';
import { completedSessionCommandText } from '@core/system-status-copy';

export interface ClaudeConversationResetHost {
  updateCliSessionId(applicationSessionId: string, cliSessionId: string): void;
  now(): number;
}

/** Apply Claude's provider-native `/clear` without changing Agent Deck's stable session id. */
export function applyClaudeConversationResetCore(
  internal: InternalSession,
  frame: { new_conversation_id?: unknown },
  emit: (event: AgentEvent) => void,
  host: ClaudeConversationResetHost,
): boolean {
  const nextCliSessionId = typeof frame.new_conversation_id === 'string'
    ? frame.new_conversation_id.trim()
    : '';
  if (!nextCliSessionId) return false;

  internal.cliSessionId = nextCliSessionId;
  internal.seenUsageMessageIds.clear();
  internal.turnUsageByBucket.clear();
  internal.claudeResultUsageByModel?.clear();
  internal.claudeAggregateResultUsage = undefined;
  internal.claudeResultBaselinePending = false;
  internal.liveTokenEstimate = undefined;
  internal.toolUseNames.clear();
  internal.pendingFileChangeIntents.clear();
  host.updateCliSessionId(internal.applicationSid, nextCliSessionId);

  const ts = host.now();
  emit({
    sessionId: internal.applicationSid,
    agentId: 'claude-code',
    kind: 'context-usage',
    payload: { usedTokens: null },
    ts,
    source: 'sdk',
  });
  emit({
    sessionId: internal.applicationSid,
    agentId: 'claude-code',
    kind: 'message',
    payload: {
      text: completedSessionCommandText(
        'Claude',
        'clear',
        '已开始新对话，原时间线保留',
      ),
      role: 'system',
      sessionCommandStatus: { command: 'clear', status: 'completed' },
    },
    ts,
    source: 'sdk',
  });
  return true;
}
