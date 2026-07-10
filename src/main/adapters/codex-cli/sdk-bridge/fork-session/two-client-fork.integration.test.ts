import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@shared/types';
import { CodexAppServerClient } from '../../app-server/client';
import type { JsonObject } from '../../app-server/protocol';
import type { InternalSession } from '../types';
import type { CreateSessionOpts } from '../create-session/_deps';
import type { ThreadLoop } from '../thread-loop';
import { createCodexForkedSession } from './create-forked-session';
import type { CodexForkTargetRuntime } from './target-runtime';

describe('Codex native fork two-client integration', () => {
  it('reads a source paused in tool use without deadlock and forks only on the target client', async () => {
    const sourceClient = new PausedSourceClient();
    const targetClient = new TargetForkClient();
    sourceClient.pauseInToolCall();

    const sessions = new Map<string, InternalSession>();
    const clients = new Map<string, CodexAppServerClient>([['source-app', sourceClient]]);
    const rows = new Set(['source-app']);
    const claims = new Set(['source-app']);
    const tokens = new Map<string, string>([['source-token', 'source-app']]);
    let targetToken = '';
    const runtime = targetRuntime();
    const target: CreateSessionOpts = { cwd: '/repo', prompt: 'delegated child task' };

    const createPromise = createCodexForkedSession(
      { applicationSessionId: 'source-app', nativeSessionId: 'source-native', cwd: '/repo' },
      target,
      {
        sessions,
        codexBySession: clients,
        threadLoop: { runTurnLoop: vi.fn() } as unknown as ThreadLoop,
        emit: (event: AgentEvent) => {
          if (event.kind === 'session-start') rows.add(event.sessionId);
        },
        ensureCodex: async (tempId, token) => {
          targetToken = token;
          clients.set(tempId, targetClient);
          return targetClient;
        },
        lifecycle: {
          allocateToken: (tempId) => {
            tokens.set('target-token', tempId);
            return 'target-token';
          },
          resolveToken: (token) => tokens.get(token) ?? null,
          releaseToken: (sessionId) => {
            for (const [token, owner] of tokens) {
              if (owner === sessionId) tokens.delete(token);
            }
          },
          claimSession: (sessionId) => { claims.add(sessionId); },
          releaseClaim: (sessionId) => { claims.delete(sessionId); },
          hasClaim: (sessionId) => claims.has(sessionId),
          renameSession: (fromId, toId) => {
            if (rows.delete(fromId)) rows.add(toId);
            if (claims.delete(fromId)) claims.add(toId);
            for (const [token, owner] of tokens) {
              if (owner === fromId) tokens.set(token, toId);
            }
            const client = clients.get(fromId);
            if (client) {
              clients.delete(fromId);
              clients.set(toId, client);
            }
          },
          deleteSession: async (sessionId) => { rows.delete(sessionId); },
        },
        resolveTargetRuntime: () => runtime,
        persistTargetFields: vi.fn(),
        scheduleTurn: vi.fn(),
      },
    );

    const handle = await settlesWithin(createPromise, 500);

    expect(handle.sessionId).toBe('child-native');
    expect(sourceClient.readWhilePaused).toBe(true);
    expect(sourceClient.toolCallPaused).toBe(true);
    expect(sourceClient.methods).toEqual(['thread/read']);
    expect(sourceClient.interrupted).toBe(false);
    expect(targetClient.methods).toEqual(['thread/fork', 'thread/inject_items']);
    expect(targetClient.forkParams).toMatchObject({
      threadId: 'source-native',
      lastTurnId: 'terminal-turn',
      cwd: '/repo',
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
      model: 'target-model',
      config: expect.objectContaining({ model_reasoning_effort: 'high' }),
    });
    expect(targetToken).toBe('target-token');
    expect(clients.get('child-native')).toBe(targetClient);
    expect(tokens.get('target-token')).toBe('child-native');
    expect(claims.has('child-native')).toBe(true);
    expect(rows.has('source-app')).toBe(true);

    sourceClient.releaseToolCall();
    await handle.discard();
    expect(targetClient.methods).toContain('thread/delete');
    expect(sourceClient.methods).toEqual(['thread/read']);
    expect(rows.has('source-app')).toBe(true);
  });
});

class PausedSourceClient extends CodexAppServerClient {
  readonly methods: string[] = [];
  toolCallPaused = false;
  readWhilePaused = false;
  interrupted = false;

  constructor() {
    super({ env: {}, config: null });
  }

  pauseInToolCall(): void {
    this.toolCallPaused = true;
  }

  releaseToolCall(): void {
    this.toolCallPaused = false;
  }

  override request<T = unknown>(method: string, _params: unknown): Promise<T> {
    this.methods.push(method);
    if (method === 'thread/read') {
      this.readWhilePaused = this.toolCallPaused;
      return resolved<T>({
        thread: {
          id: 'source-native',
          turns: [
            { id: 'terminal-turn', status: 'completed', items: [] },
            {
              id: 'active-turn',
              status: 'inProgress',
              items: [
                {
                  type: 'userMessage',
                  content: [{ type: 'text', text: 'current request', text_elements: [] }],
                },
                { type: 'reasoning', content: ['unfinished'] },
                { type: 'mcpToolCall', tool: 'spawn_session' },
              ],
            },
          ],
        },
      });
    }
    if (method === 'turn/interrupt') this.interrupted = true;
    throw new Error(`Unexpected source method ${method}`);
  }
}

class TargetForkClient extends CodexAppServerClient {
  readonly methods: string[] = [];
  forkParams: JsonObject | null = null;

  constructor() {
    super({ env: {}, config: null });
  }

  override get isProcessAlive(): boolean {
    return true;
  }

  override request<T = unknown>(method: string, params: unknown): Promise<T> {
    this.methods.push(method);
    if (method === 'thread/fork') {
      this.forkParams = params as JsonObject;
      return resolved<T>({
        thread: { id: 'child-native', forkedFromId: 'source-native', turns: [] },
      });
    }
    if (method === 'thread/inject_items' || method === 'thread/delete') {
      return resolved<T>({});
    }
    throw new Error(`Unexpected target method ${method}`);
  }
}

function targetRuntime(): CodexForkTargetRuntime {
  return {
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
    },
  };
}

async function settlesWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('two-client fork deadlocked')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function resolved<T>(value: unknown): Promise<T> {
  return Promise.resolve(value as T);
}
