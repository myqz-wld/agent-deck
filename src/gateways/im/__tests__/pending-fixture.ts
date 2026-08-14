import type { JsonObject, PendingRequestDto } from '@contracts/index';

import { pending } from './fixture';

export function pendingForKind(
  kind: PendingRequestDto['kind'],
  id = 'pending-1',
  sessionId = 'session-1',
): PendingRequestDto {
  if (kind === 'permission') return pending(id, sessionId);
  const display: JsonObject = kind === 'ask-user-question'
    ? {
        prompt: 'Question',
        questionIds: ['answer'],
        questions: [{
          id: 'answer', question: 'Answer?', multiSelect: false, options: [],
        }],
      }
    : kind === 'exit-plan'
      ? { summary: '# Plan' }
      : {
          schema: 'agent-deck.mcp-diff.v1',
          mode: 'pr',
          rationale: 'Review',
          pr: { before: 'before', after: 'after' },
        };
  return { ...pending(id, sessionId), kind, display };
}
