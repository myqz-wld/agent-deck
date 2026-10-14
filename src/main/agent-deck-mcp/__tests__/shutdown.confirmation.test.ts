import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '@shared/types';

const state = vi.hoisted(() => ({
  sessions: new Map<string, SessionRecord>(), close: vi.fn(async () => undefined), ingest: vi.fn(),
  aliases: new Map<string, string>(),
}));
vi.mock('@main/store/session-repo', () => ({ sessionRepo: { get: (id: string) => state.sessions.get(id) ?? null } }));
vi.mock('@main/session/manager', () => ({ sessionManager: { close: state.close, ingest: state.ingest } }));
vi.mock('@main/session/hand-off/ownership', () => ({ sessionOwnershipLineage: (id: string) => [id] }));
vi.mock('@main/session/hand-off/cutover-coordinator', () => ({
  handOffCutoverCoordinator: { successorForStrict: (id: string) => state.aliases.get(id) ?? null },
}));
import { askUserService } from '@main/ask-user/service';
import { shutdownSessionHandler } from '../tools/handlers/shutdown';

const ctx = { caller: { callerSessionId: 'caller', transport: 'http' as const } };
beforeEach(() => {
  vi.clearAllMocks(); state.sessions.clear(); state.aliases.clear();
  for (const id of ['caller', 'peer']) state.sessions.set(id, { id, title: id, cwd: '/workspace',
    agentId: 'codex-cli', source: 'sdk', lifecycle: 'active', activity: 'idle',
    startedAt: 1, lastEventAt: 1, endedAt: null, archivedAt: null });
});
afterEach(() => askUserService.cancelForSession('caller'));

describe('shutdown Pending integration', () => {
  it.each(['确认关闭', '取消'])('closes an unrelated target only for explicit %s', async (choice) => {
    const pending = shutdownSessionHandler({ sessionId: 'peer' }, ctx);
    const [request] = askUserService.listPending('caller');
    expect(request.questions[0].question).toContain('ID：peer');
    expect(state.close).not.toHaveBeenCalled();
    expect(askUserService.respond('peer', request.requestId, {})).toBe(false);
    askUserService.respond('caller', request.requestId, { answers: [{
      question: request.questions[0].question, selected: [choice],
    }] });
    expect((await pending).isError === true).toBe(choice === '取消');
    expect(state.close).toHaveBeenCalledTimes(choice === '确认关闭' ? 1 : 0);
    expect(askUserService.listPending('caller')).toEqual([]);
  });

  it('cannot apply approval to a handed-off target and cleans Pending on transport abort', async () => {
    const operation = shutdownSessionHandler({ sessionId: 'peer' }, ctx);
    const [request] = askUserService.listPending('caller');
    state.aliases.set('peer', 'successor');
    askUserService.respond('caller', request.requestId, { answers: [{
      question: request.questions[0].question, selected: ['确认关闭'],
    }] });
    expect((await operation).isError).toBe(true);
    expect(state.close).not.toHaveBeenCalled();
    state.aliases.clear();
    const abort = new AbortController();
    const cancelled = shutdownSessionHandler({ sessionId: 'peer' }, ctx, abort.signal);
    abort.abort();
    expect((await cancelled).isError).toBe(true);
    expect(askUserService.listPending('caller')).toEqual([]);
    expect(state.close).not.toHaveBeenCalled();
  });
});
