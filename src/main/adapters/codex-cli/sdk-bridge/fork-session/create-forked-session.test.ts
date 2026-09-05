import { describe, expect, it, vi } from 'vitest';
import { extractAttachmentPaths } from '../input-pack';
import { createCodexForkedSession, type CodexForkFaultPhase } from './create-forked-session';
import {
  assertChildFullyRemoved,
  assertSourceUntouched,
  CHILD_ID,
  makeClient,
  makeHarness,
  SOURCE_APP_ID,
  SOURCE_NATIVE_ID,
} from './create-forked-session-fixture';
describe('Codex native fork lifecycle', () => {
  it('reads only on the caller client and runs terminal-prefix child setup on the target client', async () => {
    const h = makeHarness();
    const handle = await createCodexForkedSession(h.source, h.target, h.deps);
    const tempId = h.allocatedTempId();

    expect(handle.sessionId).toBe(CHILD_ID);
    expect(h.sourceClient.readThread).toHaveBeenCalledWith(SOURCE_NATIVE_ID);
    expect(h.sourceClient.forkThread).not.toHaveBeenCalled();
    expect(h.sourceClient.startThreadEager).not.toHaveBeenCalled();
    expect(h.sourceClient.injectThreadItems).not.toHaveBeenCalled();
    expect(h.sourceClient.deleteThread).not.toHaveBeenCalled();
    expect(h.sourceClient.adoptThread).not.toHaveBeenCalled();

    expect(h.targetClient.readThread).not.toHaveBeenCalled();
    expect(h.targetClient.forkThread).toHaveBeenCalledWith(
      SOURCE_NATIVE_ID,
      'terminal-turn',
      h.runtime.threadOptions,
    );
    expect(h.targetClient.startThreadEager).not.toHaveBeenCalled();
    expect(h.targetClient.adoptThread).toHaveBeenCalledWith(
      CHILD_ID,
      h.runtime.threadOptions,
      expect.objectContaining({ thread: expect.objectContaining({ id: CHILD_ID }) }),
    );
    expect(h.targetClient.injectThreadItems).toHaveBeenCalledWith(
      CHILD_ID,
      [expect.objectContaining({ type: 'message', role: 'developer' })],
    );
    const reset = JSON.stringify(vi.mocked(h.targetClient.injectThreadItems).mock.calls[0][1]);
    expect(reset).toContain('historical context only');
    expect(reset).toContain('superseded for this child');
    expect(reset).toContain('complete target instructions');

    expect(h.sessions.has(tempId)).toBe(false);
    expect(h.sessions.get(CHILD_ID)?.thread).toBe(h.attachedThread);
    expect(h.clients.has(tempId)).toBe(false);
    expect(h.clients.get(CHILD_ID)).toBe(h.targetClient);
    expect(h.tokenOwner('target-token')).toBe(CHILD_ID);
    expect(h.claims.has(tempId)).toBe(false);
    expect(h.claims.has(CHILD_ID)).toBe(true);
    expect(h.appRows.has(tempId)).toBe(false);
    expect(h.appRows.has(CHILD_ID)).toBe(true);
    expect(h.events.find((event) => event.kind === 'session-start')?.payload).toMatchObject({
      initialSpawnLink: { parentSessionId: SOURCE_APP_ID, depth: 1 },
    });
    expect(h.onRegistered).toHaveBeenCalledWith(tempId);
    expect(h.deps.persistTargetFields).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: tempId,
        approvalPolicy: 'never',
      }),
    );
    expect(h.ops).toEqual(expect.arrayContaining([
      `emit:start:${tempId}`,
      `rename:${tempId}:${CHILD_ID}`,
      `emit:user:${CHILD_ID}:token=${CHILD_ID}`,
    ]));
    expect(h.ops.indexOf(`rename:${tempId}:${CHILD_ID}`))
      .toBeLessThan(h.ops.indexOf(`emit:user:${CHILD_ID}:token=${CHILD_ID}`));

    const pending = h.sessions.get(CHILD_ID)?.pendingTurns.at(0)?.input;
    expect(pending).toMatchObject({ type: 'app-server-input' });
    const serialized = JSON.stringify(pending);
    expect(serialized).toContain('current source request');
    expect(serialized).toContain('/uploads/source.png');
    expect(serialized).toContain('skill://review');
    expect(serialized).toContain('child delegation boundary');
    expect(serialized).toContain('delegated task');
    expect(serialized).not.toContain('unfinished assistant');
    expect(serialized).not.toContain('source reasoning');
    expect(serialized).not.toContain('spawn_session');
    expect(extractAttachmentPaths(pending!)).toEqual([]);

    expect(h.threadLoop.runTurnLoop).not.toHaveBeenCalled();
    h.runScheduledTurn();
    await Promise.resolve();
    expect(h.threadLoop.runTurnLoop).toHaveBeenCalledWith(
      h.sessions.get(CHILD_ID),
      CHILD_ID,
    );
    expect(vi.mocked(h.targetClient.injectThreadItems).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(h.threadLoop.runTurnLoop).mock.invocationCallOrder[0]);

    await handle.discard();
    await handle.discard();
    expect(h.targetClient.deleteThread).toHaveBeenCalledTimes(1);
    expect(h.targetClient.deleteThread).toHaveBeenCalledWith(CHILD_ID);
    assertChildFullyRemoved(h, tempId);
    assertSourceUntouched(h);
  });

  it('uses explicit zero-prefix thread/start and still replays the first-turn UserInput values', async () => {
    const h = makeHarness({ zeroPrefix: true });
    const handle = await createCodexForkedSession(h.source, h.target, h.deps);

    expect(handle.sessionId).toBe(CHILD_ID);
    expect(h.targetClient.forkThread).not.toHaveBeenCalled();
    expect(h.targetClient.startThreadEager).toHaveBeenCalledWith(h.runtime.threadOptions);
    const pending = h.sessions.get(CHILD_ID)?.pendingTurns.at(0)?.input;
    expect(JSON.stringify(pending)).toContain('current source request');
    expect(JSON.stringify(pending)).toContain('delegated task');
    expect(h.sourceClient.readThread).toHaveBeenCalledTimes(1);
    assertSourceUntouched(h);
  });

  it('keeps a registered child when its delayed first turn fails', async () => {
    const h = makeHarness({ turnFailure: true });
    const handle = await createCodexForkedSession(h.source, h.target, h.deps);
    h.runScheduledTurn();
    await Promise.resolve();
    await Promise.resolve();

    expect(handle.sessionId).toBe(CHILD_ID);
    expect(h.sessions.has(CHILD_ID)).toBe(true);
    expect(h.clients.get(CHILD_ID)).toBe(h.targetClient);
    expect(h.appRows.has(CHILD_ID)).toBe(true);
    expect(h.targetClient.deleteThread).not.toHaveBeenCalled();
    assertSourceUntouched(h);
  });

  it('keeps replayed source images outside child cleanup ownership', async () => {
    const h = makeHarness({ targetAttachmentPath: '/uploads/child.png' });
    const handle = await createCodexForkedSession(h.source, h.target, h.deps);
    const pending = h.sessions.get(CHILD_ID)?.pendingTurns.at(0)?.input;

    expect(JSON.stringify(pending)).toContain('/uploads/source.png');
    expect(JSON.stringify(pending)).toContain('/uploads/child.png');
    expect(extractAttachmentPaths(pending!)).toEqual(['/uploads/child.png']);

    await handle.discard();
    assertSourceUntouched(h);
  });

  it('reopens a target-owned cleanup client when close disposed the child before discard', async () => {
    const h = makeHarness();
    const handle = await createCodexForkedSession(h.source, h.target, h.deps);
    const tempId = h.allocatedTempId();
    const cleanupClient = makeClient({});
    Object.defineProperty(h.targetClient, 'isDisposed', { value: true });
    Object.assign(h.targetClient, {
      createSiblingClient: vi.fn(() => cleanupClient),
    });

    // Mirrors completeSpawnTeamMembership(): normal close removes app/runtime ownership first,
    // then spawn.ts invokes the retained native-fork discard handle.
    h.sessions.delete(CHILD_ID);
    h.clients.delete(CHILD_ID);
    h.appRows.delete(CHILD_ID);
    h.claims.delete(CHILD_ID);
    h.releaseTargetToken(CHILD_ID);

    await handle.discard();

    expect(h.targetClient.deleteThread).not.toHaveBeenCalled();
    expect(h.targetClient.createSiblingClient).toHaveBeenCalledTimes(1);
    expect(cleanupClient.deleteThread).toHaveBeenCalledWith(CHILD_ID);
    expect(cleanupClient.dispose).toHaveBeenCalledTimes(1);
    assertChildFullyRemoved(h, tempId);
    assertSourceUntouched(h);
  });

  it('attempts every cleanup phase and rejects an idempotent incomplete discard', async () => {
    const h = makeHarness();
    const handle = await createCodexForkedSession(h.source, h.target, h.deps);
    vi.mocked(h.targetClient.deleteThread).mockRejectedValueOnce(
      new Error('native delete failed'),
    );
    vi.mocked(h.deps.lifecycle.deleteSession).mockRejectedValueOnce(
      new Error('application delete failed'),
    );
    h.deps.lifecycle.releaseClaim = vi.fn(() => {
      throw new Error('claim release failed');
    });
    h.deps.lifecycle.releaseToken = vi.fn(() => {
      throw new Error('token release failed');
    });
    vi.mocked(h.targetClient.dispose).mockImplementationOnce(() => {
      throw new Error('client dispose failed');
    });

    await expect(handle.discard()).rejects.toThrow(/discard incomplete/);
    await expect(handle.discard()).rejects.toThrow(/discard incomplete/);

    expect(h.targetClient.deleteThread).toHaveBeenCalledTimes(1);
    expect(h.deps.lifecycle.deleteSession).toHaveBeenCalled();
    expect(h.deps.lifecycle.releaseClaim).toHaveBeenCalled();
    expect(h.deps.lifecycle.releaseToken).toHaveBeenCalled();
    expect(h.targetClient.dispose).toHaveBeenCalledTimes(1);
    assertSourceUntouched(h);
  });

  it('preserves both creation and cleanup failures', async () => {
    const h = makeHarness({ faultPhase: 'after-native-creation' });
    vi.mocked(h.targetClient.deleteThread).mockRejectedValueOnce(
      new Error('native delete failed'),
    );

    let thrown: unknown;
    try {
      await createCodexForkedSession(h.source, h.target, h.deps);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toHaveLength(2);
    assertSourceUntouched(h);
  });

  it.each([
    'before-native-creation',
    'after-native-creation',
    'after-temp-registration',
    'after-canonical-rename',
  ] satisfies CodexForkFaultPhase[])(
    'fully rolls back %s without touching the source',
    async (faultPhase) => {
      const h = makeHarness({ faultPhase });
      await expect(
        createCodexForkedSession(h.source, h.target, h.deps),
      ).rejects.toThrow(`fault:${faultPhase}`);
      const tempId = h.allocatedTempId();

      assertChildFullyRemoved(h, tempId);
      assertSourceUntouched(h);
      expect(h.scheduled).toHaveLength(0);
      if (faultPhase === 'before-native-creation') {
        expect(h.targetClient.deleteThread).not.toHaveBeenCalled();
      } else {
        expect(h.targetClient.deleteThread).toHaveBeenCalledTimes(1);
        expect(h.targetClient.deleteThread).toHaveBeenCalledWith(CHILD_ID);
      }
      expect(h.targetClient.deleteThread).not.toHaveBeenCalledWith(SOURCE_NATIVE_ID);
    },
  );
});
