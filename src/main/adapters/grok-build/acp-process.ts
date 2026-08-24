import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { Readable, Writable, type Duplex } from 'node:stream';

import {
  PROTOCOL_VERSION,
  client,
  methods,
  ndJsonStream,
  type ClientConnection,
  type AuthMethod,
  type InitializeResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import { spawnGrokChild } from './launch-child';
import type { ProviderSessionBrowserContext } from '@contracts/index';
import {
  GROK_EXTENSION_NOTIFICATION_METHOD,
  GROK_EXTENSION_UPDATE_METHOD,
  GROK_PROMPT_COMPLETE_METHOD,
  parseGrokExtensionNotification,
  parseGrokPromptCompleteNotification,
  type GrokExtensionNotification,
  type GrokPromptCompleteNotification,
} from './extension';

const STDERR_LIMIT = 64 * 1024;
const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 2_000;

export interface GrokAcpClientOptions {
  onSessionUpdate: (notification: SessionNotification) => void;
  onSessionUpdateError?: (
    error: unknown,
    notification: SessionNotification,
  ) => void;
  onGrokExtensionUpdate?: (notification: GrokExtensionNotification) => void;
  onGrokPromptComplete?: (
    notification: GrokPromptCompleteNotification,
  ) => void;
  onPermissionRequest: (
    request: RequestPermissionRequest,
    signal: AbortSignal,
  ) => Promise<RequestPermissionResponse>;
  /** Capability probes initialize only; real session children authenticate before new/load. */
  authenticate?: boolean;
}

export interface GrokAcpProcessOptions extends GrokAcpClientOptions {
  binary: string;
  /** Test seam for a deterministic fake ACP child. Production always uses Grok Build's fixed args. */
  args?: string[];
  cwd: string;
  environment?: Readonly<Record<string, string>>;
  sandboxProfile?: string | null;
  /** Persist native folder trust before project-scoped resources are resolved. */
  trustProject?: boolean;
}

export interface GrokAcpSession {
  readonly authenticatedMethodId: string | null;
  readonly connection: ClientConnection;
  readonly diagnostics: string;
  readonly initializeResponse: InitializeResponse;
  readonly isStopping: boolean;
  readonly pid: number | null;
  readonly usedLoginShell: boolean;
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  stop(): Promise<void>;
}

export interface GrokAcpChannel {
  readonly exited: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
  readonly stream: Duplex;
  close(): Promise<void>;
}

export interface GrokAcpSessionFactoryInput extends GrokAcpClientOptions {
  readonly applicationSessionId: string;
  readonly browserContext?: ProviderSessionBrowserContext;
  readonly cwd: string;
  readonly sandboxProfile: string | null;
}

export interface GrokAcpSessionFactoryResult {
  readonly allowAgentDeckMcp: boolean;
  readonly allowHostPathMetadata: boolean;
  readonly process: GrokAcpSession;
  /** Cwd visible to the ACP agent; it may differ from Core's host-side Workspace path. */
  readonly sessionCwd: string;
}

export type GrokAcpSessionFactory = (
  input: GrokAcpSessionFactoryInput,
) => Promise<GrokAcpSessionFactoryResult>;

interface GrokAcpTransport {
  readonly diagnosticStreams: readonly Readable[];
  readonly exited: GrokAcpChannel['exited'];
  readonly input: Writable;
  readonly output: Readable;
  readonly pid: number | null;
  readonly usedLoginShell: boolean;
  close(): Promise<void>;
}

export type NativeGrokAcpProcess = GrokAcpProcess & {
  readonly child: ChildProcessWithoutNullStreams;
};

export class GrokAcpProcess implements GrokAcpSession {
  readonly child: ChildProcessWithoutNullStreams | null;
  readonly connection: ClientConnection;
  readonly initializeResponse: InitializeResponse;
  readonly authenticatedMethodId: string | null;
  readonly usedLoginShell: boolean;

  private stderr = '';
  private stopPromise: Promise<void> | null = null;

  private constructor(
    child: ChildProcessWithoutNullStreams | null,
    private readonly transport: GrokAcpTransport,
    connection: ClientConnection,
    initializeResponse: InitializeResponse,
    authenticatedMethodId: string | null,
    usedLoginShell: boolean,
  ) {
    this.child = child;
    this.connection = connection;
    this.initializeResponse = initializeResponse;
    this.authenticatedMethodId = authenticatedMethodId;
    this.usedLoginShell = usedLoginShell;
  }

  static async start(options: GrokAcpProcessOptions): Promise<NativeGrokAcpProcess> {
    const launched = spawnGrokChild(options);
    const { child } = launched;

    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });

    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      let delivered = false;
      const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (delivered) return;
        delivered = true;
        resolve(Object.freeze({ code, signal }));
      };
      child.once('exit', finish);
      child.once('error', () => finish(null, null));
      if (child.exitCode !== null || child.signalCode !== null) {
        queueMicrotask(() => finish(child.exitCode, child.signalCode));
      }
    });
    const transport: GrokAcpTransport = {
      diagnosticStreams: [child.stderr, ...(launched.startupOutput ? [launched.startupOutput] : [])],
      exited,
      input: child.stdin,
      output: launched.protocolOutput,
      pid: child.pid ?? null,
      usedLoginShell: launched.usedLoginShell,
      close: () => stopChild(child),
    };
    return await this.startTransport(transport, options, child) as NativeGrokAcpProcess;
  }

  static connect(channel: GrokAcpChannel, options: GrokAcpClientOptions): Promise<GrokAcpProcess> {
    return this.startTransport({
      diagnosticStreams: [],
      exited: channel.exited,
      input: channel.stream,
      output: channel.stream,
      pid: null,
      usedLoginShell: false,
      close: () => channel.close(),
    }, options, null);
  }

  private static async startTransport(
    transport: GrokAcpTransport,
    options: GrokAcpClientOptions,
    child: ChildProcessWithoutNullStreams | null,
  ): Promise<GrokAcpProcess> {
    let instance: GrokAcpProcess | null = null;
    let startupStderr = '';
    const app = client({ name: 'Agent Deck' })
      .onNotification(methods.client.session.update, ({ params }) => {
        try {
          options.onSessionUpdate(params);
        } catch (error) {
          try {
            options.onSessionUpdateError?.(error, params);
          } catch {
            // Application diagnostics must not terminate the ACP read loop either.
          }
        }
      })
      .onNotification(
        GROK_EXTENSION_UPDATE_METHOD,
        parseGrokExtensionNotification,
        ({ params }) => options.onGrokExtensionUpdate?.(params),
      )
      .onNotification(
        GROK_EXTENSION_NOTIFICATION_METHOD,
        parseGrokExtensionNotification,
        ({ params }) => options.onGrokExtensionUpdate?.(params),
      )
      .onNotification(
        GROK_PROMPT_COMPLETE_METHOD,
        parseGrokPromptCompleteNotification,
        ({ params }) => {
          try {
            options.onGrokPromptComplete?.(params);
          } catch {
            // A consumer failure must not strand the ACP response reader.
          }
        },
      )
      .onRequest(methods.client.session.requestPermission, ({ params, signal }) =>
        options.onPermissionRequest(params, signal),
      );

    const stream = ndJsonStream(
      Writable.toWeb(transport.input) as WritableStream<Uint8Array>,
      Readable.toWeb(transport.output) as ReadableStream<Uint8Array>,
    );
    const connection = app.connect(stream);
    for (const diagnostic of transport.diagnosticStreams) {
      diagnostic.setEncoding('utf8');
      diagnostic.on('data', (chunk: string) => {
        if (instance) {
          instance.stderr = `${instance.stderr}${chunk}`.slice(-STDERR_LIMIT);
        } else {
          startupStderr = `${startupStderr}${chunk}`.slice(-STDERR_LIMIT);
        }
      });
    }

    try {
      const initializeResponse = await withTimeout(
        connection.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
            plan: {},
          },
          clientInfo: { name: 'Agent Deck', version: '0.1.0' },
        }),
        START_TIMEOUT_MS,
        'Grok Build ACP initialize',
      );
      const authenticatedMethodId =
        options.authenticate === false
          ? null
          : await authenticateGrokConnection(connection, initializeResponse);
      instance = new GrokAcpProcess(
        child,
        transport,
        connection,
        initializeResponse,
        authenticatedMethodId,
        transport.usedLoginShell,
      );
      instance.stderr = startupStderr;
      return instance;
    } catch (error) {
      connection.close(error);
      let cleanupError: unknown;
      try { await transport.close(); } catch (cause) { cleanupError = cause; }
      const diagnostics = startupStderr.trim();
      const startupError = new Error(
        `${error instanceof Error ? error.message : String(error)}${
          diagnostics ? `\n${diagnostics}` : ''
        }`,
        { cause: error },
      );
      if (cleanupError) {
        throw new AggregateError(
          [startupError, cleanupError],
          'Grok Build ACP startup cleanup failed',
        );
      }
      throw startupError;
    }
  }

  get diagnostics(): string {
    return this.stderr.trim();
  }

  get isStopping(): boolean {
    return this.stopPromise !== null;
  }

  get pid(): number | null {
    return this.transport.pid;
  }

  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    let delivered = false;
    const deliver = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (delivered) return;
      delivered = true;
      listener(code, signal);
    };
    void this.transport.exited.then(
      ({ code, signal }) => deliver(code, signal),
      () => deliver(null, null),
    );
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.stopOnce();
    return this.stopPromise;
  }

  private async stopOnce(): Promise<void> {
    this.connection.close();
    await this.transport.close();
  }
}

function orderedGrokAuthMethods(
  authMethods: readonly AuthMethod[] | undefined,
): AuthMethod[] {
  if (!authMethods?.length) return [];
  const preferredIds = ['xai.api_key', 'cached_token'];
  const ordered = preferredIds.flatMap((id) => {
    const exact = authMethods.find(
      (method) => method.id === id && (!('type' in method) || method.type !== 'terminal'),
    );
    return exact ? [exact] : [];
  });
  return ordered;
}

async function authenticateGrokConnection(
  connection: ClientConnection,
  initializeResponse: InitializeResponse,
): Promise<string | null> {
  const authMethods = initializeResponse.authMethods ?? [];
  if (authMethods.length === 0) return null;
  const candidates = orderedGrokAuthMethods(authMethods);
  if (candidates.length === 0) {
    const ids = authMethods.map((method) => method.id).join(', ');
    throw new Error(
      `Grok Build ACP 需要交互式认证（${ids}）。请在终端运行 "grok login --oauth"，或通过 ~/.grok/config.toml 和导出的环境变量配置 API key，然后重启 Agent Deck。`,
    );
  }
  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      await withTimeout(
        connection.agent.request(methods.agent.authenticate, {
          methodId: candidate.id,
          _meta: { headless: true },
        }),
        START_TIMEOUT_MS,
        `Grok Build ACP authenticate (${candidate.id})`,
      );
      return candidate.id;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `Grok Build ACP authenticate 对 ${candidates.map((method) => `"${method.id}"`).join('、')} 均失败：${
      lastError instanceof Error ? lastError.message : String(lastError)
    }。请运行 "grok login --oauth"，或确认 ~/.grok/config.toml 中为 API key 配置的 env_key 已由登录 shell 导出。`,
    { cause: lastError },
  );
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise<true>((resolve) => child.once('exit', () => resolve(true))),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), STOP_TIMEOUT_MS)),
  ]);
  if (exited || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, STOP_TIMEOUT_MS)),
  ]);
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} 在 ${timeoutMs}ms 后超时`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
