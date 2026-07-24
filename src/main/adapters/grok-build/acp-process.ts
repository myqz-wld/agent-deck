import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { Readable, Writable } from 'node:stream';

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

const STDERR_LIMIT = 64 * 1024;
const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 2_000;

export interface GrokAcpProcessOptions {
  binary: string;
  /** Test seam for a deterministic fake ACP child. Production always uses Grok's fixed args. */
  args?: string[];
  cwd: string;
  onSessionUpdate: (notification: SessionNotification) => void;
  onPermissionRequest: (
    request: RequestPermissionRequest,
    signal: AbortSignal,
  ) => Promise<RequestPermissionResponse>;
  /** Capability probes initialize only; real session children authenticate before new/load. */
  authenticate?: boolean;
}

export class GrokAcpProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly connection: ClientConnection;
  readonly initializeResponse: InitializeResponse;
  readonly authenticatedMethodId: string | null;
  readonly usedLoginShell: boolean;

  private stderr = '';
  private stopping = false;

  private constructor(
    child: ChildProcessWithoutNullStreams,
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

  static async start(options: GrokAcpProcessOptions): Promise<GrokAcpProcess> {
    const launched = spawnGrokChild(options);
    const { child } = launched;

    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });

    let instance: GrokAcpProcess | null = null;
    let startupStderr = '';
    const app = client({ name: 'Agent Deck' })
      .onNotification(methods.client.session.update, ({ params }) => {
        options.onSessionUpdate(params);
      })
      .onRequest(methods.client.session.requestPermission, ({ params, signal }) =>
        options.onPermissionRequest(params, signal),
      );

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(launched.protocolOutput) as ReadableStream<Uint8Array>,
    );
    const connection = app.connect(stream);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (instance) {
        instance.stderr = `${instance.stderr}${chunk}`.slice(-STDERR_LIMIT);
      } else {
        startupStderr = `${startupStderr}${chunk}`.slice(-STDERR_LIMIT);
      }
    });
    if (launched.startupOutput) {
      launched.startupOutput.setEncoding('utf8');
      launched.startupOutput.on('data', (chunk: string) => {
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
        'Grok ACP initialize',
      );
      const authenticatedMethodId =
        options.authenticate === false
          ? null
          : await authenticateGrokConnection(connection, initializeResponse);
      instance = new GrokAcpProcess(
        child,
        connection,
        initializeResponse,
        authenticatedMethodId,
        launched.usedLoginShell,
      );
      instance.stderr = startupStderr;
      return instance;
    } catch (error) {
      connection.close(error);
      await stopChild(child);
      const diagnostics = startupStderr.trim();
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}${
          diagnostics ? `\n${diagnostics}` : ''
        }`,
        { cause: error },
      );
    }
  }

  get diagnostics(): string {
    return this.stderr.trim();
  }

  get isStopping(): boolean {
    return this.stopping;
  }

  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    let delivered = false;
    const deliver = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (delivered) return;
      delivered = true;
      listener(code, signal);
    };
    this.child.once('exit', deliver);
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      queueMicrotask(() => deliver(this.child.exitCode, this.child.signalCode));
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.connection.close();
    await stopChild(this.child);
  }
}

export function selectGrokAuthMethod(
  authMethods: readonly AuthMethod[] | undefined,
): AuthMethod | null {
  return orderedGrokAuthMethods(authMethods)[0] ?? null;
}

function orderedGrokAuthMethods(
  authMethods: readonly AuthMethod[] | undefined,
): AuthMethod[] {
  if (!authMethods?.length) return [];
  const preferredIds = ['xai.api_key', 'cached_token'];
  const ordered = preferredIds.flatMap((id) => {
    const exact = authMethods.find((method) => method.id === id);
    return exact ? [exact] : [];
  });
  for (const method of authMethods) {
    if (
      'type' in method &&
      method.type === 'env_var' &&
      !ordered.some((candidate) => candidate.id === method.id)
    ) {
      ordered.push(method);
    }
  }
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
      `Grok ACP requires interactive authentication (${ids}). Run "grok login --oauth" in a terminal, or configure an API key through ~/.grok/config.toml and an exported environment variable, then restart Agent Deck.`,
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
        `Grok ACP authenticate (${candidate.id})`,
      );
      return candidate.id;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `Grok ACP authentication failed for ${candidates.map((method) => `"${method.id}"`).join(', ')}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }. Run "grok login --oauth", or verify the API-key env_key configured in ~/.grok/config.toml is exported by your login shell.`,
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
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
