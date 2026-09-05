import type { AgentCwdTransition } from '@main/adapters/types';
import type { AgentEvent, UploadedAttachmentRef } from '@shared/types';
import { describe, expect, it, vi } from 'vitest';
import { CodexCwdTransitionController } from '../cwd-transition-controller';
import { MessageController } from '../message-controller';
import { CodexPendingTurnQueue } from '../pending-turn-queue';
import { awaitResumedThreadStart } from '../resume-path-await';
import type { CodexBridgeRuntimeHost } from '../runtime-host-core';
import { armCodexSessionRetirement } from '../session-retirement';
import { ThreadLoop } from '../thread-loop';
import type { InternalSession } from '../types';

function fixture() {
  const emit = vi.fn<(event: AgentEvent) => void>();
  const runtimeHost = {
    guardHandOffSourceIngress: () => false,
    hasPendingWorktreeTransition: () => false,
    hasExactUserMessage: () => false,
    sessions: { releaseSdkClaim: vi.fn() },
    tokens: { release: vi.fn() },
    deleteUploadIfExists: vi.fn(async () => undefined),
    logger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    liveRate: { resolveModel: () => null, emitTokenRateTick: vi.fn() },
  } as unknown as CodexBridgeRuntimeHost;
  const thread = {
    updateWorkingDirectory: vi.fn(),
    runStreamed: vi.fn(async (_input: unknown) => ({
      events: (async function* () { yield { type: 'turn.accepted', turn_id: 'accepted' }; })(),
    })),
  };
  const internal: InternalSession = {
    applicationSid: 'app', threadId: 'native', cwd: '/fixture',
    thread: thread as unknown as InternalSession['thread'], runtimeIdentity: null,
    pendingTurns: new CodexPendingTurnQueue(), currentTurn: null, currentTurnId: null,
    turnLoopRunning: true, intentionallyClosed: false, pendingPermissions: new Map(),
  };
  const sessions = new Map([['app', internal]]);
  const loop = new ThreadLoop({ sessions, emit, runtimeHost, cleanupTempKey: vi.fn(), finalizeRetirement: vi.fn() });
  const messages = new MessageController({
    sessions, emit, runtimeHost, recoverAndSend: vi.fn(),
    runTurnLoop: (candidate, id) => loop.runTurnLoop(candidate, id),
  });
  return { emit, runtimeHost, thread, internal, sessions, loop, messages };
}

describe('Codex pending turn ownership across controllers', () => {
  it('preserves input, acceptance and handoff metadata across prepend, deletion and consumption', async () => {
    const f = fixture();
    await f.messages.enqueueMessage('app', 'ordinary');
    await f.messages.enqueueMessage('app', 'delete', [], { deferUserEventUntilTurnStart: true, turnCorrelationId: 'delete' });
    const attachment: UploadedAttachmentRef = { kind: 'uploaded', path: '/fixture/image.png', mime: 'image/png', bytes: 4 };
    await f.messages.enqueueMessage('app', 'image', [attachment], { deferUserEventUntilTurnStart: true, turnCorrelationId: 'image' });
    const steerController = new AbortController();
    f.internal.submittingUserMessage = {
      event: { text: 'steer', turnCorrelationId: 'steer' }, kind: 'steer',
      cancelled: false, requestController: steerController,
    };
    const transition: AgentCwdTransition = {
      sessionId: 'app', generation: 1, direction: 'enter', fromCwd: '/fixture', targetCwd: '/fixture/worktree',
      continuationKey: 'cwd-1', continuationText: 'continue',
    };
    const cwd = new CodexCwdTransitionController({
      sessions: f.sessions, runTurnLoop: (candidate, id) => f.loop.runTurnLoop(candidate, id),
    });
    cwd.arm(transition);
    cwd.switchCwd(transition);
    cwd.enqueueContinuation(transition, 'continue');
    expect(steerController.signal.aborted).toBe(true);
    expect(f.messages.removePendingOutgoingMessage('app', 'delete')).toEqual({ id: 'delete', text: 'delete' });
    expect(f.messages.listPendingOutgoingMessages('app').map((entry) => entry.id)).toEqual(['steer', 'image']);
    const snapshot = f.messages.snapshotQueuedMessagesForHandOff('app');
    expect(snapshot.map((entry) => entry.text)).toEqual(['steer', 'ordinary', 'image']);
    snapshot[2]!.attachments![0]!.path = '/mutated/snapshot';
    attachment.path = '/mutated/caller';
    expect(f.messages.listPendingOutgoingMessages('app')[1]!.attachments![0]!.path).toBe('/fixture/image.png');
    expect(f.messages.snapshotQueuedMessagesForHandOff('app')[2]!.attachments![0]!.path).toBe('/fixture/image.png');
    f.emit.mockClear();
    cwd.release('app', 1);
    f.internal.turnLoopRunning = false;
    await f.loop.runTurnLoop(f.internal, 'app');
    expect(f.thread.runStreamed.mock.calls.map(([input]) => input)).toEqual([
      [{ type: 'text', text: 'continue', text_elements: [] }],
      [{ type: 'text', text: 'steer', text_elements: [] }],
      [{ type: 'text', text: 'ordinary', text_elements: [] }],
      [{ type: 'localImage', path: '/fixture/image.png' }, { type: 'text', text: 'image', text_elements: [] }],
    ]);
    expect(f.emit.mock.calls.filter(([e]) => e.kind === 'message').map(([e]) => e.payload)).toEqual([
      { role: 'user', text: 'steer', turnCorrelationId: 'steer' },
      { role: 'user', text: 'image', turnCorrelationId: 'image', attachments: [expect.objectContaining({ path: '/fixture/image.png' })] },
    ]);
    expect(f.internal.pendingTurns.length).toBe(0);
    expect(f.messages.snapshotQueuedMessagesForHandOff('app')).toEqual([]);
  });

  it('clears all queued metadata when resume startup fails', async () => {
    const f = fixture();
    await f.messages.enqueueMessage('app', 'pending', [], { deferUserEventUntilTurnStart: true, turnCorrelationId: 'pending' });
    const errorLoop = {
      runTurnLoop: vi.fn(async (_internal, _sid, _started, failed) => { failed('startup failed'); }),
    } as unknown as ThreadLoop;
    await expect(awaitResumedThreadStart({
      applicationSid: 'app', internal: f.internal,
      deps: { threadLoop: errorLoop, sessions: f.sessions, codexBySession: new Map(), emit: f.emit, runtimeHost: f.runtimeHost },
    })).rejects.toThrow('startup failed');
    expect([...f.internal.pendingTurns]).toEqual([]);
    expect(f.internal.intentionallyClosed).toBe(true);
    expect(f.sessions.size).toBe(0);
  });

  it('retirement clears correlated metadata and deletes only child-owned queued attachment paths', () => {
    const f = fixture();
    f.internal.pendingTurns.append({
      input: { type: 'app-server-input', items: [{ type: 'localImage', path: '/source/image.png' }], ownedAttachmentPaths: ['/child/image.png'] },
      deferredUserEvent: { text: 'fork', turnCorrelationId: 'fork' },
      handOffMessage: { text: 'fork' },
    });
    armCodexSessionRetirement(f.internal, f.runtimeHost, true);
    expect([...f.internal.pendingTurns]).toEqual([]);
    expect(f.runtimeHost.deleteUploadIfExists).toHaveBeenCalledOnce();
    expect(f.runtimeHost.deleteUploadIfExists).toHaveBeenCalledWith('/child/image.png');
  });
});
