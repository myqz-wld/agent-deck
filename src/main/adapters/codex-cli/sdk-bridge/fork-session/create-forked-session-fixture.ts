import type { AgentEvent } from '@shared/types';
import { expect, vi } from 'vitest';
import type { CodexAppServerClient, CodexAppServerThread } from '../../app-server/client';
import { codexBridgeTestRuntimeHost } from '../__tests__/runtime-host-fixture';
import type { CreateSessionOpts } from '../create-session/_deps';
import type { ThreadLoop } from '../thread-loop';
import type { InternalSession } from '../types';
import { type CodexForkFaultPhase } from './create-forked-session';
import type { CodexForkTargetRuntime } from './target-runtime';

const SOURCE_APP_ID = 'source-app';
const SOURCE_NATIVE_ID = 'source-native';
const CHILD_ID = 'child-native';


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
    approvalPolicy: 'never',
    model: 'target-model',
    modelReasoningEffort: 'high',
    initialSessionRegistration: {
      spawnLink: { parentSessionId: SOURCE_APP_ID, depth: 1 },
      onRegistered: vi.fn(),
    },
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
    runtimeHost: codexBridgeTestRuntimeHost,
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
    onRegistered: target.initialSessionRegistration!.onRegistered,
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

export {
  assertChildFullyRemoved,
  assertSourceUntouched,
  CHILD_ID,
  makeClient,
  makeHarness,
  SOURCE_APP_ID,
  SOURCE_NATIVE_ID,
};
