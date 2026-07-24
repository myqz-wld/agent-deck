import type { AgentEvent } from '@shared/types';
import { describe, expect, it, vi } from 'vitest';
import { buildGrokHookRoutes } from '../hook-routes';

function replyStub(): { code: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn();
  const code = vi.fn(() => ({ send }));
  return { code, send };
}

describe('Grok hook routes', () => {
  it('accepts camelCase Grok payloads and tags external process identity', async () => {
    const events: AgentEvent[] = [];
    const route = buildGrokHookRoutes((event) => events.push(event)).find(
      (candidate) => candidate.url === '/hook/grok/sessionstart',
    );

    await (route?.handler as (request: unknown, reply: unknown) => Promise<void>)(
      {
        body: {
          sessionId: 'grok-external',
          cwd: '/repo',
          workspaceRoot: '/repo',
          hookEventName: 'SessionStart',
        },
        headers: {
          'x-agent-deck-origin': 'cli',
          'x-agent-deck-parent-pid': '12345',
        },
      },
      replyStub(),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      sessionId: 'grok-external',
      agentId: 'grok-build',
      source: 'hook',
      hookOrigin: 'cli',
      payload: { cwd: '/repo', externalProcessPid: 12345 },
    });
  });

  it('marks managed-child events as sdk for the shared dedup gate', async () => {
    const events: AgentEvent[] = [];
    const route = buildGrokHookRoutes((event) => events.push(event)).find(
      (candidate) => candidate.url === '/hook/grok/stop',
    );

    await (route?.handler as (request: unknown, reply: unknown) => Promise<void>)(
      {
        body: { sessionId: 'managed-grok', hookEventName: 'Stop' },
        headers: { 'x-agent-deck-origin': 'sdk' },
      },
      replyStub(),
    );

    expect(events[0]).toMatchObject({ source: 'hook', hookOrigin: 'sdk' });
  });

  it('rejects payloads without the official sessionId field', async () => {
    const events: AgentEvent[] = [];
    const reply = replyStub();
    const route = buildGrokHookRoutes((event) => events.push(event))[0];

    await (route.handler as (request: unknown, reply: unknown) => Promise<void>)(
      { body: { session_id: 'wrong-shape' }, headers: {} },
      reply,
    );

    expect(events).toHaveLength(0);
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      ok: false,
      error: 'missing sessionId',
    });
  });
});
