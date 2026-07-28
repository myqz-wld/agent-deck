import type { AgentEvent } from '@shared/types';
import { describe, expect, it, vi } from 'vitest';
import { GROK_HOOK_EVENTS } from '../hook-installer';
import { buildGrokHookRoutes } from '../hook-routes';
import {
  HOOK_PROCESSING_FAILED_RESPONSE,
  INVALID_HOOK_BODY_RESPONSE,
} from '@main/hook-server/route-diagnostics';

function replyStub(): { code: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn();
  const code = vi.fn(() => ({ send }));
  return { code, send };
}

describe('Grok Build hook routes', () => {
  it('keeps every installed event routable', () => {
    const urls = buildGrokHookRoutes(() => undefined).map((route) => route.url);
    expect(urls).toEqual(
      GROK_HOOK_EVENTS.map((event) => `/hook/grok/${event.toLowerCase()}`),
    );
  });

  it('accepts camelCase Grok Build payloads and tags external process identity', async () => {
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

  it('removes the Grok Build harness envelope before emitting a visible user message', async () => {
    const events: AgentEvent[] = [];
    const route = buildGrokHookRoutes((event) => events.push(event)).find(
      (candidate) => candidate.url === '/hook/grok/userpromptsubmit',
    );

    await (route?.handler as (request: unknown, reply: unknown) => Promise<void>)(
      {
        body: {
          sessionId: 'grok-external',
          hookEventName: 'UserPromptSubmit',
          prompt: '<user_query>\n逐段审查这个分支\n</user_query>',
        },
        headers: {},
      },
      replyStub(),
    );

    expect(events).toMatchObject([
      {
        kind: 'message',
        payload: {
          role: 'user',
          text: '逐段审查这个分支',
          rawText: '<user_query>\n逐段审查这个分支\n</user_query>',
        },
      },
    ]);
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
    expect(reply.send).toHaveBeenCalledWith(INVALID_HOOK_BODY_RESPONSE);
  });

  it('returns a stable non-sensitive body when the event sink throws', async () => {
    const route = buildGrokHookRoutes(() => {
      throw new Error('private Grok Build sink detail');
    })[0];
    const reply = replyStub();

    await (route.handler as (request: unknown, reply: unknown) => Promise<void>)(
      {
        body: {
          sessionId: 'grok-session',
          cwd: '/private/project',
          hookEventName: 'SessionStart',
        },
        headers: {},
      },
      reply,
    );

    expect(reply.code).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith(HOOK_PROCESSING_FAILED_RESPONSE);
  });
});
