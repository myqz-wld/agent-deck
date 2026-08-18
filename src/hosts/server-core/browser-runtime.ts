import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { CodexConfigObject } from '@main/codex-config/agent-deck-mcp-injector';
import {
  startBrowserCliBrokerCore,
  type BrowserCliBrokerExecutor,
  type BrowserCliBrokerHandle,
} from '@main/browser-use/browser-cli-broker-core';
import {
  BROWSER_LEASE_MAX_TTL_MS,
  BrowserLeaseRegistryCore,
} from '@main/browser-use/browser-lease-registry-core';
import {
  BROWSER_RUNTIME_BIN_ENV,
  BROWSER_RUNTIME_KEY_ENV,
  BrowserRuntimeContextManager,
  type PreparedBrowserRuntimeContext,
} from '@main/browser-use/browser-runtime-context';
import type { RuntimeAdapterId } from '@shared/types';
import type { ProviderSessionBrowserContext } from '@contracts/index';
import { relayBrowserCliFrame } from '@main/browser-use/browser-cli-frame-relay';
import { BrowserUseFrameDecoder, encodeBrowserUseFrame } from '@main/browser-use/protocol';
import {
  BROWSER_CLI_MAX_REQUEST_BYTES,
  BROWSER_CLI_MAX_RESPONSE_BYTES,
  safeBrowserCliOperation,
} from '@main/browser-use/browser-cli-broker-protocol';
import { browserOperationFailure } from '@main/browser-use/operation-contract';

export interface ServerCoreBrowserRuntimeOptions {
  readonly privateRoot: string;
  readonly executablePath: string;
  readonly cliPath: string;
  readonly execute: BrowserCliBrokerExecutor;
  readonly skillEnabled: (adapterId: RuntimeAdapterId) => boolean;
  readonly platform?: NodeJS.Platform;
  readonly startBroker?: typeof startBrowserCliBrokerCore;
}

export type ServerCoreProviderBrowserRuntimePort = Pick<
  ServerCoreBrowserRuntime,
  | 'allowClaudeSocket'
  | 'codexSocketConfig'
  | 'prepare'
  | 'preparePortable'
  | 'refresh'
  | 'relay'
  | 'renameSession'
  | 'revokeSession'
>;

function brokerEndpoint(privateRoot: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') return `\\\\.\\pipe\\agent-deck-core-browser-${process.pid}`;
  const preferred = join(privateRoot, 'browser-cli', 'broker.sock');
  if (Buffer.byteLength(preferred) <= 103) return preferred;
  const digest = createHash('sha256').update(privateRoot).digest('hex').slice(0, 16);
  return join('/tmp', `adbc-${process.getuid?.() ?? process.pid}`, digest, 'b.sock');
}

/** Core-owned Browser CLI socket, lease registry, and per-provider command contexts. */
export class ServerCoreBrowserRuntime {
  private readonly registry = new BrowserLeaseRegistryCore();
  private readonly endpoint: string;
  private readonly manager: BrowserRuntimeContextManager;
  private readonly startBroker: typeof startBrowserCliBrokerCore;
  private broker: BrowserCliBrokerHandle | null = null;
  private readonly portableBySession = new Map<string, {
    readonly artifactHostRoot: string;
    readonly context: ProviderSessionBrowserContext;
  }>();
  private readonly portableRootBySource = new Map<string, string>();
  private state: 'idle' | 'starting' | 'running' | 'closing' | 'closed' = 'idle';

  constructor(private readonly options: ServerCoreBrowserRuntimeOptions) {
    const root = join(options.privateRoot, 'browser-cli');
    this.endpoint = brokerEndpoint(options.privateRoot, options.platform ?? process.platform);
    this.manager = new BrowserRuntimeContextManager({
      rootDir: join(root, 'runtimes'),
      brokerEndpoint: this.endpoint,
      executablePath: options.executablePath,
      cliPath: options.cliPath,
      registry: this.registry,
      platform: options.platform,
    });
    this.startBroker = options.startBroker ?? startBrowserCliBrokerCore;
  }

  async start(): Promise<void> {
    if (this.state === 'running') return;
    if (this.state !== 'idle') throw new Error('Server Core Browser runtime is closed');
    this.state = 'starting';
    try {
      this.broker = await this.startBroker({
        pipePath: this.endpoint,
        registry: this.registry,
        execute: this.options.execute,
      });
      this.state = 'running';
    } catch (error) {
      this.manager.shutdown();
      this.state = 'closed';
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.state === 'closed') return;
    if (this.state === 'idle') {
      this.manager.shutdown();
      this.state = 'closed';
      return;
    }
    if (this.state === 'closing') return;
    this.state = 'closing';
    this.manager.shutdown();
    this.portableBySession.clear();
    this.portableRootBySource.clear();
    try {
      await this.broker?.shutdown();
    } finally {
      this.broker = null;
      this.state = 'closed';
    }
  }

  prepare(input: {
    readonly applicationSessionId: string;
    readonly adapterId: RuntimeAdapterId;
    readonly environment: Readonly<Record<string, string>>;
  }): PreparedBrowserRuntimeContext | null {
    if (this.state !== 'running' || !this.options.skillEnabled(input.adapterId)) return null;
    this.revokeSession(input.applicationSessionId);
    return this.manager.prepare(input);
  }

  preparePortable(input: {
    readonly applicationSessionId: string;
    readonly artifactHostRoot: string;
    readonly adapterId: RuntimeAdapterId;
  }): ProviderSessionBrowserContext | null {
    if (this.state !== 'running' || !this.options.skillEnabled(input.adapterId)) return null;
    this.revokeSession(input.applicationSessionId);
    const runtimeGeneration = 1;
    const sourceIdentity = randomUUID();
    const issued = this.registry.issue({
      applicationSessionId: input.applicationSessionId,
      adapterId: input.adapterId,
      runtimeGeneration,
      sourceIdentity,
    }, BROWSER_LEASE_MAX_TTL_MS);
    const context: ProviderSessionBrowserContext = Object.freeze({
      protocolVersion: 1,
      adapterId: input.adapterId,
      lease: issued.lease,
      runtimeGeneration,
      sourceIdentity,
    });
    if (!isAbsolute(input.artifactHostRoot) || resolve(input.artifactHostRoot) !==
        input.artifactHostRoot) {
      this.registry.revoke(issued.lease);
      throw new Error('Portable Browser artifact root is invalid');
    }
    this.portableBySession.set(input.applicationSessionId, {
      artifactHostRoot: input.artifactHostRoot,
      context,
    });
    this.portableRootBySource.set(sourceIdentity, input.artifactHostRoot);
    return context;
  }

  refresh(environment: Readonly<Record<string, string>>): PreparedBrowserRuntimeContext | null {
    if (this.state !== 'running') return null;
    const runtimeKey = environment[BROWSER_RUNTIME_KEY_ENV];
    return runtimeKey == null ? null : this.manager.refresh(runtimeKey);
  }

  async relay(request: Buffer, signal?: AbortSignal): Promise<Buffer> {
    if (this.state !== 'running') {
      return this.relayFailure(request);
    }
    try {
      return await relayBrowserCliFrame(this.endpoint, request, signal);
    } catch {
      return this.relayFailure(request);
    }
  }

  revokeSession(sessionId: string): number {
    const record = this.portableBySession.get(sessionId);
    const portable = this.portableBySession.delete(sessionId) ? 1 : 0;
    if (record) this.portableRootBySource.delete(record.context.sourceIdentity);
    const managed = this.manager.revokeSession(sessionId);
    this.registry.revokeSession(sessionId);
    return portable + managed;
  }

  renameSession(fromId: string, toId: string): number {
    const managed = this.manager.renameSession(fromId, toId);
    const portable = this.portableBySession.get(fromId);
    if (portable == null) return managed;
    if (managed === 0) this.registry.renameSession(fromId, toId);
    this.portableBySession.delete(fromId);
    this.portableBySession.set(toId, portable);
    return managed + 1;
  }

  projectArtifactPath(sourceIdentity: string, path: string): string {
    const root = this.portableRootBySource.get(sourceIdentity);
    if (!root) return path;
    const relation = relative(root, path);
    if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
      throw new Error('Portable Browser artifact escaped its mounted Workspace');
    }
    const suffix = relation.split(sep).filter(Boolean).join('/');
    return suffix ? `/workspace/${suffix}` : '/workspace';
  }

  allowClaudeSocket<T extends {
    sandbox?: {
      network?: { allowUnixSockets?: string[]; [key: string]: unknown };
      [key: string]: unknown;
    };
  }>(sandboxOptions: T): T {
    if (this.options.platform === 'win32' || sandboxOptions.sandbox == null) {
      return sandboxOptions;
    }
    const existing = sandboxOptions.sandbox.network?.allowUnixSockets ?? [];
    return {
      ...sandboxOptions,
      sandbox: {
        ...sandboxOptions.sandbox,
        network: {
          ...sandboxOptions.sandbox.network,
          allowUnixSockets: [...new Set([...existing, this.endpoint])],
        },
      },
    };
  }

  codexSocketConfig(
    environment: Readonly<Record<string, string>>,
  ): CodexConfigObject {
    const pathValue = environment.PATH ?? environment.Path;
    const runtimeKey = environment[BROWSER_RUNTIME_KEY_ENV];
    const binDir = environment[BROWSER_RUNTIME_BIN_ENV];
    const explicitEnvironment: CodexConfigObject = {};
    if (pathValue) explicitEnvironment.PATH = pathValue;
    if (runtimeKey) explicitEnvironment[BROWSER_RUNTIME_KEY_ENV] = runtimeKey;
    if (binDir) explicitEnvironment[BROWSER_RUNTIME_BIN_ENV] = binDir;
    return {
      shell_environment_policy: { set: explicitEnvironment },
      ...(this.options.platform === 'win32'
        ? {}
        : {
            features: {
              network_proxy: {
                enabled: true,
                unix_sockets: { [this.endpoint]: 'allow' },
              },
            },
          }),
    };
  }

  diagnostics(): { readonly state: string; readonly leases: number } {
    return {
      state: this.state,
      leases: this.registry.diagnostics().activeLeases,
    };
  }

  private relayFailure(request: Buffer): Buffer {
    let operation: ReturnType<typeof safeBrowserCliOperation> = 'tabs';
    try {
      const decoder = new BrowserUseFrameDecoder({
        maxFrameBytes: BROWSER_CLI_MAX_REQUEST_BYTES,
        maxInputChunkBytes: BROWSER_CLI_MAX_REQUEST_BYTES + 4,
        maxMessagesPerInputChunk: 1,
        maxRetainedInputBytes: BROWSER_CLI_MAX_REQUEST_BYTES + 4,
        maxRetainedInputChunks: 8,
      });
      const value = decoder.push(request)[0];
      operation = safeBrowserCliOperation(
        value && typeof value === 'object' && !Array.isArray(value)
          ? (value as { request?: unknown }).request
          : undefined,
      );
    } catch {}
    return encodeBrowserUseFrame(browserOperationFailure(operation, {
      code: 'transport_unavailable',
      message: 'The connected desktop Browser bridge is unavailable.',
      retryable: true,
      nextAction: 'Keep a Browser-capable Agent Deck desktop connected, then retry.',
    }), BROWSER_CLI_MAX_RESPONSE_BYTES);
  }
}
