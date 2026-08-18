import { createHash } from 'node:crypto';
import { join } from 'node:path';

import type { CodexConfigObject } from '@main/codex-config/agent-deck-mcp-injector';
import {
  startBrowserCliBrokerCore,
  type BrowserCliBrokerExecutor,
  type BrowserCliBrokerHandle,
} from '@main/browser-use/browser-cli-broker-core';
import { BrowserLeaseRegistryCore } from '@main/browser-use/browser-lease-registry-core';
import {
  BROWSER_RUNTIME_BIN_ENV,
  BROWSER_RUNTIME_KEY_ENV,
  BrowserRuntimeContextManager,
  type PreparedBrowserRuntimeContext,
} from '@main/browser-use/browser-runtime-context';
import type { RuntimeAdapterId } from '@shared/types';

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
  | 'refresh'
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
    return this.manager.prepare(input);
  }

  refresh(environment: Readonly<Record<string, string>>): PreparedBrowserRuntimeContext | null {
    if (this.state !== 'running') return null;
    const runtimeKey = environment[BROWSER_RUNTIME_KEY_ENV];
    return runtimeKey == null ? null : this.manager.refresh(runtimeKey);
  }

  revokeSession(sessionId: string): number {
    return this.manager.revokeSession(sessionId);
  }

  renameSession(fromId: string, toId: string): number {
    return this.manager.renameSession(fromId, toId);
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
}
