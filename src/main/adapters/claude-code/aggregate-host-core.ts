import { join } from 'node:path';

import type { HookRouteDiagnostics } from '@main/hook-server/route-diagnostics';
import type { ClaudeCodeAdapterHost } from './adapter-core';
import type { ClaudeAdapterInitHost } from './adapter-init-core';
import type { ClaudeFamilyForkHost } from './fork-session-core';
import { buildHookRoutes } from './hook-routes';
import {
  HookInstallerCore,
  type ClaudeHookInstallerObserver,
} from './hook-installer-core';
import type { ClaudeSdkBridge } from './sdk-bridge';

export interface ClaudeCodeForkSafetyPort {
  validateForkTarget(gateway: string | null | undefined): void;
}

export interface ClaudeCodeSummaryPort {
  summariseEvents: ClaudeCodeAdapterHost['summariseEvents'];
}

export interface ClaudeCodeAggregateHostOptions {
  readonly bridge: ClaudeAdapterInitHost<ClaudeSdkBridge>;
  readonly fork: ClaudeFamilyForkHost;
  readonly hookDiagnostics: HookRouteDiagnostics;
  readonly hookInstallerObserver: ClaudeHookInstallerObserver;
  readonly forkSafety: ClaudeCodeForkSafetyPort;
  readonly summary: ClaudeCodeSummaryPort;
}

/** Construct one complete Claude adapter host without desktop singleton discovery. */
export function createClaudeCodeAdapterHost(
  options: ClaudeCodeAggregateHostOptions,
): ClaudeCodeAdapterHost {
  const bridge: ClaudeAdapterInitHost<ClaudeSdkBridge> = Object.freeze({
    ...options.bridge,
  });

  return Object.freeze({
    bridge,
    fork: options.fork,
    createHookIntegration: (context) =>
      new HookInstallerCore(
        context.hookServer.listeningPort,
        context.hookServer.bearerToken,
        join(context.paths.appUserData, 'hook-relay'),
        options.hookInstallerObserver,
        context.paths.userHome,
      ),
    registerHookRoutes: (context, adapterId) => {
      for (const route of buildHookRoutes(
        context.emit,
        options.hookDiagnostics,
      )) {
        context.routeRegistry.registerForAdapter(adapterId, route);
      }
    },
    validateForkTarget: (gateway) =>
      options.forkSafety.validateForkTarget(gateway),
    summariseEvents: (cwd, events, evidenceContext, runtime) =>
      options.summary.summariseEvents(
        cwd,
        events,
        evidenceContext,
        runtime,
      ),
  });
}
