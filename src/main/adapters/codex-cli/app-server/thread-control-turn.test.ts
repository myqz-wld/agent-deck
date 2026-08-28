import { describe, expect, it, vi } from 'vitest';
import type {
  CodexAppServerNotification,
  CodexAppServerStreamEvent,
} from './protocol';
import { streamCodexThreadControlTurn } from './thread-control-turn';

describe('Codex app-server control turn', () => {
  it('subscribes before compact and closes on the matching terminal turn', async () => {
    let listener: ((notification: CodexAppServerNotification) => void) | null = null;
    const notifications: CodexAppServerNotification[] = [
      { method: 'turn/started', params: { threadId: 'thread-a', turn: { id: 'turn-a' } } },
      {
        method: 'item/started',
        params: {
          threadId: 'thread-a', turnId: 'turn-a',
          item: { id: 'compact-a', type: 'contextCompaction' },
        },
      },
      {
        method: 'turn/completed',
        params: { threadId: 'thread-a', turn: { id: 'turn-a', status: 'completed' } },
      },
    ];
    const request = vi.fn(async () => {
      for (const notification of notifications) listener?.(notification);
      return {};
    });
    const activeTurnIds: Array<string | null> = [];
    const client = {
      generation: 3,
      isProcessAlive: true,
      acceptsNotificationForGeneration: (generation: number) => generation === 3,
      subscribe: (next: typeof listener) => {
        listener = next;
        return () => { listener = null; };
      },
      request,
    };
    const events: CodexAppServerStreamEvent[] = [];
    for await (const event of streamCodexThreadControlTurn({
      client: client as never,
      method: 'thread/compact/start',
      threadId: 'thread-a',
      runtimeIdentity: {
        observeNotification: vi.fn(),
        snapshot: () => null,
      } as never,
      setActiveTurnId: (turnId) => activeTurnIds.push(turnId),
    })) events.push(event);

    expect(request).toHaveBeenCalledWith('thread/compact/start', { threadId: 'thread-a' });
    expect(events).toHaveLength(3);
    expect(activeTurnIds).toEqual(['turn-a', null, null]);
  });
});
