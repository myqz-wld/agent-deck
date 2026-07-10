import type { AgentEvent } from '@shared/types';
import { describe, expect, it, vi } from 'vitest';
import { buildCodexHookRoutes } from '../hook-routes';

function replyStub(): { code: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn();
  const code = vi.fn(() => ({ send }));
  return { code, send };
}

describe('codex hook routes', () => {
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
});
