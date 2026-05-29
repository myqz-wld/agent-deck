// ────────────────────────────────────────────────────────────────────────────
// Phase 4 Step 4.9 拆分:adapter context 与基础 enum 类型(纯 declaration)。
// 收纳:AdapterContext + PermissionMode。
// ────────────────────────────────────────────────────────────────────────────

import type { AgentEvent } from '@shared/types';
import type { HookServer } from '@main/hook-server/server';
import type { RouteRegistry } from '@main/hook-server/route-registry';

export interface AdapterContext {
  hookServer: HookServer;
  routeRegistry: RouteRegistry;
  emit: (event: AgentEvent) => void;
  paths: {
    userHome: string;
    userClaudeSettings: string;
  };
}

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
