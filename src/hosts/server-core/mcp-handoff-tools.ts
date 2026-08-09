import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { ServerCoreHandOffSessionArgs } from './mcp-handoff-port';
import { SERVER_CORE_HANDOFF_SESSION_SCHEMA } from './mcp-handoff-schema';
import {
  requireServerCoreMcpCaller,
  type ServerCoreMcpCallContext,
} from './mcp-tool-host';
import { serverCoreMcpError, serverCoreMcpOk } from './mcp-result';

export function registerServerCoreHandOffTool(
  server: McpServer,
  context: ServerCoreMcpCallContext,
): void {
  server.registerTool('hand_off_session', {
    description:
      'Atomically continue this logical session in a fresh Core-owned provider session. Cwd is Workspace-relative; tasks, active teams, worktree ownership, pending presentations, and message endpoints move only after the successor accepts its trusted continuation.',
    inputSchema: SERVER_CORE_HANDOFF_SESSION_SCHEMA,
  }, async (args) => {
    try {
      const caller = requireServerCoreMcpCaller(context);
      return serverCoreMcpOk(await context.host.handoff.handOff(
        caller.sessionId,
        args as ServerCoreHandOffSessionArgs,
      ));
    } catch (error) {
      return serverCoreMcpError(
        error,
        'The source remains usable unless the result contains a successor sessionId. Correct the Workspace-relative cwd or adapter-owned runtime field before retrying.',
      );
    }
  });
}
