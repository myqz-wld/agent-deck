import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { ClaudeSessionManagerPort } from '@main/adapters/claude-code/session-manager-core';
import { cleanupGatewaySandboxSettingsCore } from '@main/adapters/claude-code/sdk-bridge/create-session/gateway-sandbox-settings-core';
import type { ClaudeLiveRateHost } from '@main/adapters/claude-code/sdk-bridge/live-token-rate-core';
import { runClaudeCloseSessionCleanupCore } from '@main/adapters/claude-code/sdk-bridge/pending-cancellation-core';
import type { ClaudeSessionLifecycleHost } from '@main/adapters/claude-code/sdk-bridge/session-lifecycle-core';
import type { ClaudeSdkMessageTranslationHost } from '@main/adapters/claude-code/sdk-bridge/sdk-message-translate-core';
import type { ClaudeStreamProcessorHost } from '@main/adapters/claude-code/sdk-bridge/stream-processor-core';
import type { InternalSession, SdkBridgeOptions } from '@main/adapters/claude-code/sdk-bridge/types';
import {
  claudeRuntimeMetadataHost,
} from './provider-claude-query-host';
import {
  providerLogger,
  publishProviderSession,
  type ServerCoreProviderHostInput,
} from './provider-host-common';

function liveRate(input: ServerCoreProviderHostInput): ClaudeLiveRateHost {
  return {
    resolveModel: (applicationSid, sessionId) =>
      input.repositories.sessions.get(applicationSid)?.model ??
      input.repositories.sessions.get(sessionId)?.model ?? null,
    emitTokenRateTick: () => undefined,
  };
}

function translation(
  input: ServerCoreProviderHostInput,
): ClaudeSdkMessageTranslationHost {
  return {
    agentId: 'claude-code',
    now: Date.now,
    runtimeMetadata: claudeRuntimeMetadataHost(input),
    liveRate: liveRate(input),
    state: {
      read: (sessionId) => input.repositories.sessions.get(sessionId),
      setPermissionMode: (sessionId, mode) =>
        input.repositories.sessions.setPermissionMode(sessionId, mode),
      publishUpdated: (sessionId) => publishProviderSession(input, sessionId),
    },
  };
}

export function createServerCoreClaudeStreamHost(
  input: ServerCoreProviderHostInput,
  sessionManager: ClaudeSessionManagerPort,
): ClaudeStreamProcessorHost {
  const logger = providerLogger(input.diagnostics, 'claude-stream');
  return {
    agentId: 'claude-code',
    now: Date.now,
    warn: (message, error) => logger.warn(message, error),
    userMessages: {
      readAttachmentBase64: async (path) => (await readFile(path)).toString('base64'),
      createProviderMessageId: randomUUID,
      refreshBrowserRuntime: (sessionId) => {
        try { input.browserRuntime.refreshSession(sessionId); } catch (error) {
          logger.warn('Browser runtime refresh failed', error);
        }
      },
      now: Date.now,
    },
    translation: translation(input),
    finalize: {
      ...liveRate(input),
      agentId: 'claude-code',
      now: Date.now,
      releaseSdkClaim: (sessionId) => sessionManager.releaseSdkClaim(sessionId),
    },
    identity: {
      warn: (message) => logger.warn(message),
      renameSdkSession: (fromId, toId) => sessionManager.renameSdkSession(fromId, toId),
      updateCliSessionId: (applicationSid, cliSessionId) =>
        sessionManager.updateCliSessionId(applicationSid, cliSessionId),
    },
  };
}

export function createServerCoreClaudeLifecycleHost(
  input: ServerCoreProviderHostInput,
  sessionManager: ClaudeSessionManagerPort,
): ClaudeSessionLifecycleHost<InternalSession, SdkBridgeOptions['emit']> {
  const logger = providerLogger(input.diagnostics, 'claude-lifecycle');
  return {
    cleanupSession: (cleanupInput) => runClaudeCloseSessionCleanupCore(
      cleanupInput,
      {
        now: Date.now,
        cleanupGatewaySandboxSettings: (session) =>
          cleanupGatewaySandboxSettingsCore(session as InternalSession),
        releaseSdkClaim: (sessionId) => sessionManager.releaseSdkClaim(sessionId),
        markRecentlyDeleted: (sessionId) => sessionManager.markRecentlyDeleted(sessionId),
      },
    ),
    hasPersistedSession: (sessionId) =>
      input.repositories.sessions.get(sessionId) !== null,
    warn: (message, error) => logger.warn(message, error),
    info: (message) => logger.info(message),
  };
}
