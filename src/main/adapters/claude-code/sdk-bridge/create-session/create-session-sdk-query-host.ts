import log from '@main/utils/logger';
import { loadSdk } from '../../sdk-loader';
import { getSdkRuntimeOptions } from '../../sdk-runtime';
import { resolveClaudeBinary } from '../../resolve-claude-binary';
import {
  getAgentDeckPluginsForSession,
  getAgentDeckSystemPromptAppend,
} from '../../sdk-injection';
import { buildSandboxOptions } from '../../sandbox-config';
import { buildMcpServersForSession } from '../mcp-server-init';
import { buildClaudeQueryOptions } from '../query-options-builder';
import { buildClaudeRuntimeMetadataHooks } from '../runtime-metadata-sync';
import {
  cleanupGatewaySandboxSettings,
  prepareGatewaySandboxSettings,
} from './gateway-sandbox-settings';
import type { ClaudeCreateSessionSdkQueryHost } from './create-session-sdk-query-core';

const logger = log.scope('claude-sdk-query');

export const desktopClaudeCreateSessionSdkQueryHost: ClaudeCreateSessionSdkQueryHost = {
  loadSdk,
  runtimeOptions: getSdkRuntimeOptions,
  resolveBinary: resolveClaudeBinary,
  buildSandboxOptions,
  prepareGatewaySandboxSettings,
  buildMcpServers: buildMcpServersForSession,
  buildQueryOptions: buildClaudeQueryOptions,
  systemPromptAppend: getAgentDeckSystemPromptAppend,
  plugins: getAgentDeckPluginsForSession,
  runtimeMetadataHooks: buildClaudeRuntimeMetadataHooks,
  cleanupGatewaySandboxSettings,
  observeSandboxConfiguration: (message) => logger.info(message),
  warn: (message, error) => logger.warn(message, error),
};
