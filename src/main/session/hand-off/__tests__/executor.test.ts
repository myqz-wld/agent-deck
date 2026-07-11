import { describe, expect, it, vi } from 'vitest';
import type { CreateSessionOptions } from '@main/adapters/types';
import type { SessionRecord } from '@shared/types';
import type { TrustedContinuationInitialTurn } from '../../continuation-context/initial-turn';
import { executePreparedHandOff, HandOffExecutionError } from '../executor';

const source: SessionRecord = {
  id: 'source', agentId: 'claude-code', cwd: '/repo', title: 'source', source: 'sdk',
  lifecycle: 'active', activity: 'idle', startedAt: 1, lastEventAt: 1,
  endedAt: null, archivedAt: null,
};
const target = { agentId: 'codex-cli', cwd: '/repo' } as CreateSessionOptions;
const turn = { kind: 'trusted-continuation' } as TrustedContinuationInitialTurn;
const sourcePrecondition = {
  eventRevision: 7,
  rebuildAfterRevision: 2,
  runtimeFingerprint: 'source-runtime-v1',
};

function matchingSource() {
  return true;
}

describe('executePreparedHandOff', () => {
  it('propagates successor startup failure before cutover, transfer, or source finalization', async () => {
    const sourcePreconditionMatches = vi.fn();
    const transferResources = vi.fn();
    const closeSuccessor = vi.fn();
    const finalizeSource = vi.fn();

    await expect(
      executePreparedHandOff({
        source,
        sourcePrecondition,
        sourcePreconditionMatches,
        target,
        turn,
        createSuccessor: vi.fn(async () => {
          throw new Error('Codex startup failed before thread.started');
        }),
        transferResources,
        resourceTransferFailed: vi.fn(),
        closeSuccessor,
        finalizeSource,
      }),
    ).rejects.toThrow(/Codex startup failed/);

    expect(sourcePreconditionMatches).not.toHaveBeenCalled();
    expect(transferResources).not.toHaveBeenCalled();
    expect(closeSuccessor).not.toHaveBeenCalled();
    expect(finalizeSource).not.toHaveBeenCalled();
  });

  it('creates, transfers, then finalizes in strict order', async () => {
    const order: string[] = [];
    const result = await executePreparedHandOff({
      source,
      sourcePrecondition,
      sourcePreconditionMatches: matchingSource,
      target,
      turn,
      createSuccessor: vi.fn(async () => { order.push('create'); return 'successor'; }),
      transferResources: vi.fn(() => { order.push('transfer'); return { failed: false }; }),
      resourceTransferFailed: (value: { failed: boolean }) => value.failed,
      closeSuccessor: vi.fn(async () => { order.push('cleanup'); }),
      finalizeSource: vi.fn(async () => { order.push('finalize'); return 'closed'; }),
    });

    expect(order).toEqual(['create', 'transfer', 'finalize']);
    expect(result).toEqual({
      successorSessionId: 'successor',
      resourceTransfer: { failed: false },
      sourceFinalization: { ok: true, value: 'closed' },
    });
  });

  it('closes an orphan on mandatory-transfer failure and never finalizes the source', async () => {
    const closeSuccessor = vi.fn(async () => undefined);
    const finalizeSource = vi.fn();
    const work = executePreparedHandOff({
      source,
      sourcePrecondition,
      sourcePreconditionMatches: matchingSource,
      target,
      turn,
      createSuccessor: vi.fn(async () => 'orphan'),
      transferResources: vi.fn(() => ({ failed: true })),
      resourceTransferFailed: (value: { failed: boolean }) => value.failed,
      closeSuccessor,
      finalizeSource,
    });

    await expect(work).rejects.toMatchObject({
      name: 'HandOffExecutionError',
      stage: 'transfer',
      successorSessionId: 'orphan',
      successorCleanup: 'ok',
      resourceTransfer: { failed: true },
      transferError: null,
    } satisfies Partial<HandOffExecutionError<{ failed: boolean }>>);
    expect(closeSuccessor).toHaveBeenCalledWith('orphan');
    expect(finalizeSource).not.toHaveBeenCalled();
  });

  it('closes an orphan and preserves explicit detail when resource transfer throws', async () => {
    const closeSuccessor = vi.fn(async () => undefined);
    const finalizeSource = vi.fn();
    const work = executePreparedHandOff({
      source,
      sourcePrecondition,
      sourcePreconditionMatches: matchingSource,
      target,
      turn,
      createSuccessor: vi.fn(async () => 'orphan-after-throw'),
      transferResources: vi.fn(() => {
        throw new Error('transfer transaction aborted');
      }),
      resourceTransferFailed: (value: { failed: boolean }) => value.failed,
      closeSuccessor,
      finalizeSource,
    });

    await expect(work).rejects.toMatchObject({
      name: 'HandOffExecutionError',
      stage: 'transfer',
      successorSessionId: 'orphan-after-throw',
      successorCleanup: 'ok',
      resourceTransfer: null,
      transferError: 'transfer transaction aborted',
    } satisfies Partial<HandOffExecutionError<{ failed: boolean }>>);
    expect(closeSuccessor).toHaveBeenCalledWith('orphan-after-throw');
    expect(finalizeSource).not.toHaveBeenCalled();
  });

  it('returns a source-finalization failure without invalidating the transferred successor', async () => {
    const closeSuccessor = vi.fn();
    const result = await executePreparedHandOff({
      source,
      sourcePrecondition,
      sourcePreconditionMatches: matchingSource,
      target,
      turn,
      createSuccessor: vi.fn(async () => 'successor'),
      transferResources: vi.fn(() => ({ failed: false })),
      resourceTransferFailed: (value: { failed: boolean }) => value.failed,
      closeSuccessor,
      finalizeSource: vi.fn(async () => { throw new Error('source close failed'); }),
    });

    expect(result.sourceFinalization).toEqual({ ok: false, error: 'source close failed' });
    expect(closeSuccessor).not.toHaveBeenCalled();
  });

  it.each([
    ['revision', { eventRevision: 8, rebuildAfterRevision: 2, runtimeFingerprint: 'source-runtime-v1' }],
    ['rebuild epoch', { eventRevision: 7, rebuildAfterRevision: 3, runtimeFingerprint: 'source-runtime-v1' }],
    ['runtime', { eventRevision: 7, rebuildAfterRevision: 2, runtimeFingerprint: 'source-runtime-v2' }],
  ])('closes the orphan and moves no resources when %s drifts during successor creation', async (
    _kind,
    current,
  ) => {
    let finishCreate!: (sessionId: string) => void;
    let signalCreateStarted!: () => void;
    const createStarted = new Promise<void>((resolve) => {
      signalCreateStarted = resolve;
    });
    const currentState = { ...sourcePrecondition };
    const closeSuccessor = vi.fn(async () => undefined);
    const transferResources = vi.fn(() => ({ failed: false }));
    const finalizeSource = vi.fn();
    const work = executePreparedHandOff({
      source,
      sourcePrecondition,
      sourcePreconditionMatches: ({ expected }) =>
        currentState.eventRevision === expected.eventRevision &&
        currentState.rebuildAfterRevision === expected.rebuildAfterRevision &&
        currentState.runtimeFingerprint === expected.runtimeFingerprint,
      target,
      turn,
      createSuccessor: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            finishCreate = resolve;
            signalCreateStarted();
          }),
      ),
      transferResources,
      resourceTransferFailed: (value: { failed: boolean }) => value.failed,
      closeSuccessor,
      finalizeSource,
    });

    await createStarted;
    Object.assign(currentState, current);
    finishCreate('stale-orphan');

    await expect(work).rejects.toMatchObject({
      name: 'HandOffExecutionError',
      stage: 'cutover',
      successorSessionId: 'stale-orphan',
      successorCleanup: 'ok',
      resourceTransfer: null,
    });
    expect(closeSuccessor).toHaveBeenCalledWith('stale-orphan');
    expect(transferResources).not.toHaveBeenCalled();
    expect(finalizeSource).not.toHaveBeenCalled();
  });
});
