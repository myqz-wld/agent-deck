import { vi } from 'vitest';
import { CodexPendingTurnQueue } from '../sdk-bridge/pending-turn-queue';
import type { InternalSession } from '../sdk-bridge/types';

function makeFakeThread(): InternalSession['thread'] {
  return {
    runStreamed: vi.fn(async () => {
      throw new Error('not invoked in this test');
    }),
  } as unknown as InternalSession['thread'];
}

function makeInternalSession(threadId: string): InternalSession {
  return {
    applicationSid: threadId,
    threadId,
    cwd: '/tmp/codex-cwd',
    thread: makeFakeThread() as unknown as InternalSession['thread'],
    runtimeIdentity: null,
    pendingTurns: new CodexPendingTurnQueue(),
    currentTurn: null,
    currentTurnId: null,
    // **关键**:turnLoopRunning=true → bridge.sendMessage 跳过 void runTurnLoop 启动
    // (本 test 不验证 turn loop 行为,只关心 wire prefix 在 pendingTurns 与 emit 中的保留)
    turnLoopRunning: true,
    intentionallyClosed: false,
    pendingPermissions: new Map(),
  };
}

function makeActiveInternalSession(threadId: string): {
  internal: InternalSession;
  steer: ReturnType<typeof vi.fn>;
} {
  const steer = vi.fn(async () => undefined);
  return {
    internal: {
      applicationSid: threadId,
      threadId,
      cwd: '/tmp/codex-cwd',
      thread: { steer } as unknown as InternalSession['thread'],
      runtimeIdentity: null,
      pendingTurns: new CodexPendingTurnQueue(),
      currentTurn: new AbortController(),
      currentTurnId: 'turn-active-1',
      turnLoopRunning: true,
      intentionallyClosed: false,
      pendingPermissions: new Map(),
    },
    steer,
  };
}

export { makeActiveInternalSession, makeInternalSession };
