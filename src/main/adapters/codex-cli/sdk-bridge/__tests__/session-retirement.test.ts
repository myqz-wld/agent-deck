import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSettingsStoreMock } from '@main/__tests__/_shared/mocks/settings-store';

const runtime = vi.hoisted(() => ({ claims: new Set<string>() }));

vi.mock('@main/adapters/codex-cli/sdk-bridge/codex-binary', () => ({
  resolveBundledCodexBinary: () => null,
  resolveCodexBinary: () => null,
  prependResolvedCodexPathDirs: vi.fn(),
}));
vi.mock('@main/store/image-uploads', () => ({
  deleteUploadIfExists: vi.fn(async () => undefined),
}));
vi.mock('@main/paths', () => ({
  getImageUploadsDir: () => '/tmp/test-image-uploads',
}));
vi.mock('@main/store/settings-store', () => ({
  settingsStore: makeSettingsStoreMock(),
}));
vi.mock('@main/codex-config/agent-deck-mcp-injector', () => ({
  buildAgentDeckMcpConfigForCodex: () => null,
  mergeCodexConfig: (value: unknown) => value,
  AGENT_DECK_MCP_TOKEN_ENV: 'AGENT_DECK_MCP_TOKEN',
}));
vi.mock('@main/adapters/codex-cli/codex-instance-pool', () => ({
  invalidateCodexInstance: vi.fn(),
}));
vi.mock('@main/store/session-repo', () => ({
  sessionRepo: {
    get: vi.fn(() => null),
    setCodexSandbox: vi.fn(),
    setModel: vi.fn(),
    setThinking: vi.fn(),
  },
}));
vi.mock('@main/session/manager', () => ({
  sessionManager: {
    claimAsSdk: vi.fn((sid: string) => runtime.claims.add(sid)),
    releaseSdkClaim: vi.fn((sid: string) => runtime.claims.delete(sid)),
    hasSdkClaim: vi.fn((sid: string) => runtime.claims.has(sid)),
    renameSdkSession: vi.fn(),
    updateCliSessionId: vi.fn(),
    delete: vi.fn(),
    getCloseEpoch: vi.fn(() => 0),
  },
}));

import { deleteUploadIfExists } from '@main/store/image-uploads';
import * as mcpSessionTokenMap from '@main/agent-deck-mcp/mcp-session-token-map';
import { sessionManager } from '@main/session/manager';
import { CodexSdkBridge } from '..';
import type { CodexAppServerClient } from '../../app-server/client';
import type { CodexInput } from '../input-pack';
import type { InternalSession } from '../types';

interface BridgeInternals {
  sessions: Map<string, InternalSession>;
  codexBySession: Map<string, CodexAppServerClient>;
  threadLoop: {
    runTurnLoop: (internal: InternalSession, sessionId: string) => Promise<void>;
  };
}

function bridgeInternals(bridge: CodexSdkBridge): BridgeInternals {
  return bridge as unknown as BridgeInternals;
}

function makeInternal(
  sessionId: string,
  thread: InternalSession['thread'],
  pendingMessages: CodexInput[],
): InternalSession {
  return {
    applicationSid: sessionId,
    threadId: sessionId,
    cwd: '/repo',
    thread,
    pendingMessages,
    currentTurn: null,
    currentTurnId: null,
    turnLoopRunning: false,
    intentionallyClosed: false,
  };
}

beforeEach(() => {
  runtime.claims.clear();
  mcpSessionTokenMap.clearAll();
  vi.clearAllMocks();
});

describe('Codex handoff source runtime retirement', () => {
  it('drains the active event iterable, rejects old input, and retires before another turn', async () => {
    const sessionId = 'codex-handoff-source';
    let finishEvents!: () => void;
    let iterableEnded = false;
    const eventBarrier = new Promise<void>((resolve) => {
      finishEvents = resolve;
    });
    const thread = {
      runStreamed: vi.fn(async () => ({
        events: (async function* () {
          await eventBarrier;
          iterableEnded = true;
        })(),
      })),
      steer: vi.fn(async () => undefined),
    } as unknown as InternalSession['thread'];
    const attachmentPath = '/tmp/test-image-uploads/queued.png';
    const internal = makeInternal(sessionId, thread, [
      'current turn',
      [{ type: 'local_image', path: attachmentPath }],
    ]);
    internal.pendingHandOffMessages = [
      { text: 'current turn' },
      {
        text: 'queued image',
        attachments: [{
          kind: 'uploaded',
          path: attachmentPath,
          mime: 'image/png',
          bytes: 4,
        }],
      },
    ];
    const bridge = new CodexSdkBridge({ emit: vi.fn() });
    const state = bridgeInternals(bridge);
    state.sessions.set(sessionId, internal);
    const disposalState: Array<{ iterableEnded: boolean; turn: AbortController | null; id: string | null }> = [];
    const dispose = vi.fn(() => {
      disposalState.push({
        iterableEnded,
        turn: internal.currentTurn,
        id: internal.currentTurnId,
      });
    });
    state.codexBySession.set(sessionId, { dispose } as unknown as CodexAppServerClient);
    sessionManager.claimAsSdk(sessionId);
    const token = mcpSessionTokenMap.allocate(sessionId);

    const loopPromise = state.threadLoop.runTurnLoop(internal, sessionId);
    await vi.waitFor(() => expect(thread.runStreamed).toHaveBeenCalledTimes(1));
    expect(internal.pendingHandOffMessages).toEqual([
      expect.objectContaining({ text: 'queued image' }),
    ]);
    expect(bridge.snapshotQueuedMessagesForHandOff(sessionId)).toEqual([
      expect.objectContaining({
        text: 'queued image',
        attachments: [expect.objectContaining({ path: attachmentPath })],
      }),
    ]);
    const activeController = internal.currentTurn;
    internal.currentTurnId = 'turn-active';

    bridge.retireSessionAfterCurrentTurn(sessionId);

    expect(internal.retireAfterCurrentTurn).toBe(true);
    expect(internal.intentionallyClosed).toBe(false);
    expect(internal.currentTurn).toBe(activeController);
    expect(activeController?.signal.aborted).toBe(false);
    expect(internal.currentTurnId).toBe('turn-active');
    expect(internal.pendingMessages).toEqual([]);
    expect(internal.pendingHandOffMessages).toEqual([]);
    expect(deleteUploadIfExists).not.toHaveBeenCalled();
    expect(state.sessions.get(sessionId)).toBe(internal);
    expect(dispose).not.toHaveBeenCalled();
    await expect(bridge.enqueueMessage(sessionId, 'must use successor')).rejects.toThrow(
      /retiring after handoff/,
    );
    await expect(bridge.steerTurn(sessionId, 'must not steer old owner')).rejects.toThrow(
      /retiring after handoff/,
    );
    expect(thread.steer).not.toHaveBeenCalled();

    finishEvents();
    await loopPromise;

    expect(thread.runStreamed).toHaveBeenCalledTimes(1);
    expect(disposalState).toEqual([{ iterableEnded: true, turn: null, id: null }]);
    expect(internal.turnLoopRunning).toBe(false);
    expect(internal.retirementFinalized).toBe(true);
    expect(state.sessions.has(sessionId)).toBe(false);
    expect(state.codexBySession.has(sessionId)).toBe(false);
    expect(runtime.claims.has(sessionId)).toBe(false);
    expect(mcpSessionTokenMap.get(token)).toBeNull();
    expect(dispose).toHaveBeenCalledTimes(1);

    bridge.retireSessionAfterCurrentTurn(sessionId);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('retires an idle source immediately and cleans all aliases idempotently', () => {
    const sessionId = 'codex-idle-source';
    const nativeId = 'codex-native-thread';
    const aliasId = 'codex-runtime-alias';
    const attachmentPath = '/tmp/test-image-uploads/idle.png';
    const internal = makeInternal(
      sessionId,
      { steer: vi.fn() } as unknown as InternalSession['thread'],
      [[{ type: 'local_image', path: attachmentPath }]],
    );
    internal.threadId = nativeId;
    internal.pendingHandOffMessages = [{
      text: 'idle image',
      attachments: [{
        kind: 'uploaded',
        path: attachmentPath,
        mime: 'image/png',
        bytes: 4,
      }],
    }];
    const bridge = new CodexSdkBridge({ emit: vi.fn() });
    const state = bridgeInternals(bridge);
    state.sessions.set(sessionId, internal);
    state.sessions.set(aliasId, internal);
    const dispose = vi.fn();
    const client = { dispose } as unknown as CodexAppServerClient;
    state.codexBySession.set(sessionId, client);
    state.codexBySession.set(nativeId, client);
    for (const sid of [sessionId, nativeId, aliasId]) sessionManager.claimAsSdk(sid);
    const sourceToken = mcpSessionTokenMap.allocate(sessionId);
    const nativeToken = mcpSessionTokenMap.allocate(nativeId);
    const aliasToken = mcpSessionTokenMap.allocate(aliasId);

    bridge.retireSessionAfterCurrentTurn(sessionId);

    expect(internal.intentionallyClosed).toBe(false);
    expect(internal.retirementFinalized).toBe(true);
    expect(internal.pendingMessages).toEqual([]);
    expect(deleteUploadIfExists).not.toHaveBeenCalled();
    expect([...state.sessions.values()]).not.toContain(internal);
    expect(state.codexBySession.has(sessionId)).toBe(false);
    expect(state.codexBySession.has(nativeId)).toBe(false);
    expect(dispose).toHaveBeenCalledTimes(1);
    for (const sid of [sessionId, nativeId, aliasId]) expect(runtime.claims.has(sid)).toBe(false);
    for (const token of [sourceToken, nativeToken, aliasToken]) {
      expect(mcpSessionTokenMap.get(token)).toBeNull();
    }

    bridge.retireSessionAfterCurrentTurn(sessionId);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('keeps destructive attachment cleanup for an ordinary close', async () => {
    const sessionId = 'codex-ordinary-close';
    const attachmentPath = '/tmp/test-image-uploads/close.png';
    const internal = makeInternal(
      sessionId,
      { steer: vi.fn() } as unknown as InternalSession['thread'],
      [[{ type: 'local_image', path: attachmentPath }]],
    );
    const bridge = new CodexSdkBridge({ emit: vi.fn() });
    bridgeInternals(bridge).sessions.set(sessionId, internal);

    await bridge.closeSession(sessionId);

    expect(deleteUploadIfExists).toHaveBeenCalledWith(attachmentPath);
  });
});
