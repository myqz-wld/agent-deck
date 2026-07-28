import { describe, expect, it, vi } from 'vitest';

import {
  HOOK_PROCESSING_FAILED_RESPONSE,
  INVALID_HOOK_BODY_RESPONSE,
} from '@main/hook-server/route-diagnostics';
import { buildHookRoutes } from '../hook-routes';

function replyStub(): {
  code: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn();
  const code = vi.fn(() => ({ send }));
  return { code, send };
}

describe('Claude Code hook routes', () => {
  it('rejects non-string and blank session identity with a stable body', async () => {
    const emit = vi.fn();
    const route = buildHookRoutes(emit)[0];
    const reply = replyStub();

    await (route.handler as (request: unknown, reply: unknown) => Promise<void>)(
      {
        body: { session_id: 42, prompt: 'must not be returned' },
        headers: {},
      },
      reply,
    );

    expect(emit).not.toHaveBeenCalled();
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith(INVALID_HOOK_BODY_RESPONSE);
  });

  it('returns a stable non-sensitive body when the event sink throws', async () => {
    const route = buildHookRoutes(() => {
      throw new Error('private sink detail');
    }).find((candidate) => candidate.url === '/hook/sessionstart');
    const reply = replyStub();

    await (route?.handler as (request: unknown, reply: unknown) => Promise<void>)(
      {
        body: {
          session_id: 'claude-session',
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
