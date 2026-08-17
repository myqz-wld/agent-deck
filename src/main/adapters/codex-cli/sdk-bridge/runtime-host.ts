import * as mcpSessionTokenMap from '@main/agent-deck-mcp/mcp-session-token-map';
import { desktopSessionModelControllerHost } from '@main/adapters/session-model-controller-host';
import { disposeSessionBrowser } from '@main/browser-use/session-browser';
import { getAgentDeckCodexDeveloperInstructions } from '@main/codex-config/agents-md-installer';
import { resolveCodexModelProvider } from '@main/codex-config/model-providers';
import { resolveCodexGatewayProfile } from '@main/codex-config/gateway-profiles';
import {
  readTopLevelModelFromCodexConfig,
  readTopLevelModelReasoningEffortFromCodexConfig,
} from '@main/codex-config/toml-writer';
import { eventBus } from '@main/event-bus';
import { sessionManager } from '@main/session/manager';
import { guardHandOffSourceIngress } from '@main/session/hand-off/ingress-guard';
import { worktreeToolInvocationRegistry } from '@main/session/worktree-transition/tool-invocation-registry';
import { eventRepo } from '@main/store/event-repo';
import { deleteUploadIfExists } from '@main/store/image-uploads';
import { sessionRepo } from '@main/store/session-repo';
import { settingsStore } from '@main/store/settings-store';
import log from '@main/utils/logger';
import {
  observeHeuristicCodexStreamError,
  observeIgnoredCodexAppServerItemType,
} from '../app-server/translate-diagnostics';
import {
  ensureCodexClient,
  getCodexUsageSnapshot,
  invalidateCodexClientsForPathChange,
  renameCodexClient,
} from './client-registry';
import { desktopCodexLiveRateHost } from './live-token-rate-host';

import type { CodexBridgeRuntimeHost } from './runtime-host-core';

export const desktopCodexBridgeRuntimeHost: CodexBridgeRuntimeHost = {
  sessions: sessionManager,
  tokens: mcpSessionTokenMap,
  records: {
    get: (sessionId) => sessionRepo.get(sessionId),
    setCodexSandbox: (sessionId, value) => sessionRepo.setCodexSandbox(sessionId, value),
    setCodexApprovalPolicy: (sessionId, value) =>
      sessionRepo.setCodexApprovalPolicy(sessionId, value),
    setRuntimeProvider: (sessionId, value) => sessionRepo.setRuntimeProvider(sessionId, value),
    setModel: (sessionId, value) => sessionRepo.setModel(sessionId, value),
    setThinking: (sessionId, value) => sessionRepo.setThinking(sessionId, value),
    setExtraAllowWrite: (sessionId, value) => sessionRepo.setExtraAllowWrite(sessionId, value),
    setNetworkAccessEnabled: (sessionId, value) =>
      sessionRepo.setNetworkAccessEnabled(sessionId, value),
    setAdditionalDirectories: (sessionId, value) =>
      sessionRepo.setAdditionalDirectories(sessionId, value),
    publishUpdated: (sessionId) => {
      const record = sessionRepo.get(sessionId);
      if (record) eventBus.emit('session-upserted', record);
    },
  },
  configuration: {
    readApplicationInstructions: getAgentDeckCodexDeveloperInstructions,
    readConfiguredModel: readTopLevelModelFromCodexConfig,
    readConfiguredReasoningEffort: readTopLevelModelReasoningEffortFromCodexConfig,
    readProviderConfigOverrides: (provider) =>
      resolveCodexGatewayProfile(provider)?.configOverrides ?? null,
    readDefaultSandbox: () => settingsStore.get('codexSandbox'),
    validateModelProvider: (provider) => { resolveCodexModelProvider(provider); },
  },
  clientRegistry: {
    ensureClient: ensureCodexClient,
    invalidateForPathChange: invalidateCodexClientsForPathChange,
    getUsageSnapshot: getCodexUsageSnapshot,
    renameClient: renameCodexClient,
  },
  sessionModel: desktopSessionModelControllerHost,
  liveRate: desktopCodexLiveRateHost,
  logger: (scope) => log.scope(scope),
  observeIgnoredAppServerItemType: observeIgnoredCodexAppServerItemType,
  observeHeuristicStreamError: observeHeuristicCodexStreamError,
  hasExactUserMessage: (sessionId, text) => eventRepo.hasExactUserMessage(sessionId, text),
  guardHandOffSourceIngress,
  hasPendingWorktreeTransition: (sessionId) =>
    worktreeToolInvocationRegistry.hasPendingTransition(sessionId),
  deleteUploadIfExists,
  disposeSessionBrowser,
};
