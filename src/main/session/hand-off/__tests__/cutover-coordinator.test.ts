import { describe, expect, it, vi } from 'vitest';
import { HandOffCutoverCoordinator } from '../cutover-coordinator';

describe('HandOffCutoverCoordinator source ingress buffer', () => {
  it('records buffered input immediately and suppresses source replay after commit', async () => {
    const coordinator = new HandOffCutoverCoordinator();
    const lease = coordinator.tryAcquire('source')!;
    const record = vi.fn();
    const replay = vi.fn(async () => undefined);

    expect(coordinator.tryBufferInput('source', { record, replay })).toBe(true);
    expect(record).toHaveBeenCalledOnce();

    lease.commit('successor');
    lease.release();
    await Promise.resolve();
    expect(replay).not.toHaveBeenCalled();
    expect(coordinator.isActive('source')).toBe(false);
    expect(coordinator.successorFor('source')).toBe('successor');
  });

  it('replays buffered inputs to the source in order when handoff rolls back', async () => {
    const coordinator = new HandOffCutoverCoordinator();
    const lease = coordinator.tryAcquire('source')!;
    const order: string[] = [];
    coordinator.tryBufferInput('source', {
      record: () => order.push('record:first'),
      replay: async () => {
        order.push('replay:first');
      },
    });
    coordinator.tryBufferInput('source', {
      record: () => order.push('record:second'),
      replay: async () => {
        order.push('replay:second');
      },
    });

    lease.release();
    await vi.waitFor(() => expect(order).toHaveLength(4));
    expect(order).toEqual([
      'record:first',
      'record:second',
      'replay:first',
      'replay:second',
    ]);
  });

  it('removes a buffer entry when durable recording throws', async () => {
    const coordinator = new HandOffCutoverCoordinator();
    const lease = coordinator.tryAcquire('source')!;
    const replay = vi.fn(async () => undefined);

    expect(() =>
      coordinator.tryBufferInput('source', {
        record: () => {
          throw new Error('event persistence failed');
        },
        replay,
      }),
    ).toThrow('event persistence failed');

    lease.release();
    await Promise.resolve();
    expect(replay).not.toHaveBeenCalled();
  });

  it('resolves chained handoffs to the latest successor', () => {
    const coordinator = new HandOffCutoverCoordinator();
    const first = coordinator.tryAcquire('source-a')!;
    first.commit('source-b');
    first.release();
    const second = coordinator.tryAcquire('source-b')!;
    second.commit('source-c');
    second.release();

    expect(coordinator.successorFor('source-a')).toBe('source-c');
    expect(coordinator.successorFor('source-b')).toBe('source-c');
  });

  it('rebuilds chained routing from durable aliases after in-memory state is lost', () => {
    const aliases = new Map([
      ['source-a', 'source-b'],
      ['source-b', 'source-c'],
    ]);
    const restarted = new HandOffCutoverCoordinator(
      (sourceSessionId) => aliases.get(sourceSessionId) ?? null,
    );

    expect(restarted.successorFor('source-a')).toBe('source-c');
    expect(restarted.successorFor('source-b')).toBe('source-c');
  });

  it('resolves old anchors through handoff chains longer than the former 16-hop limit', () => {
    const aliases = new Map<string, string>();
    for (let index = 0; index < 64; index += 1) {
      aliases.set(`source-${index}`, `source-${index + 1}`);
    }
    const restarted = new HandOffCutoverCoordinator(
      (sourceSessionId) => aliases.get(sourceSessionId) ?? null,
    );

    expect(restarted.successorFor('source-0')).toBe('source-64');
  });

  it('keeps revoked ingress sealed until release and never replays terminally abandoned input', async () => {
    const coordinator = new HandOffCutoverCoordinator();
    const lease = coordinator.tryAcquire('source')!;
    const replay = vi.fn(async () => undefined);
    coordinator.tryBufferInput('source', { record: vi.fn(), replay });

    expect(coordinator.revokeSource('source')).toBe(true);
    expect(lease.isHeld()).toBe(true);
    expect(lease.canCommit()).toBe(false);
    expect(lease.commit('successor')).toBe(false);
    expect(() => coordinator.tryBufferInput('source', {
      record: vi.fn(),
      replay: vi.fn(async () => undefined),
    })).toThrow(/closed or unavailable/);

    lease.release();
    await Promise.resolve();
    expect(replay).not.toHaveBeenCalled();
    expect(coordinator.isActive('source')).toBe(false);
    expect(coordinator.successorFor('source')).toBeNull();
  });

  it('stops an in-progress rollback replay when the source becomes terminal', async () => {
    const coordinator = new HandOffCutoverCoordinator();
    const lease = coordinator.tryAcquire('source')!;
    let finishFirst!: () => void;
    const firstReplay = vi.fn(
      () => new Promise<void>((resolve) => {
        finishFirst = resolve;
      }),
    );
    const secondReplay = vi.fn(async () => undefined);
    coordinator.tryBufferInput('source', { record: vi.fn(), replay: firstReplay });
    coordinator.tryBufferInput('source', { record: vi.fn(), replay: secondReplay });

    lease.release();
    await vi.waitFor(() => expect(firstReplay).toHaveBeenCalledOnce());
    expect(coordinator.revokeSource('source')).toBe(true);
    finishFirst();
    await vi.waitFor(() => expect(coordinator.isActive('source')).toBe(false));

    expect(secondReplay).not.toHaveBeenCalled();
  });

  it('moves an active gate on rename and replays accepted input against the surviving id', async () => {
    const coordinator = new HandOffCutoverCoordinator();
    const lease = coordinator.tryAcquire('source-old')!;
    const record = vi.fn();
    const replay = vi.fn(async () => undefined);
    coordinator.tryBufferInput('source-old', { record, replay });

    expect(coordinator.renameSource('source-old', 'source-new')).toBe(true);
    expect(lease.sourceSessionId).toBe('source-new');
    expect(lease.canCommit()).toBe(false);
    expect(coordinator.isActive('source-old')).toBe(false);
    expect(coordinator.isActive('source-new')).toBe(true);

    lease.release();
    await vi.waitFor(() => expect(replay).toHaveBeenCalledWith('source-new'));
    expect(record).toHaveBeenCalledWith('source-old');
    expect(coordinator.isActive('source-new')).toBe(false);
  });

  it('replays reversible abort input but keeps terminally sealed ids unavailable', async () => {
    const coordinator = new HandOffCutoverCoordinator();
    const lease = coordinator.tryAcquire('source')!;
    const replay = vi.fn(async () => undefined);
    coordinator.tryBufferInput('source', { record: vi.fn(), replay });

    expect(coordinator.abortSource('source')).toBe(true);
    expect(lease.canCommit()).toBe(false);
    lease.release();
    await vi.waitFor(() => expect(replay).toHaveBeenCalledWith('source'));

    expect(coordinator.revokeSource('source')).toBe(true);
    expect(coordinator.tryAcquire('source')).toBeNull();
    expect(coordinator.restoreSource('source')).toBe(true);
    const reopened = coordinator.tryAcquire('source');
    expect(reopened).not.toBeNull();
    reopened?.release();
  });

  it('drops the in-memory successor redirect when the user explicitly reactivates the source', () => {
    const coordinator = new HandOffCutoverCoordinator(() => null);
    const lease = coordinator.tryAcquire('source')!;
    expect(lease.commit('successor')).toBe(true);
    lease.release();
    coordinator.revokeSource('source');

    expect(coordinator.successorFor('source')).toBe('successor');
    coordinator.reactivateSource('source');
    expect(coordinator.successorFor('source')).toBeNull();
    expect(coordinator.tryAcquire('source')).not.toBeNull();
  });

  it('drops a stale destination redirect when a source is renamed onto that identity', () => {
    const coordinator = new HandOffCutoverCoordinator(() => null);
    const targetLease = coordinator.tryAcquire('renamed-source')!;
    expect(targetLease.commit('old-successor')).toBe(true);
    targetLease.release();
    expect(coordinator.successorFor('renamed-source')).toBe('old-successor');

    coordinator.renameSource('source-without-redirect', 'renamed-source');

    expect(coordinator.successorFor('renamed-source')).toBeNull();
  });

  it.each(['archive', 'rename'] as const)(
    'keeps terminal discard monotonic across a later %s signal',
    async (laterSignal) => {
      const coordinator = new HandOffCutoverCoordinator();
      const lease = coordinator.tryAcquire('source')!;
      const replay = vi.fn(async () => undefined);
      coordinator.tryBufferInput('source', { record: vi.fn(), replay });

      coordinator.revokeSource('source');
      if (laterSignal === 'archive') coordinator.abortSource('source');
      else coordinator.renameSource('source', 'renamed-source');
      lease.release();
      await Promise.resolve();

      expect(replay).not.toHaveBeenCalled();
      expect(coordinator.isActive('source')).toBe(false);
      expect(coordinator.isActive('renamed-source')).toBe(false);
    },
  );
});
