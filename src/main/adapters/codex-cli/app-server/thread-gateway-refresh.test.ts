import { describe, expect, it } from 'vitest';
import { CodexAppServerClient } from './client';
import type { CodexAppServerNotification, JsonObject } from './protocol';
import type { CodexThreadOptions } from '../sdk-bridge/thread-options-builder';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

interface LoadedRuntime {
  model: string;
  modelProvider: string;
  config: JsonObject;
}

// Native Codex 0.156.0 rejoins a loaded thread without applying resume overrides.
// Retain that behavior here so a successful RPC alone cannot prove Gateway switching.
class LoadedThreadClient extends CodexAppServerClient {
  readonly calls: Array<{ method: string; params: JsonObject }> = [];
  readonly turns: Array<LoadedRuntime & { threadId: string; input: unknown }> = [];
  private readonly observers = new Set<(notification: CodexAppServerNotification) => void>();
  loaded: LoadedRuntime | null = null;
  autoComplete = true;
  unsubscribeFailure: Error | string | null = null;
  beforeResume: (() => Promise<void>) | null = null;

  constructor() {
    super({ env: {}, config: { model_provider: 'native-provider' } });
  }

  override subscribe(listener: (notification: CodexAppServerNotification) => void) {
    this.observers.add(listener);
    return () => { this.observers.delete(listener); };
  }

  completeTurn(): void {
    const notification = {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: `turn-${this.turns.length}`, status: 'completed' } },
    };
    for (const observer of this.observers) observer(notification);
  }

  override async request<T = unknown>(method: string, input: unknown): Promise<T> {
    const params = input as JsonObject;
    this.calls.push({ method, params });
    if (method === 'thread/unsubscribe') {
      if (this.unsubscribeFailure instanceof Error) throw this.unsubscribeFailure;
      if (this.unsubscribeFailure) return { status: this.unsubscribeFailure } as T;
      const status = this.loaded ? 'unsubscribed' : 'notLoaded';
      this.loaded = null;
      return { status } as T;
    }
    if (method === 'thread/start' || method === 'thread/resume') {
      if (method === 'thread/resume' && this.beforeResume) await this.beforeResume();
      if (!this.loaded) {
        const config = params.config as JsonObject;
        this.loaded = {
          model: String(params.model ?? config.model ?? 'native-model'),
          modelProvider: String(params.modelProvider ?? config.model_provider),
          config,
        };
      }
      return { thread: { id: 'thread-1', turns: [] }, ...this.loaded } as T;
    }
    if (method === 'turn/start') {
      if (!this.loaded) throw new Error('Thread is not loaded');
      this.turns.push({ ...this.loaded, threadId: String(params.threadId), input: params.input });
      if (this.autoComplete) queueMicrotask(() => this.completeTurn());
      return { turn: { id: `turn-${this.turns.length}` } } as T;
    }
    return {} as T;
  }
}

function options(): CodexThreadOptions {
  return {
    workingDirectory: '/repo',
    sandboxMode: 'workspace-write',
    approvalPolicy: 'never',
    skipGitRepoCheck: true,
    model: 'kept-model',
    modelReasoningEffort: 'high',
    modelProvider: 'old-provider',
    gatewayConfigOverrides: { model_provider: 'old-provider', old_gateway_only: true },
  };
}

function gateway(provider: string | null) {
  return {
    gatewayConfigOverrides: provider ? {
      model_provider: provider,
      model_context_window: 200_000,
      model_providers: { [provider]: { base_url: 'https://gateway.example/v1' } },
    } : null,
    modelProvider: provider,
    model: 'kept-model',
    effort: 'high' as const,
  };
}

function input(text = 'test') {
  return [{ type: 'text' as const, text, text_elements: [] }];
}

describe('Codex loaded-thread Gateway refresh', () => {
  it('uses the new Gateway for the next message while preserving thread id and model settings', async () => {
    const client = new LoadedThreadClient();
    const thread = client.startThread(options());
    await thread.run(input('first'));
    thread.stageGatewayOptions(gateway('new-provider'));
    await thread.updateModelOptions('explicit-next-model', 'ultra');
    expect(client.loaded?.modelProvider).toBe('old-provider');

    await thread.run(input('second'));

    expect(client.turns.map((turn) => turn.modelProvider)).toEqual(['old-provider', 'new-provider']);
    expect(client.turns.map((turn) => turn.threadId)).toEqual(['thread-1', 'thread-1']);
    expect(client.turns.map((turn) => turn.input)).toEqual([input('first'), input('second')]);
    expect(client.calls.map((call) => call.method)).toEqual([
      'thread/start', 'turn/start', 'thread/unsubscribe', 'thread/resume', 'turn/start',
    ]);
    expect(client.calls.find((call) => call.method === 'thread/resume')?.params).toMatchObject({
      threadId: 'thread-1', model: 'explicit-next-model', modelProvider: 'new-provider',
      approvalPolicy: 'never', sandbox: 'workspace-write', excludeTurns: true,
      config: { model_reasoning_effort: 'ultra', model_context_window: 200_000 },
    });
    expect(thread.getRuntimeIdentity()).toMatchObject({
      model: 'explicit-next-model', runtimeProvider: 'new-provider',
      capacityConfigFingerprint: 'model-context-window:200000',
    });
  });

  it('removes the previous Gateway layer when returning to native configuration', async () => {
    const client = new LoadedThreadClient();
    const thread = client.startThread(options());
    await thread.ensureReady();
    thread.stageGatewayOptions(gateway(null));
    await thread.run(input());
    expect(client.turns[0].modelProvider).toBe('native-provider');
    expect(client.turns[0].config).not.toHaveProperty('old_gateway_only');
    expect(client.turns[0].config).not.toHaveProperty('model_context_window');
  });

  it('reloads a different profile even when both profiles use the same native provider id', async () => {
    const client = new LoadedThreadClient();
    const thread = client.startThread(options());
    await thread.ensureReady();
    thread.stageGatewayOptions(gateway('old-provider'));
    await thread.run(input());
    expect(client.turns[0].config).toMatchObject({
      model_providers: { 'old-provider': { base_url: 'https://gateway.example/v1' } },
    });
    expect(client.turns[0].config).not.toHaveProperty('old_gateway_only');
  });

  it('keeps steering on the active turn and applies the staged Gateway only afterward', async () => {
    const client = new LoadedThreadClient();
    client.autoComplete = false;
    const thread = client.startThread(options());
    const { events } = await thread.runStreamed(input('active'));
    const stream = events[Symbol.asyncIterator]();
    expect((await stream.next()).value?.type).toBe('thread.started');
    expect((await stream.next()).value?.type).toBe('turn.accepted');
    try {
      thread.stageGatewayOptions(gateway('new-provider'));
      await thread.steer(input('steering'), 'turn-1');
      expect(client.calls.map((call) => call.method)).toEqual([
        'thread/start', 'turn/start', 'turn/steer',
      ]);
      expect(client.loaded?.modelProvider).toBe('old-provider');
    } finally {
      client.completeTurn();
      while (!(await stream.next()).done) { /* Drain the terminal and release the active turn. */ }
    }
    client.autoComplete = true;
    await thread.run(input('next'));
    expect(client.turns.map((turn) => turn.modelProvider)).toEqual(['old-provider', 'new-provider']);
  });

  it('shares one refresh between concurrent readiness callers', async () => {
    const client = new LoadedThreadClient();
    const thread = client.startThread(options());
    await thread.ensureReady();
    thread.stageGatewayOptions(gateway('new-provider'));
    expect(await Promise.all([thread.ensureReady(), thread.ensureReady()])).toEqual([
      'thread-1', 'thread-1',
    ]);
    expect(client.calls.map((call) => call.method)).toEqual([
      'thread/start', 'thread/unsubscribe', 'thread/resume',
    ]);
    expect(client.loaded?.modelProvider).toBe('new-provider');
  });

  it('applies a newer selection that arrives while the preceding resume is pending', async () => {
    const client = new LoadedThreadClient();
    const thread = client.startThread(options());
    await thread.ensureReady();
    const entered = deferred();
    const release = deferred();
    client.beforeResume = () => { entered.resolve(); return release.promise; };
    thread.stageGatewayOptions(gateway('intermediate-provider'));
    const readiness = thread.ensureReady();
    await entered.promise;
    thread.stageGatewayOptions(gateway('latest-provider'));
    release.resolve();
    await readiness;
    await thread.run(input());
    expect(client.turns.map((turn) => turn.modelProvider)).toEqual(['latest-provider']);
    expect(client.calls.filter((call) => call.method === 'thread/unsubscribe')).toHaveLength(2);
  });

  it.each([new Error('unsubscribe failed'), 'notSubscribed', 'unknown-status'])(
    'does not send through the old Gateway after an unsuccessful unload: %s', async (failure) => {
      const client = new LoadedThreadClient();
      const thread = client.startThread(options());
      await thread.ensureReady();
      thread.stageGatewayOptions(gateway('new-provider'));
      client.unsubscribeFailure = failure;
      await expect(thread.run(input())).rejects.toThrow();
      expect(client.turns).toHaveLength(0);
      expect(client.calls.filter((call) => call.method === 'thread/resume')).toHaveLength(0);
      client.unsubscribeFailure = null;
      await thread.run(input());
      expect(client.turns[0].modelProvider).toBe('new-provider');
    },
  );

  it('retries the selected Gateway after unload succeeded but resume failed', async () => {
    const client = new LoadedThreadClient();
    const thread = client.startThread(options());
    await thread.ensureReady();
    thread.stageGatewayOptions(gateway('new-provider'));
    client.beforeResume = async () => { throw new Error('resume failed'); };
    await expect(thread.run(input())).rejects.toThrow('resume failed');
    expect(client.turns).toHaveLength(0);
    client.beforeResume = null;
    await thread.run(input());
    expect(client.turns[0].modelProvider).toBe('new-provider');
  });

  it('does not unload before a fresh start or an ordinary process recovery', async () => {
    const client = new LoadedThreadClient();
    const thread = client.startThread(options());
    thread.stageGatewayOptions(gateway('new-provider'));
    await thread.ensureReady();
    client.loaded = null;
    client.recycleGeneration(client.generation, new Error('test process exit'), 'test');
    await thread.ensureReady();
    expect(client.calls.map((call) => call.method)).toEqual(['thread/start', 'thread/resume']);
    expect(thread.getRuntimeIdentity()).toMatchObject({ runtimeProvider: 'new-provider' });
  });
});
