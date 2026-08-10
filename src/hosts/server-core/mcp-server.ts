import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SessionAdapterId } from '@shared/types';

import { registerServerCoreIssueTools } from './mcp-issue-tools';
import { registerServerCoreSessionTools } from './mcp-session-tools';
import { registerServerCoreSpawnTool } from './mcp-spawn-tools';
import { registerServerCoreTaskTools } from './mcp-task-tools';
import type { ServerCoreMcpToolHost } from './mcp-tool-host';
import { registerServerCoreWorktreeTools } from './mcp-worktree-tools';
import { registerServerCoreBrowserTools } from './mcp-browser-tools';
import { registerServerCorePresentationTools } from './mcp-presentation-tools';
import { registerServerCoreHandOffTool } from './mcp-handoff-tools';

export interface ServerCoreMcpServerModule {
  McpServer: new (info: { name: string; version: string }) => McpServer;
}

export const DEFAULT_SERVER_CORE_MCP_SERVER_MODULE: ServerCoreMcpServerModule =
  Object.freeze({ McpServer });

export async function createServerCoreMcpServer(
  host: ServerCoreMcpToolHost,
  callerSessionId: () => string,
  adapterId: SessionAdapterId,
  mcpServerModule?: ServerCoreMcpServerModule,
): Promise<McpServer> {
  const { McpServer: McpServerConstructor } =
    mcpServerModule ?? DEFAULT_SERVER_CORE_MCP_SERVER_MODULE;
  const server = new McpServerConstructor({ name: 'agent-deck', version: '0.1.0' });
  const context = Object.freeze({ host, callerSessionId, adapterId });
  registerServerCoreSessionTools(server, context);
  registerServerCoreSpawnTool(server, context);
  registerServerCoreHandOffTool(server, context);
  registerServerCoreWorktreeTools(server, context);
  registerServerCoreBrowserTools(server, context);
  registerServerCorePresentationTools(server, context);
  registerServerCoreTaskTools(server, context);
  registerServerCoreIssueTools(server, context);
  return server;
}

export async function createServerCoreInProcessMcpServer(
  host: ServerCoreMcpToolHost,
  callerSessionId: () => string,
  adapterId: SessionAdapterId,
  mcpServerModule?: ServerCoreMcpServerModule,
): Promise<McpSdkServerConfigWithInstance> {
  return {
    type: 'sdk',
    name: 'agent-deck',
    instance: await createServerCoreMcpServer(
      host,
      callerSessionId,
      adapterId,
      mcpServerModule,
    ),
  };
}
