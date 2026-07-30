import type { AgentEvent } from '@shared/types';
import { describe, expect, it, vi } from 'vitest';
import { CODEX_HOOK_EVENTS } from '../hook-installer';
import { buildCodexHookRoutes } from '../hook-routes';
import {
  HOOK_PROCESSING_FAILED_RESPONSE,
  INVALID_HOOK_BODY_RESPONSE,
} from '@main/hook-server/route-diagnostics';

function replyStub(): { code: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn();
  const code = vi.fn(() => ({ send }));
  return { code, send };
}

describe('Codex CLI hook routes', () => {
  it('keeps every installed event routable', () => {
    const urls = buildCodexHookRoutes(() => undefined).map((route) => route.url);
    expect(urls).toEqual(
      CODEX_HOOK_EVENTS.map((event) => `/hook/codex/${event.toLowerCase()}`),
    );
  });

  it('tags hook origin and forwards the external parent pid header', async () => {
    const events: AgentEvent[] = [];
    const desktopFilter = { shouldIgnore: vi.fn().mockResolvedValue(false) };
    const route = buildCodexHookRoutes((ev) => events.push(ev), desktopFilter).find(
      (r) => r.url === '/hook/codex/sessionstart',
    );
    expect(route).toBeTruthy();

    await (route?.handler as (req: unknown, reply: unknown) => Promise<void>)(
      {
        body: {
          session_id: 'codex-external',
          cwd: '/repo',
          transcript_path: '/tmp/transcript.jsonl',
          hook_event_name: 'SessionStart',
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
      source: 'hook',
      hookOrigin: 'cli',
      payload: {
        externalProcessPid: 12345,
      },
    });
    expect(desktopFilter.shouldIgnore).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: 'codex-external' }),
      'cli',
      12345,
    );
  });

  it('acknowledges but does not emit a verified Desktop ephemeral hook', async () => {
    const events: AgentEvent[] = [];
    const desktopFilter = { shouldIgnore: vi.fn().mockResolvedValue(true) };
    const route = buildCodexHookRoutes((ev) => events.push(ev), desktopFilter).find(
      (r) => r.url === '/hook/codex/sessionstart',
    );
    const reply = replyStub();

    await (route?.handler as (req: unknown, reply: unknown) => Promise<void>)(
      {
        body: {
          session_id: 'desktop-ephemeral',
          cwd: '/',
          transcript_path: null,
          hook_event_name: 'SessionStart',
        },
        headers: {
          'x-agent-deck-origin': 'cli',
          'x-agent-deck-parent-pid': '42396',
        },
      },
      reply,
    );

    expect(events).toHaveLength(0);
    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ ok: true, ignored: true });
  });

  it('fails open when Desktop process classification throws', async () => {
    const events: AgentEvent[] = [];
    const desktopFilter = {
      shouldIgnore: vi.fn().mockRejectedValue(new Error('process lookup failed')),
    };
    const route = buildCodexHookRoutes((ev) => events.push(ev), desktopFilter).find(
      (r) => r.url === '/hook/codex/sessionstart',
    );

    await (route?.handler as (req: unknown, reply: unknown) => Promise<void>)(
      {
        body: {
          session_id: 'preserved-on-error',
          cwd: '/repo',
          transcript_path: null,
          hook_event_name: 'SessionStart',
        },
        headers: {
          'x-agent-deck-origin': 'cli',
          'x-agent-deck-parent-pid': '12345',
        },
      },
      replyStub(),
    );

    expect(events).toHaveLength(1);
    expect(events[0].sessionId).toBe('preserved-on-error');
  });

  it('emits synthetic tool terminal events before Stop when PostToolUse is absent', async () => {
    const events: AgentEvent[] = [];
    const desktopFilter = { shouldIgnore: vi.fn().mockResolvedValue(false) };
    const openToolUseReader = {
      listForSession: vi.fn().mockReturnValue([
        {
          toolUseId: 'tool-open',
          toolName: 'Bash',
          toolInput: { command: 'sleep 10' },
        },
      ]),
    };
    const route = buildCodexHookRoutes(
      (event) => events.push(event),
      desktopFilter,
      undefined,
      openToolUseReader,
    ).find((candidate) => candidate.url === '/hook/codex/stop');

    await (route?.handler as (req: unknown, reply: unknown) => Promise<void>)(
      {
        body: {
          session_id: 'codex-terminal',
          cwd: '/repo',
          hook_event_name: 'Stop',
          last_assistant_message: 'done',
        },
        headers: {},
      },
      replyStub(),
    );

    expect(openToolUseReader.listForSession).toHaveBeenCalledWith('codex-terminal');
    expect(events.map((event) => event.kind)).toEqual([
      'tool-use-end',
      'message',
      'finished',
    ]);
    expect(events[0]).toMatchObject({
      source: 'hook',
      payload: {
        toolUseId: 'tool-open',
        status: 'aborted',
        terminalHook: 'Stop',
      },
    });
  });

  it('rejects invalid Codex CLI session identity with a stable body', async () => {
    const emit = vi.fn();
    const desktopFilter = { shouldIgnore: vi.fn() };
    const route = buildCodexHookRoutes(emit, desktopFilter)[0];
    const reply = replyStub();

    await (route.handler as (req: unknown, reply: unknown) => Promise<void>)(
      {
        body: { session_id: ['wrong-shape'], prompt: 'must not be returned' },
        headers: {},
      },
      reply,
    );

    expect(emit).not.toHaveBeenCalled();
    expect(desktopFilter.shouldIgnore).not.toHaveBeenCalled();
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith(INVALID_HOOK_BODY_RESPONSE);
  });

  it('returns a stable non-sensitive body when the event sink throws', async () => {
    const desktopFilter = { shouldIgnore: vi.fn().mockResolvedValue(false) };
    const route = buildCodexHookRoutes(() => {
      throw new Error('private Codex CLI sink detail');
    }, desktopFilter)[0];
    const reply = replyStub();

    await (route.handler as (req: unknown, reply: unknown) => Promise<void>)(
      {
        body: {
          session_id: 'codex-session',
          cwd: '/private/project',
          hook_event_name: 'SessionStart',
        },
        headers: {},
      },
      reply,
    );

    expect(reply.code).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith(HOOK_PROCESSING_FAILED_RESPONSE);
  });
});
