import type { AgentEvent } from '@shared/types';
import { describe, expect, it, vi } from 'vitest';
import { buildCodexHookRoutes } from '../hook-routes';

function replyStub(): { code: ReturnType<typeof vi.fn> } {
  const send = vi.fn();
  const code = vi.fn(() => ({ send }));
  return { code };
}

describe('codex hook routes', () => {
  it('tags hook origin and forwards the external parent pid header', async () => {
    const events: AgentEvent[] = [];
    const route = buildCodexHookRoutes((ev) => events.push(ev)).find(
      (r) => r.url === '/hook/codex/sessionstart',
    );
    expect(route).toBeTruthy();

    await (route?.handler as (req: unknown, reply: unknown) => Promise<void>)(
      {
        body: {
          session_id: 'codex-external',
          cwd: '/repo',
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
  });
});
