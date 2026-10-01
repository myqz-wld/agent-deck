import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord, SessionAdapterId } from '@shared/types';
import { makeSessionRepoMock } from '@main/__tests__/_shared/mocks/session-repo';
import { makeSdkLoaderMock } from '@main/__tests__/_shared/mocks/sdk-loader';

const mocks = vi.hoisted(() => ({ sessions: new Map<string, SessionRecord>(), ingest: vi.fn() }));
vi.mock('@main/store/session-repo', () => ({ sessionRepo: makeSessionRepoMock({ sessions: mocks.sessions }) }));
vi.mock('@main/session/manager', () => ({ sessionManager: { ingest: mocks.ingest } }));
vi.mock('@main/adapters/claude-code/sdk-loader', () => makeSdkLoaderMock());

import { askUserService } from '@main/ask-user/service';
import { eventBus } from '@main/event-bus';
import { askUserHandler } from '../tools/handlers/ask-user';
import { ASK_USER_ARGS_SCHEMA, ASK_USER_OUTPUT_SCHEMA } from '../tools/schemas/ask-user';
import { buildAgentDeckTools } from '../tools';
import { classifyMcpHttpOperation } from '../transport-http-observability';

const args = { questions: [
  { question: 'Choose environments', multiSelect: true, options: [{ label: 'Local' }, { label: 'Remote' }] },
  { question: 'Any constraints?' },
] };
const answer = { answers: [
  { question: 'Choose environments', selected: ['Local', 'Remote'], note: 'Keep both' },
  { question: 'Any constraints?', selected: [], other: 'No restart' },
] };
const ctx = (sessionId = 'caller') => ({ caller: { callerSessionId: sessionId, transport: 'http' as const } });

function seed(agentId: SessionAdapterId = 'codex-cli'): void {
  mocks.sessions.set('caller', {
    id: 'caller', agentId, cwd: '/repo', title: 'test', source: 'sdk', lifecycle: 'active',
    activity: 'working', startedAt: 1, lastEventAt: 1, endedAt: null, archivedAt: null,
  });
}

beforeEach(() => { mocks.sessions.clear(); mocks.ingest.mockReset(); seed(); });
afterEach(() => { askUserService.cancelForSession('caller'); vi.useRealTimers(); });

describe('ask_user Local MCP', () => {
  it.each(['claude-code', 'codex-cli', 'grok-build'] as const)(
    'publishes and answers questions for %s without a native responder', async (adapterId) => {
      seed(adapterId);
      const tools = await buildAgentDeckTools({ adapterId, transport: 'in-process', callerSessionIdOverride: () => 'caller' });
      const tool = tools.find((item) => item.name === 'ask_user')!;
      expect(tool.outputSchema).toBe(ASK_USER_OUTPUT_SCHEMA);
      const pending = tool.handler(args, {});
      const [request] = askUserService.listPending('caller');
      expect(request?.questions[1].options).toEqual([]);
      expect(mocks.ingest).toHaveBeenCalledWith(expect.objectContaining({
        agentId: adapterId, sessionId: 'caller', kind: 'waiting-for-user',
        payload: expect.objectContaining({ type: 'ask-user-question' }),
      }));
      expect(askUserService.listAllPending(adapterId).caller).toHaveLength(1);
      expect(askUserService.respond('caller', request!.requestId, answer)).toBe(true);
      const result = await pending;
      expect(result.structuredContent).toEqual({ status: 'answered', ...answer });
      expect(ASK_USER_OUTPUT_SCHEMA.safeParse(result.structuredContent).success).toBe(true);
      expect(askUserService.listPending('caller')).toEqual([]);
      expect(mocks.ingest).toHaveBeenLastCalledWith(expect.objectContaining({
        payload: { type: 'ask-question-answered', requestId: request!.requestId, ...answer },
      }));
      expect(askUserService.respond('caller', request!.requestId, answer)).toBe(false);
    },
  );

  it('rejects external, missing, and closed callers without publishing a question', async () => {
    for (const caller of ['__external__', 'missing']) {
      expect((await askUserHandler(args, ctx(caller))).isError).toBe(true);
    }
    mocks.sessions.get('caller')!.lifecycle = 'closed';
    expect((await askUserHandler(args, ctx())).isError).toBe(true);
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it('keeps the request pending after malformed answers and rejects another owner', async () => {
    const pending = askUserHandler(args, ctx());
    const requestId = askUserService.listPending('caller')[0]!.requestId;
    expect(askUserService.respond('other', requestId, answer)).toBe(false);
    for (const invalid of [
      { answers: [] },
      { answers: [{ question: 'forged', selected: ['Local'] }, answer.answers[1]] },
      { answers: [{ question: args.questions[0].question, selected: ['unknown'] }, answer.answers[1]] },
      { answers: [{ question: args.questions[0].question, selected: ['Local', 'Local'] }, answer.answers[1]] },
      { answers: args.questions.map((question) => ({ question: question.question, selected: [] })) },
    ]) expect(() => askUserService.respond('caller', requestId, invalid)).toThrow();
    expect(askUserService.listPending('caller')).toHaveLength(1);
    expect(askUserService.respond('caller', requestId, answer)).toBe(true);
    expect((await pending).isError).not.toBe(true);
  });

  it('waits without an app timer, hydrates a copy, and cancels on transport abort', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const pending = askUserHandler(args, ctx(), controller.signal);
    const copy = askUserService.listPending('caller')[0]!;
    copy.questions[0].options[0].label = 'forged';
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(askUserService.listPending('caller')[0].questions[0].options[0].label).toBe('Local');
    controller.abort();
    expect((await pending).structuredContent).toEqual({ status: 'cancelled', answers: [] });
    expect(askUserService.listPending('caller')).toEqual([]);
    expect(mocks.ingest).toHaveBeenLastCalledWith(expect.objectContaining({
      payload: { type: 'ask-question-cancelled', requestId: copy.requestId },
    }));
  });

  it('does not publish an already cancelled request and cleans up publication failure', async () => {
    const controller = new AbortController(); controller.abort();
    expect((await askUserHandler(args, ctx(), controller.signal)).structuredContent)
      .toEqual({ status: 'cancelled', answers: [] });
    expect(mocks.ingest).not.toHaveBeenCalled();
    mocks.ingest.mockImplementationOnce(() => { throw new Error('publication failed'); });
    expect((await askUserHandler(args, ctx())).isError).toBe(true);
    expect(askUserService.listPending('caller')).toEqual([]);
  });

  it('preserves response ownership after a provider session id is canonicalized', async () => {
    const pending = askUserHandler(args, ctx());
    const requestId = askUserService.listPending('caller')[0].requestId;
    eventBus.emit('session-renamed', { from: 'caller', to: 'canonical' });
    expect(askUserService.listPending('caller')).toEqual([]);
    expect(askUserService.respond('caller', requestId, answer)).toBe(false);
    expect(askUserService.respond('canonical', requestId, answer)).toBe(true);
    expect((await pending).structuredContent).toEqual({ status: 'answered', ...answer });
  });

  it.each(['close', 'remove', 'handoff', 'finished'] as const)('cleans up on %s', async (action) => {
    const pending = askUserHandler(args, ctx());
    if (action === 'close') eventBus.emit('session-upserted', { ...mocks.sessions.get('caller')!, lifecycle: 'closed' });
    if (action === 'remove') eventBus.emit('session-removed', 'caller');
    if (action === 'handoff') eventBus.emit('session-hand-off-committed', { sourceSessionId: 'caller', successorSessionId: 'next' });
    if (action === 'finished') eventBus.emit('agent-event', { sessionId: 'caller', agentId: 'codex-cli', kind: 'finished', payload: {}, ts: 1, source: 'sdk' });
    expect((await pending).structuredContent).toEqual({ status: 'cancelled', answers: [] });
    expect(askUserService.listPending('caller')).toEqual([]);
  });

  it('limits outstanding questions and classifies human wait without a slow-operation warning', async () => {
    const pending = Array.from({ length: 4 }, () => askUserHandler(args, ctx()));
    expect((await askUserHandler(args, ctx())).isError).toBe(true);
    askUserService.cancelForSession('caller');
    await Promise.all(pending);
    expect(classifyMcpHttpOperation({ method: 'tools/call', params: { name: 'ask_user' } }))
      .toMatchObject({ operationClass: 'human_wait' });
  });
});

describe('ask_user schema', () => {
  it('accepts free text and choice questions, rejects ambiguous labels and oversized UTF-8 text', () => {
    expect(ASK_USER_ARGS_SCHEMA.safeParse(args).success).toBe(true);
    for (const value of [
      { questions: [] },
      { questions: Array.from({ length: 5 }, () => ({ question: 'Too many?' })) },
      { questions: [{ question: 'Which?', options: [{ label: 'Same' }, { label: 'Same' }] }] },
      { questions: [{ question: '中'.repeat(342) }] },
      { questions: [{ question: 'Which?', options: null }] },
      { questions: [{ question: ' ' }] },
      { ...args, sessionId: 'forged' },
    ]) expect(ASK_USER_ARGS_SCHEMA.safeParse(value).success).toBe(false);
  });
});
