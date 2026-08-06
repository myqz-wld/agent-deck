import type {
  GrokBuildBridgeOptions,
  GrokSessionManagerPort,
} from './bridge-options';

interface GrokPluginProfileOptions {
  includeAgents: boolean;
  includeSkills: boolean;
}

export interface GrokInitializableBridge {
  probeCapabilities(cwd: string): Promise<boolean>;
}

export interface GrokAdapterHost<T extends GrokInitializableBridge> {
  readonly bridgeRuntimeHost: GrokBuildBridgeOptions['runtimeHost'];
  readonly sessionManager: GrokSessionManagerPort;
  createBridge(options: GrokBuildBridgeOptions): T;
  reportStartupCleanupFailure(sessionId: string, error: unknown): void;
  loadBaselinePrompt(): Promise<string | null>;
  preparePluginProfile(options: GrokPluginProfileOptions): Promise<string | null>;
  readBinaryPath(): string | null;
  readDefaultSandbox(): string;
  readInjectAgents(): boolean;
  readInjectAgentPrompt(): boolean;
  readInjectSkills(): boolean;
  readMcpEnabled(): boolean;
  readMcpHttpEnabled(): boolean;
  readPermissionTimeoutMs(): number;
}

/** Build the Grok bridge while keeping dynamic injection policy host driven. */
export function createGrokAdapterBridgeWithHost<T extends GrokInitializableBridge>(
  host: GrokAdapterHost<T>,
  emit: GrokBuildBridgeOptions['emit'],
  mcpHttpUrl: string,
  onNegotiatedImageCapability: (supported: boolean) => void,
): T {
  return host.createBridge({
    runtimeHost: host.bridgeRuntimeHost,
    emit,
    sessionManager: host.sessionManager,
    reportStartupCleanupFailure: (sessionId, error) =>
      host.reportStartupCleanupFailure(sessionId, error),
    mcpHttpUrl,
    isAgentDeckMcpEnabled: () =>
      host.readMcpEnabled() && host.readMcpHttpEnabled(),
    getAgentProfilePrompt: () =>
      host.readInjectAgentPrompt()
        ? host.loadBaselinePrompt()
        : Promise.resolve(null),
    getPluginDirectories: async ({ agentSource, agentPluginDir }) => {
      const root = await host.preparePluginProfile({
        includeSkills: host.readInjectSkills(),
        includeAgents:
          agentSource === 'bundled' ||
          ((agentSource === null || agentSource === undefined) &&
            host.readInjectAgents()),
      });
      return [
        ...new Set([
          ...(agentPluginDir ? [agentPluginDir] : []),
          ...(root ? [root] : []),
        ]),
      ];
    },
    onNegotiatedImageCapability,
    permissionTimeoutMs: host.readPermissionTimeoutMs(),
    binaryPath: host.readBinaryPath(),
  });
}

/** Preserve explicit and resume semantics before consulting the desktop default. */
export function resolveGrokCreateSandboxWithHost(
  host: Pick<GrokAdapterHost<GrokInitializableBridge>, 'readDefaultSandbox'>,
  explicit: string | null | undefined,
  resume: string | undefined,
): string | null | undefined {
  if (explicit !== undefined) return explicit;
  return resume ? undefined : host.readDefaultSandbox();
}
