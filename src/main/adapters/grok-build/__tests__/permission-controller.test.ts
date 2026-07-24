import { describe, expect, it, vi } from 'vitest';

import type { GrokRuntime } from '../runtime-types';
import { GrokPermissionController } from '../permission-controller';

function runtime(): GrokRuntime {
  return {
    applicationSessionId: 'app-session',
    closed: false,
    pendingPermissions: new Map(),
  } as GrokRuntime;
}

const request = {
  sessionId: 'native-session',
  toolCall: {
    toolCallId: 'tool-1',
    title: 'Edit',
    rawInput: { path: '/repo/a.ts' },
  },
  options: [
    { kind: 'allow_once' as const, name: 'Allow', optionId: 'allow' },
    { kind: 'allow_always' as const, name: 'Always allow', optionId: 'always' },
    { kind: 'reject_once' as const, name: 'Reject', optionId: 'reject' },
  ],
};

describe('GrokPermissionController', () => {
  it('maps a user decision back to the matching ACP option', async () => {
    const emit = vi.fn();
    const controller = new GrokPermissionController(10_000, emit);
    const active = runtime();
    const pending = controller.handle(active, request, new AbortController().signal);
    const [permission] = controller.list(active);

    controller.respond(active, permission.requestId, { decision: 'allow' });

    await expect(pending).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow' },
    });
    expect(controller.list(active)).toEqual([]);
  });

  it('selects the persistent ACP option only for an explicit always-allow response', async () => {
    const controller = new GrokPermissionController(10_000, vi.fn());
    const active = runtime();
    const pending = controller.handle(active, request, new AbortController().signal);
    const [permission] = controller.list(active);

    controller.respond(active, permission.requestId, {
      decision: 'allow',
      updatedPermissions: permission.suggestions,
    });

    await expect(pending).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'always' },
    });
  });

  it('emits a cancellation event when interruption clears a pending request', async () => {
    const emit = vi.fn();
    const controller = new GrokPermissionController(10_000, emit);
    const active = runtime();
    const pending = controller.handle(active, request, new AbortController().signal);
    const [permission] = controller.list(active);

    controller.cancel(active);

    await expect(pending).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
    expect(emit).toHaveBeenLastCalledWith(
      'app-session',
      'waiting-for-user',
      { type: 'permission-cancelled', requestId: permission.requestId },
    );
  });
});
