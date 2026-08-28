import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@shared/types';
import type { InternalSession } from './types';
import { applyClaudeConversationResetCore } from './conversation-reset-core';

describe('Claude conversation reset', () => {
  it('rotates only the native identity and resets conversation-scoped accounting', () => {
    const internal = {
      applicationSid: 'app-session',
      cliSessionId: 'native-old',
      seenUsageMessageIds: new Map([['message', {
        input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheCreation: 5,
      }]]),
      turnUsageByBucket: new Map([['model', {
        input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheCreation: 5,
      }]]),
      claudeResultUsageByModel: new Map([['model', {
        input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheCreation: 5,
      }]]),
      claudeAggregateResultUsage: {
        input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheCreation: 5,
      },
      claudeResultBaselinePending: true,
      liveTokenEstimate: { bucketKey: 'model' },
      toolUseNames: new Map([['tool', 'Bash']]),
      pendingFileChangeIntents: new Map([['tool', {}]]),
    } as unknown as InternalSession;
    const events: AgentEvent[] = [];
    const updateCliSessionId = vi.fn();

    expect(applyClaudeConversationResetCore(
      internal,
      { new_conversation_id: 'native-new' },
      (event) => events.push(event),
      { updateCliSessionId, now: () => 42 },
    )).toBe(true);

    expect(internal.applicationSid).toBe('app-session');
    expect(internal.cliSessionId).toBe('native-new');
    expect(updateCliSessionId).toHaveBeenCalledWith('app-session', 'native-new');
    expect(internal.seenUsageMessageIds.size).toBe(0);
    expect(internal.claudeResultUsageByModel?.size).toBe(0);
    expect(events.map((event) => event.kind)).toEqual(['context-usage', 'message']);
    expect(events[1]?.payload).toEqual({
      text: 'Claude 已清空上下文并开始新对话；此前记录仍保留在 Agent Deck 时间线中。',
      role: 'system',
      sessionCommandStatus: { command: 'clear', status: 'completed' },
    });
  });
});
