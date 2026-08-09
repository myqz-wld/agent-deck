import { describe, expect, it, vi } from 'vitest';
import { FeishuSourceRegistry } from './source-registry';
import type { FeishuProviderSource } from './types';

function source(eventId: string): FeishuProviderSource {
  return {
    eventId,
    chatId: `chat-${eventId}`,
    messageId: `message-${eventId}`,
    kind: 'message',
    occurredAt: 100,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, reject, resolve };
}

describe('bounded in-memory Feishu source registry', () => {
  it('fails closed before inserting a new unique event at capacity', async () => {
    const registry = new FeishuSourceRegistry(2);
    const firstGate = deferred<void>();
    const secondGate = deferred<void>();
    const first = registry.within(source('one'), () => firstGate.promise);
    const second = registry.within(source('two'), () => secondGate.promise);
    const overflowWork = vi.fn(async () => undefined);

    await expect(registry.within(source('three'), overflowWork)).rejects.toMatchObject({
      code: 'event_in_progress',
      retryable: true,
    });
    expect(overflowWork).not.toHaveBeenCalled();
    expect(registry.size()).toBe(2);
    expect(registry.get('three')).toBeNull();

    firstGate.resolve();
    await first;
    expect(registry.size()).toBe(1);
    await expect(registry.within(source('three'), async () => 'recovered')).resolves.toBe('recovered');
    expect(registry.size()).toBe(1);
    secondGate.resolve();
    await second;
    expect(registry.size()).toBe(0);
  });

  it('allows exact same-event references at capacity and releases only the last one', async () => {
    const registry = new FeishuSourceRegistry(1);
    const outerGate = deferred<void>();
    const innerGate = deferred<void>();
    const original = source('shared');
    const outer = registry.within(original, () => outerGate.promise);
    const inner = registry.within({ ...original }, () => innerGate.promise);
    expect(registry.size()).toBe(1);

    innerGate.resolve();
    await inner;
    expect(registry.get('shared')).toEqual(original);
    expect(registry.size()).toBe(1);

    outerGate.resolve();
    await outer;
    expect(registry.get('shared')).toBeNull();
    expect(registry.size()).toBe(0);
  });

  it('keeps the original reference intact on identity mismatch and cleans up thrown work', async () => {
    const registry = new FeishuSourceRegistry(1);
    const gate = deferred<void>();
    const original = source('shared');
    const pending = registry.within(original, () => gate.promise);
    await expect(registry.within({ ...original, chatId: 'other-chat' }, async () => undefined))
      .rejects.toMatchObject({ code: 'event_identity_mismatch' });
    expect(registry.get('shared')).toEqual(original);

    gate.resolve();
    await pending;
    await expect(registry.within(source('throws'), async () => {
      throw new Error('work failure');
    })).rejects.toThrow('work failure');
    expect(registry.size()).toBe(0);
    await expect(registry.within(source('after-throw'), async () => 7)).resolves.toBe(7);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER])(
    'rejects invalid active-event ceiling %s',
    (maximum) => {
      expect(() => new FeishuSourceRegistry(maximum)).toThrow(
        expect.objectContaining({ code: 'invalid_configuration' }),
      );
    },
  );
});
