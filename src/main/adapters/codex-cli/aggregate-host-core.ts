import { join } from 'node:path';

import type { StoredAgentEvent } from '@shared/types';
import type { CodexCliAdapterHost } from './adapter-core';
import type { CodexAdapterInitHost } from './adapter-init-core';
import { buildCodexHookRoutes } from './hook-routes';
import type { CodexHookRoutePorts } from './hook-route-ports';
import {
  CodexHookInstaller,
  type CodexHookInstallerObserver,
} from './hook-installer';
import type { CodexSdkBridge } from './sdk-bridge';
import {
  summariseCodexSessionWithHost,
  type CodexSummaryRunnerHost,
} from './summarizer-runner-core';

export interface CodexProviderResolverPort {
  resolveProvider(provider: string | null | undefined): string | undefined;
}

export interface CodexAggregateSummaryPort extends CodexSummaryRunnerHost {
  formatEvents(events: StoredAgentEvent[]): string;
}

export interface CodexCliAggregateHostOptions {
  readonly bridge: CodexAdapterInitHost<CodexSdkBridge>;
  readonly hookRoutes: CodexHookRoutePorts;
  readonly hookInstallerObserver: CodexHookInstallerObserver;
  readonly providerResolver: CodexProviderResolverPort;
  readonly summary: CodexAggregateSummaryPort;
}

/** Construct one complete Codex adapter host without desktop singleton discovery. */
export function createCodexCliAdapterHost(
  options: CodexCliAggregateHostOptions,
): CodexCliAdapterHost {
  const bridge: CodexAdapterInitHost<CodexSdkBridge> = Object.freeze({
    ...options.bridge,
  });

  return Object.freeze({
    bridge,
    createHookIntegration: (context) =>
      new CodexHookInstaller(
        context.hookServer.listeningPort,
        context.hookServer.bearerToken,
        join(context.paths.appUserData, 'hook-relay'),
        options.hookInstallerObserver,
        context.paths.userHome,
      ),
    registerHookRoutes: (context, adapterId) => {
      for (const route of buildCodexHookRoutes(context.emit, options.hookRoutes)) {
        context.routeRegistry.registerForAdapter(adapterId, route);
      }
    },
    resolveProvider: (provider) =>
      options.providerResolver.resolveProvider(provider),
    summariseEvents: (cwd, events, evidenceContext, runtime) =>
      summariseCodexSessionWithHost(
        options.summary,
        cwd,
        events,
        (input) => options.summary.formatEvents(input),
        evidenceContext,
        runtime,
      ),
  });
}
