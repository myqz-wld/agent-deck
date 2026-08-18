import type { GrokAcpSessionFactory } from '@main/adapters/grok-build/acp-process';
import type { RuntimeAdapterId, SessionRecord } from '@shared/types';

import { ServerCoreBrowserArtifactStore } from './browser-artifact-store';
import { createServerCoreBrowserCliExecutor } from './browser-cli-executor';
import { ServerCoreBrowserRuntime } from './browser-runtime';
import type { ServerCoreDesktopBrokerPort } from './desktop-broker-port';
import type { ServerCoreProviderSettings } from './provider-settings';
import type { ServerCoreProviderGrokContainerPort } from './runtime-provider-container';

export const SERVER_CORE_BROWSER_CLI = '/opt/agent-deck/bin/agent-deck-browser.cjs';

function skillEnabled(
  settings: ServerCoreProviderSettings,
  adapterId: RuntimeAdapterId,
): boolean {
  if (adapterId === 'claude-code') return settings.injectAgentDeckClaudeSkills;
  if (adapterId === 'codex-cli') return settings.injectAgentDeckCodexSkills;
  return settings.injectAgentDeckGrokSkills;
}

export function createServerCoreBrowserComposition(input: {
  readonly cliPath?: string;
  readonly desktopBroker: Pick<ServerCoreDesktopBrokerPort, 'invoke'>;
  readonly grokContainer: ServerCoreProviderGrokContainerPort | null;
  readonly privateRoot: string;
  readonly providerSettings: ServerCoreProviderSettings;
  readonly sessions: { get(sessionId: string): SessionRecord | null };
  readonly workspaceRoot: string;
}): {
  readonly browserRuntime: ServerCoreBrowserRuntime;
  readonly grokProcessFactory?: GrokAcpSessionFactory;
} {
  const artifacts = new ServerCoreBrowserArtifactStore({
    workspaceRoot: input.workspaceRoot,
    getSession: (sessionId) => input.sessions.get(sessionId),
  });
  let browserRuntime!: ServerCoreBrowserRuntime;
  browserRuntime = new ServerCoreBrowserRuntime({
    privateRoot: input.privateRoot,
    executablePath: process.execPath,
    cliPath: input.cliPath ?? SERVER_CORE_BROWSER_CLI,
    execute: createServerCoreBrowserCliExecutor({
      desktopBroker: input.desktopBroker,
      artifacts: {
        persist: async (artifact) => browserRuntime.projectArtifactPath(
          artifact.sourceIdentity,
          await artifacts.persist(artifact),
        ),
      },
    }),
    skillEnabled: (adapterId) => skillEnabled(input.providerSettings, adapterId),
  });
  input.grokContainer?.configureBrowserRelay?.((request, signal) =>
    browserRuntime.relay(request, signal));
  if (!input.grokContainer) return Object.freeze({ browserRuntime });
  const grokProcessFactory: GrokAcpSessionFactory = async (factoryInput) => {
    const browserContext = browserRuntime.preparePortable({
      applicationSessionId: factoryInput.applicationSessionId,
      adapterId: 'grok-build',
      artifactHostRoot: factoryInput.sandboxProfile === 'strict'
        ? factoryInput.cwd
        : input.workspaceRoot,
    });
    try {
      return await input.grokContainer!.processFactory({
        ...factoryInput,
        ...(browserContext ? { browserContext } : {}),
      });
    } catch (error) {
      browserRuntime.revokeSession(factoryInput.applicationSessionId);
      throw error;
    }
  };
  return Object.freeze({ browserRuntime, grokProcessFactory });
}
