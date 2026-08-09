import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { ServerCoreSpawnGuardError } from './mcp-spawn-guard';
import type { ServerCoreSpawnSessionArgs } from './mcp-spawn-port';
import { SERVER_CORE_SPAWN_SESSION_SCHEMA } from './mcp-spawn-schema';
import {
  requireServerCoreMcpCaller,
  type ServerCoreMcpCallContext,
} from './mcp-tool-host';
import { serverCoreMcpError, serverCoreMcpOk } from './mcp-result';

export function registerServerCoreSpawnTool(
  server: McpServer,
  context: ServerCoreMcpCallContext,
): void {
  server.registerTool('spawn_session', {
    description:
      'Start one fresh provider session inside this Core Workspace. The cwd is Workspace-relative; recursion, fan-out, and rate are bounded.',
    inputSchema: SERVER_CORE_SPAWN_SESSION_SCHEMA,
  }, async (args) => {
    try {
      const caller = requireServerCoreMcpCaller(context);
      return serverCoreMcpOk(await context.host.spawn.spawn(
        caller.sessionId,
        args as ServerCoreSpawnSessionArgs,
      ));
    } catch (error) {
      if (error instanceof ServerCoreSpawnGuardError) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: error.message,
              hint: error.hint,
              spawnLimits: error.spawnLimits,
            }, null, 2),
          }],
          isError: true,
        };
      }
      return serverCoreMcpError(
        error,
        'Correct the Workspace-relative cwd or Core-owned runtime option, then retry once. Do not retry when cleanup could not be proved.',
      );
    }
  });
}
