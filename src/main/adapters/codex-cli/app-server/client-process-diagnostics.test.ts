import { describe, expect, it, vi } from 'vitest';
import { CodexAppServerClient } from './client';
import {
  UNCONFIGURED_CODEX_CLIENT_HOST,
  type CodexAppServerClientHost,
} from './client-host-port';

function clientHost(
  overrides: Partial<CodexAppServerClientHost>,
): CodexAppServerClientHost {
  return { ...UNCONFIGURED_CODEX_CLIENT_HOST, ...overrides };
}

describe('Codex app-server client diagnostics port', () => {
  it('reports bounded malformed stdout metadata without exposing the provider line', () => {
    const stdoutParseFailed = vi.fn();
    const client = new CodexAppServerClient(
      { env: {}, config: null },
      clientHost({ stdoutParseFailed }),
    );
    const child = { pid: 777 };
    const internal = client as unknown as {
      child: unknown;
      handleLine: (sourceChild: unknown, raw: string) => void;
    };
    internal.child = child;
    const raw = 'not-json prompt=TOP_SECRET raw_tool_args={danger:true}';

    internal.handleLine(child, raw);

    expect(stdoutParseFailed).toHaveBeenCalledWith({
      processGeneration: 0,
      processPid: 777,
      bytes: Buffer.byteLength(raw, 'utf8'),
      errorName: 'SyntaxError',
    });
    expect(JSON.stringify(stdoutParseFailed.mock.calls)).not.toContain('TOP_SECRET');
  });

  it('contains diagnostics failures while delivering later notification listeners', () => {
    const listenerError = new Error('SECRET_LISTENER_FAILURE');
    const notificationListenerFailed = vi.fn(() => {
      throw new Error('diagnostics unavailable');
    });
    const client = new CodexAppServerClient(
      { env: {}, config: null },
      clientHost({ notificationListenerFailed }),
    );
    const delivered = vi.fn();
    client.subscribe(() => { throw listenerError; });
    client.subscribe(delivered);
    const internal = client as unknown as {
      dispatchNotification: (notification: { method: string }) => void;
    };

    expect(() => internal.dispatchNotification({ method: 'item/completed' })).not.toThrow();
    expect(notificationListenerFailed).toHaveBeenCalledWith(listenerError);
    expect(delivered).toHaveBeenCalledOnce();
  });

  it('contains interrupt diagnostics failures and preserves the failed write outcome', () => {
    const interruptWriteFailed = vi.fn(() => {
      throw new Error('diagnostics unavailable');
    });
    const client = new CodexAppServerClient(
      { env: {}, config: null },
      clientHost({ interruptWriteFailed }),
    );
    const writeError = Object.assign(new Error('SECRET_WRITE_FAILURE'), { code: 'EPIPE' });
    const internal = client as unknown as { child: unknown };
    internal.child = {
      stdin: { write: () => { throw writeError; } },
    };

    expect(client.sendTurnInterrupt(0, 'thread-1', 'turn-1')).toBe(false);
    expect(interruptWriteFailed).toHaveBeenCalledWith({
      errorName: 'Error',
      errorCode: 'EPIPE',
    });
  });

  it('creates and resets the injected MCP observer without selecting a desktop adapter', () => {
    const reset = vi.fn();
    const observe = vi.fn(() => ({ level: 'warn' as const, message: 'bounded-startup' }));
    const createMcpStartupObserver = vi.fn(() => ({ observe, reset }));
    const mcpStartupObserved = vi.fn();
    const client = new CodexAppServerClient(
      { env: {}, config: null },
      clientHost({ createMcpStartupObserver, mcpStartupObserved }),
    );
    const child = {};
    const internal = client as unknown as {
      child: unknown;
      dispatchNotification: (notification: { method: string }) => void;
      detachChild: (candidate: unknown) => boolean;
    };
    internal.child = child;

    internal.dispatchNotification({ method: 'mcpServer/startupStatus/updated' });
    expect(createMcpStartupObserver).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledOnce();
    expect(mcpStartupObserved).toHaveBeenCalledWith({
      level: 'warn',
      message: 'bounded-startup',
    });
    expect(internal.detachChild(child)).toBe(true);
    expect(reset).toHaveBeenCalledOnce();
  });

  it('installs generation diagnostics from the client host', () => {
    const generationDiagnostics = {
      ...UNCONFIGURED_CODEX_CLIENT_HOST.generationDiagnostics,
      initializeFailed: vi.fn(),
    };
    const client = new CodexAppServerClient(
      { env: {}, config: null },
      clientHost({ generationDiagnostics }),
    );
    const internal = client as unknown as {
      generationController: { diagnostics: unknown };
    };

    expect(internal.generationController.diagnostics).toBe(generationDiagnostics);
  });

  it('routes thread construction and Browser preparation through the client host', async () => {
    const thread = {} as ReturnType<CodexAppServerClientHost['createThread']>;
    const createThread = vi.fn((
      ..._args: Parameters<CodexAppServerClientHost['createThread']>
    ) => thread);
    const prepared = {
      workingDirectory: '/repo',
      sandboxMode: 'workspace-write' as const,
      approvalPolicy: 'never' as const,
      skipGitRepoCheck: true,
      model: 'prepared-model',
    };
    const prepareThreadOptions = vi.fn(async (
      ..._args: Parameters<CodexAppServerClientHost['prepareThreadOptions']>
    ) => prepared);
    const client = new CodexAppServerClient(
      { env: {}, config: null, nodeReplBrowserBootstrap: true },
      clientHost({ createThread, prepareThreadOptions }),
    );
    const options = { ...prepared, model: 'original-model' };
    const initialRuntime = { model: 'runtime-model', modelProvider: 'openai' };

    expect(client.startThread(options)).toBe(thread);
    expect(client.resumeThread('thread-1', options)).toBe(thread);
    expect(client.adoptThread('thread-2', options, initialRuntime)).toBe(thread);
    expect(createThread).toHaveBeenNthCalledWith(1, client, { mode: 'start', options });
    expect(createThread).toHaveBeenNthCalledWith(2, client, {
      mode: 'resume',
      threadId: 'thread-1',
      options,
    });
    expect(createThread).toHaveBeenNthCalledWith(3, client, {
      mode: 'resume',
      threadId: 'thread-2',
      options,
    }, undefined, initialRuntime);
    await expect(client.prepareThreadOptions(options)).resolves.toBe(prepared);
    expect(prepareThreadOptions).toHaveBeenCalledWith(client, options, null, undefined);
  });
});
