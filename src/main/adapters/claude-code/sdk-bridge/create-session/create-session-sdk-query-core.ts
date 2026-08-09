import type {
  McpSdkServerConfigWithInstance,
  Options,
} from '@anthropic-ai/claude-agent-sdk';
import type { SessionAdapterId } from '@shared/types';
import type { ClaudeSdkRuntimeOptions } from '../../sdk-runtime-core';
import type { SandboxMode } from '../../sandbox-config-core';
import type { InternalSession } from '../types';
import type {
  BuildClaudeQueryOptionsCoreArgs,
} from '../query-options-builder-core';
import type {
  GatewaySandboxOptions,
  GatewaySandboxSettingsCleanupHolder,
  PreparedGatewaySandboxSettings,
} from './gateway-sandbox-settings-core';

export type ClaudeSdkQueryOptionsArgs = Omit<
  BuildClaudeQueryOptionsCoreArgs,
  'agentDeckMcpToolPattern'
>;

/** Desktop-owned composition required to construct and retire one Claude SDK query. */
export interface ClaudeCreateSessionSdkQueryHost {
  loadSdk(): Promise<Pick<typeof import('@anthropic-ai/claude-agent-sdk'), 'query'>>;
  runtimeOptions(): ClaudeSdkRuntimeOptions;
  resolveBinary(): string | undefined;
  buildSandboxOptions(
    mode: SandboxMode | undefined,
    cwd: string,
    extraAllowWrite?: readonly string[],
  ): GatewaySandboxOptions;
  prepareGatewaySandboxSettings(input: {
    settingsPath?: string;
    sandboxOpts: GatewaySandboxOptions;
  }): PreparedGatewaySandboxSettings;
  buildMcpServers(
    internal: InternalSession,
    adapterId: Extract<SessionAdapterId, 'claude-code'>,
  ): Promise<{ agentDeckMcpServer: McpSdkServerConfigWithInstance | null }>;
  buildQueryOptions(args: ClaudeSdkQueryOptionsArgs): Options;
  systemPromptAppend(): string;
  plugins(selectedPluginDir?: string): NonNullable<Options['plugins']>;
  runtimeMetadataHooks(internal: InternalSession): NonNullable<Options['hooks']>;
  cleanupGatewaySandboxSettings(holder: GatewaySandboxSettingsCleanupHolder): void;
  observeSandboxConfiguration(message: string): void;
  warn(message: string, error: unknown): void;
}
