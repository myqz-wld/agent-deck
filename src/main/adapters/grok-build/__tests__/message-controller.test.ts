import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GrokMessageController } from '../message-controller';
import { createTestGrokBridgeRuntimeHost } from './bridge-runtime-fixture';

const guard = vi.fn();
const pending = vi.fn();

function runtimeHost() {
  return createTestGrokBridgeRuntimeHost({
    guardHandOffSourceIngress: guard,
    hasPendingWorktreeTransition: pending,
  });
}

describe('GrokMessageController handoff ingress', () => {
  beforeEach(() => {
    guard.mockReset();
    pending.mockReset();
    pending.mockReturnValue(false);
  });

  it.each(['send', 'enqueue', 'steer'] as const)(
    'guards %s before runtime recovery, steering, or queue mutation',
    async (kind) => {
      const dispatch = vi.fn(async () => undefined);
      const steer = vi.fn(async () => undefined);
      guard.mockReturnValue(true);
      const controller = new GrokMessageController({
        runtimeHost: runtimeHost(),
        emit: vi.fn(),
        dispatch,
        steer,
      });

      if (kind === 'send') await controller.sendMessage('session', 'hello');
      if (kind === 'enqueue') await controller.enqueueMessage('session', 'hello');
      if (kind === 'steer') await controller.steerTurn('session', 'hello');

      expect(guard).toHaveBeenCalledOnce();
      expect(dispatch).not.toHaveBeenCalled();
      expect(steer).not.toHaveBeenCalled();
    },
  );

  it('replays a cutover-buffered steer as a bounded queued message', async () => {
    const dispatch = vi.fn(async () => undefined);
    let replay!: (sourceSessionId: string) => Promise<void>;
    guard.mockImplementation((input: { replay: typeof replay }) => {
      replay = input.replay;
      return true;
    });
    const controller = new GrokMessageController({
      runtimeHost: runtimeHost(),
      emit: vi.fn(),
      dispatch,
      steer: vi.fn(async () => undefined),
    });

    await controller.steerTurn('session', 'hello');
    await replay('session');

    expect(dispatch).toHaveBeenCalledWith(
      'session',
      'hello',
      undefined,
      undefined,
      true,
    );
  });

  it.each(['send', 'steer'] as const)(
    'forces %s into the queue while worktree preflight owns the turn',
    async (kind) => {
      const dispatch = vi.fn(async () => undefined);
      const steer = vi.fn(async () => undefined);
      pending.mockImplementation((sessionId) => sessionId === 'session-preflight');
      const controller = new GrokMessageController({
        runtimeHost: runtimeHost(),
        emit: vi.fn(),
        dispatch,
        steer,
      });
      if (kind === 'send') {
        await controller.sendMessage('session-preflight', 'hello');
      } else {
        await controller.steerTurn('session-preflight', 'hello');
      }
      expect(dispatch).toHaveBeenCalledWith(
        'session-preflight',
        'hello',
        undefined,
        undefined,
        true,
      );
      expect(steer).not.toHaveBeenCalled();
    },
  );
});
