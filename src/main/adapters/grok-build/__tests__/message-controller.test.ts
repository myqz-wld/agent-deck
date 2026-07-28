import { beforeEach, describe, expect, it, vi } from 'vitest';

const guard = vi.hoisted(() => vi.fn());

vi.mock('@main/session/hand-off/ingress-guard', () => ({
  guardHandOffSourceIngress: guard,
}));

import { GrokMessageController } from '../message-controller';

describe('GrokMessageController handoff ingress', () => {
  beforeEach(() => {
    guard.mockReset();
  });

  it.each(['send', 'enqueue', 'steer'] as const)(
    'guards %s before runtime recovery, steering, or queue mutation',
    async (kind) => {
      const dispatch = vi.fn(async () => undefined);
      const steer = vi.fn(async () => undefined);
      guard.mockReturnValue(true);
      const controller = new GrokMessageController({
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
});
