import { getAgentDeckMcpServerForSession } from '@main/agent-deck-mcp/server';
import { settingsStore } from '@main/store/settings-store';
import log from '@main/utils/logger';
import type { ClaudeMcpServerHost } from './mcp-server-core';

const logger = log.scope('claude-mcp-init');

type McpServerConfig = Awaited<ReturnType<typeof getAgentDeckMcpServerForSession>>;

export const desktopClaudeMcpServerHost: ClaudeMcpServerHost<McpServerConfig> = {
  createServer: getAgentDeckMcpServerForSession,
  onServerAttached: () => {
    logger.info('[agent-deck-mcp] in-process MCP attached for session (19 core tools + browser tools when the adapter profile enables them)');
  },
  readEnabled: () => settingsStore.get('enableAgentDeckMcp') === true,
};
