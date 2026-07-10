import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@shared/types';
import type {
  CodexAppServerClient,
  CodexAppServerThread,
} from '../../app-server/client';
import type { InternalSession } from '../types';
import type { CreateSessionOpts } from '../create-session/_deps';
import type { ThreadLoop } from '../thread-loop';
import { extractAttachmentPaths } from '../input-pack';
import {
  createCodexForkedSession,
  type CodexForkFaultPhase,
} from './create-forked-session';
import type { CodexForkTargetRuntime } from './target-runtime';

const SOURCE_APP_ID = 'source-app';
const SOURCE_NATIVE_ID = 'source-native';
const CHILD_ID = 'child-native';

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
    expect(h.targetClient.adoptThread).toHaveBeenCalledWith(CHILD_ID, h.runtime.threadOptions);
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
    expect(h.ops).toEqual(expect.arrayContaining([
      `emit:start:${tempId}`,
      `rename:${tempId}:${CHILD_ID}`,
      `emit:user:${CHILD_ID}:token=${CHILD_ID}`,
    ]));
    expect(h.ops.indexOf(`rename:${tempId}:${CHILD_ID}`))
      .toBeLessThan(h.ops.indexOf(`emit:user:${CHILD_ID}:token=${CHILD_ID}`));

    const pending = h.sessions.get(CHILD_ID)?.pendingMessages[0];
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
    const pending = h.sessions.get(CHILD_ID)?.pendingMessages[0];
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
    const pending = h.sessions.get(CHILD_ID)?.pendingMessages[0];

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

interface HarnessOptions {
  zeroPrefix?: boolean;
  turnFailure?: boolean;
  faultPhase?: CodexForkFaultPhase;
  targetAttachmentPath?: string;
}

function makeHarness(options: HarnessOptions = {}) {
  const appRows = new Set([SOURCE_APP_ID]);
  const claims = new Set([SOURCE_APP_ID]);
  const sessionToToken = new Map([[SOURCE_APP_ID, 'source-token']]);
  const tokenToSession = new Map([['source-token', SOURCE_APP_ID]]);
  const events: AgentEvent[] = [];
  const ops: string[] = [];
  const sessions = new Map<string, InternalSession>();
  const scheduled: Array<() => void> = [];
  const attachedThread = {} as CodexAppServerThread;

  const sourceClient = makeClient({
    readThread: vi.fn().mockResolvedValue({
      thread: {
        id: SOURCE_NATIVE_ID,
        turns: options.zeroPrefix
          ? [activeTurn()]
          : [
              { id: 'terminal-turn', status: 'completed', items: [] },
              activeTurn(),
            ],
      },
    }),
  });
  const targetClient = makeClient({
    forkThread: vi.fn().mockResolvedValue({
      thread: { id: CHILD_ID, forkedFromId: SOURCE_NATIVE_ID, turns: [] },
    }),
    startThreadEager: vi.fn().mockResolvedValue({
      thread: { id: CHILD_ID, forkedFromId: null, turns: [] },
    }),
    adoptThread: vi.fn().mockReturnValue(attachedThread),
  });
  const clients = new Map<string, CodexAppServerClient>([[SOURCE_APP_ID, sourceClient]]);
  const runtime: CodexForkTargetRuntime = {
    cwd: '/repo',
    sandboxMode: 'workspace-write',
    effectiveDeveloperInstructions: 'complete target instructions',
    persistedModel: 'target-model',
    persistedReasoningEffort: 'high',
    threadOptions: {
      workingDirectory: '/repo',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      skipGitRepoCheck: true,
      model: 'target-model',
      modelReasoningEffort: 'high',
      developerInstructions: 'complete target instructions',
    },
  };
  const target: CreateSessionOpts = {
    cwd: '/repo',
    prompt: 'delegated task',
    model: 'target-model',
    modelReasoningEffort: 'high',
    ...(options.targetAttachmentPath
      ? {
          attachments: [{
            kind: 'uploaded' as const,
            path: options.targetAttachmentPath,
            mime: 'image/png',
            bytes: 1,
          }],
        }
      : {}),
  };
  const threadLoop = {
    runTurnLoop: vi.fn().mockImplementation(() =>
      options.turnFailure
        ? Promise.reject(new Error('first turn failed'))
        : Promise.resolve()),
  } as unknown as ThreadLoop;

  let allocatedTemp: string | null = null;
  const deps = {
    sessions,
    codexBySession: clients,
    threadLoop,
    emit: (event: AgentEvent) => {
      events.push(event);
      if (event.kind === 'session-start') {
        appRows.add(event.sessionId);
        ops.push(`emit:start:${event.sessionId}`);
      } else if ((event.payload as { role?: unknown })?.role === 'user') {
        ops.push(
          `emit:user:${event.sessionId}:token=${tokenToSession.get('target-token') ?? 'missing'}`,
        );
      }
    },
    ensureCodex: vi.fn(async (tempId: string) => {
      clients.set(tempId, targetClient);
      return targetClient;
    }),
    lifecycle: {
      allocateToken: (sessionId: string) => {
        allocatedTemp = sessionId;
        sessionToToken.set(sessionId, 'target-token');
        tokenToSession.set('target-token', sessionId);
        return 'target-token';
      },
      resolveToken: (token: string) => tokenToSession.get(token) ?? null,
      releaseToken: (sessionId: string) => {
        const token = sessionToToken.get(sessionId);
        sessionToToken.delete(sessionId);
        if (token) tokenToSession.delete(token);
      },
      claimSession: (sessionId: string) => { claims.add(sessionId); },
      releaseClaim: (sessionId: string) => { claims.delete(sessionId); },
      hasClaim: (sessionId: string) => claims.has(sessionId),
      renameSession: (fromId: string, toId: string) => {
        ops.push(`rename:${fromId}:${toId}`);
        if (appRows.delete(fromId)) appRows.add(toId);
        if (claims.delete(fromId)) claims.add(toId);
        const token = sessionToToken.get(fromId);
        if (token) {
          sessionToToken.delete(fromId);
          sessionToToken.set(toId, token);
          tokenToSession.set(token, toId);
        }
        const client = clients.get(fromId);
        if (client) {
          clients.delete(fromId);
          clients.set(toId, client);
        }
      },
      deleteSession: vi.fn(async (sessionId: string) => {
        appRows.delete(sessionId);
      }),
    },
    resolveTargetRuntime: () => runtime,
    persistTargetFields: vi.fn(),
    scheduleTurn: (start: () => void) => { scheduled.push(start); },
    faultInjector: (phase: CodexForkFaultPhase) => {
      if (phase === options.faultPhase) throw new Error(`fault:${phase}`);
    },
  };

  return {
    source: {
      applicationSessionId: SOURCE_APP_ID,
      nativeSessionId: SOURCE_NATIVE_ID,
      cwd: '/repo',
    },
    target,
    deps,
    runtime,
    sessions,
    clients,
    appRows,
    claims,
    events,
    ops,
    scheduled,
    sourceClient,
    targetClient,
    attachedThread,
    threadLoop,
    tokenOwner: (token: string) => tokenToSession.get(token) ?? null,
    releaseTargetToken: (sessionId: string) => {
      const token = sessionToToken.get(sessionId);
      sessionToToken.delete(sessionId);
      if (token) tokenToSession.delete(token);
    },
    allocatedTempId: () => {
      if (!allocatedTemp) throw new Error('temp id was not allocated');
      return allocatedTemp;
    },
    runScheduledTurn: () => {
      const start = scheduled.shift();
      if (!start) throw new Error('no scheduled turn');
      start();
    },
  };
}

function activeTurn() {
  return {
    id: 'active-turn',
    status: 'inProgress' as const,
    items: [
      {
        type: 'userMessage',
        content: [
          { type: 'text', text: 'current source request', text_elements: [] },
          { type: 'skill', name: 'review', path: 'skill://review' },
          { type: 'localImage', path: '/uploads/source.png' },
        ],
      },
      { type: 'reasoning', content: ['source reasoning'] },
      { type: 'agentMessage', text: 'unfinished assistant' },
      { type: 'mcpToolCall', tool: 'spawn_session' },
    ],
  };
}

function makeClient(overrides: Record<string, unknown>): CodexAppServerClient {
  return {
    readThread: vi.fn(),
    forkThread: vi.fn(),
    startThreadEager: vi.fn(),
    injectThreadItems: vi.fn().mockResolvedValue(undefined),
    deleteThread: vi.fn().mockResolvedValue(undefined),
    adoptThread: vi.fn(),
    dispose: vi.fn(),
    isDisposed: false,
    createSiblingClient: vi.fn(),
    ...overrides,
  } as unknown as CodexAppServerClient;
}

function assertChildFullyRemoved(
  h: ReturnType<typeof makeHarness>,
  tempId: string,
): void {
  expect(h.sessions.has(tempId)).toBe(false);
  expect(h.sessions.has(CHILD_ID)).toBe(false);
  expect(h.clients.has(tempId)).toBe(false);
  expect(h.clients.has(CHILD_ID)).toBe(false);
  expect(h.appRows.has(tempId)).toBe(false);
  expect(h.appRows.has(CHILD_ID)).toBe(false);
  expect(h.claims.has(tempId)).toBe(false);
  expect(h.claims.has(CHILD_ID)).toBe(false);
  expect(h.tokenOwner('target-token')).toBeNull();
}

function assertSourceUntouched(h: ReturnType<typeof makeHarness>): void {
  expect(h.clients.get(SOURCE_APP_ID)).toBe(h.sourceClient);
  expect(h.appRows.has(SOURCE_APP_ID)).toBe(true);
  expect(h.claims.has(SOURCE_APP_ID)).toBe(true);
  expect(h.tokenOwner('source-token')).toBe(SOURCE_APP_ID);
  expect(h.sourceClient.dispose).not.toHaveBeenCalled();
  expect(h.sourceClient.deleteThread).not.toHaveBeenCalled();
}
