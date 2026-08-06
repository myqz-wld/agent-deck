// ────────────────────────────────────────────────────────────────────────────
// Phase 4 Step 4.9 拆分:adapter context 与基础 enum 类型(纯 declaration)。
// 收纳:AdapterContext + PermissionMode。
// ────────────────────────────────────────────────────────────────────────────

import type { RouteOptions } from 'fastify';
import type { AgentEvent, PermissionMode as SharedPermissionMode } from '@shared/types';

/** Provider-facing view of the shared hook/MCP listener. */
export interface AdapterHookServerPort {
  readonly isRunning: boolean;
  readonly listeningPort: number;
  readonly bearerToken: string;
  readonly mcpBearerToken: string;
}

/** Provider-facing route registration boundary. */
export interface AdapterRouteRegistryPort {
  registerForAdapter(adapterId: string, route: RouteOptions): void;
}

export interface AdapterContext {
  hookServer: AdapterHookServerPort;
  routeRegistry: AdapterRouteRegistryPort;
  emit: (event: AgentEvent) => void;
  paths: {
    appUserData: string;
    userHome: string;
    userClaudeSettings: string;
  };
}

export type PermissionMode = SharedPermissionMode;
