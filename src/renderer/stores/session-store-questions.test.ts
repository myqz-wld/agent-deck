import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '@shared/types';
import { useSessionStore } from './session-store';

beforeEach(() => useSessionStore.setState({
  pendingAskQuestionsBySession: new Map(), recentEventsBySession: new Map(),
  eventRevisionsBySession: new Map(), pendingRevisionsBySession: new Map(),
}));
const question = { type: 'ask-user-question' as const, requestId: 'mcp-ask-1', questions: [{ question: 'Choice?', options: [] }] };
const event = (sessionId: string, payload: unknown): AgentEvent => ({ sessionId, agentId: 'grok-build', kind: 'waiting-for-user', ts: 1, source: 'sdk', payload });

describe('unified questions in Pending', () => {
  it('hydrates MCP questions and keeps them available when the selected session changes', () => {
    useSessionStore.getState().setPendingRequestsAll({ 'session-a': { permissions: [], askQuestions: [question], exitPlanModes: [] } });
    useSessionStore.getState().selectSession('session-b');
    expect(useSessionStore.getState().pendingAskQuestionsBySession.get('session-a')).toEqual([question]);
  });

  it.each(['ask-question-answered', 'ask-question-cancelled'])('removes only the matching request after %s', (type) => {
    useSessionStore.getState().pushEvent(event('session-a', question));
    useSessionStore.getState().pushEvent(event('session-b', { ...question, requestId: 'mcp-ask-2' }));
    useSessionStore.getState().pushEvent(event('session-a', { type, requestId: question.requestId }));
    expect(useSessionStore.getState().pendingAskQuestionsBySession.has('session-a')).toBe(false);
    expect(useSessionStore.getState().pendingAskQuestionsBySession.get('session-b')).toHaveLength(1);
  });
});
