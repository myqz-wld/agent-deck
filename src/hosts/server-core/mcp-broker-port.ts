import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type {
  AdapterHookServerPort,
  AdapterRouteRegistryPort,
} from '@main/adapters/types';
import type { SessionAdapterId } from '@shared/types';

export interface ServerCoreMcpBrokerPort
  extends AdapterHookServerPort, AdapterRouteRegistryPort {
  start(): Promise<void>;
  stop(): Promise<void>;
  createInProcessServer(
    callerSessionId: () => string,
    adapterId: SessionAdapterId,
  ): Promise<McpSdkServerConfigWithInstance>;
}
