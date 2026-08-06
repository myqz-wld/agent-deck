import { join } from 'node:path';

import type { HookRouteDiagnostics } from '@main/hook-server/route-diagnostics';
import type { GrokBuildAdapterHost } from './adapter-core';
import type { GrokAdapterHost } from './adapter-host-core';
import { GrokBuildBridge } from './bridge';
import type { GrokBridgeRuntimeHost } from './bridge-runtime-core';
import type { GrokSessionManagerPort } from './bridge-options';
import { buildGrokHookRoutes } from './hook-routes';
import {
  GrokHookInstaller,
  type GrokHookInstallerObserver,
} from './hook-installer';
import type { GrokPluginProfileOptions } from './resource-store';
import {
  summariseGrokSessionWithHost,
  type GrokSummaryRunnerHost,
} from './summarizer-runner-core';

export interface GrokBuildProviderSettingsPort extends GrokSummaryRunnerHost {
  readDefaultSandbox(): string;
  readInjectAgents(): boolean;
  readInjectAgentPrompt(): boolean;
  readInjectSkills(): boolean;
  readMcpEnabled(): boolean;
  readMcpHttpEnabled(): boolean;
  readPermissionTimeoutMs(): number;
}

export interface GrokBuildResourcePort {
  loadBaselinePrompt(): Promise<string | null>;
  preparePluginProfile(options: GrokPluginProfileOptions): Promise<string | null>;
}

export interface GrokBuildAdapterDiagnosticsPort {
  reportStartupCleanupFailure(sessionId: string, error: unknown): void;
  reportCapabilityProbeSkipped(error: unknown): void;
}

export interface GrokBuildAggregateHostOptions {
  readonly runtimeHost: GrokBridgeRuntimeHost;
  readonly sessionManager: GrokSessionManagerPort;
  readonly settings: GrokBuildProviderSettingsPort;
  readonly resources: GrokBuildResourcePort;
  readonly hookDiagnostics: HookRouteDiagnostics;
  readonly hookInstallerObserver: GrokHookInstallerObserver;
  readonly diagnostics: GrokBuildAdapterDiagnosticsPort;
}

/** Construct one complete Grok adapter host without desktop singleton discovery. */
export function createGrokBuildAdapterHost(
  options: GrokBuildAggregateHostOptions,
): GrokBuildAdapterHost {
  const bridge: GrokAdapterHost<GrokBuildBridge> = Object.freeze({
    bridgeRuntimeHost: options.runtimeHost,
    sessionManager: options.sessionManager,
    createBridge: (bridgeOptions) => new GrokBuildBridge(bridgeOptions),
    reportStartupCleanupFailure: (sessionId, error) =>
      options.diagnostics.reportStartupCleanupFailure(sessionId, error),
    loadBaselinePrompt: () => options.resources.loadBaselinePrompt(),
    preparePluginProfile: (profile) =>
      options.resources.preparePluginProfile(profile),
    readBinaryPath: () => options.settings.readBinaryPath(),
    readDefaultSandbox: () => options.settings.readDefaultSandbox(),
    readInjectAgents: () => options.settings.readInjectAgents(),
    readInjectAgentPrompt: () => options.settings.readInjectAgentPrompt(),
    readInjectSkills: () => options.settings.readInjectSkills(),
    readMcpEnabled: () => options.settings.readMcpEnabled(),
    readMcpHttpEnabled: () => options.settings.readMcpHttpEnabled(),
    readPermissionTimeoutMs: () => options.settings.readPermissionTimeoutMs(),
  });

  return Object.freeze({
    bridge,
    createHookIntegration: (context) =>
      new GrokHookInstaller(
        context.hookServer.listeningPort,
        context.hookServer.bearerToken,
        join(context.paths.appUserData, 'hook-relay'),
        options.hookInstallerObserver,
      ),
    registerHookRoutes: (context, adapterId) => {
      for (const route of buildGrokHookRoutes(
        context.emit,
        options.hookDiagnostics,
      )) {
        context.routeRegistry.registerForAdapter(adapterId, route);
      }
    },
    reportCapabilityProbeSkipped: (error) =>
      options.diagnostics.reportCapabilityProbeSkipped(error),
    summariseEvents: (cwd, events, evidenceContext, runtime) =>
      summariseGrokSessionWithHost(
        options.settings,
        cwd,
        events,
        evidenceContext,
        runtime,
      ),
  });
}
