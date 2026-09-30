import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GET_SESSION_OUTPUT_SCHEMA } from '@main/agent-deck-mcp/tools/schemas';
import { requireServerCoreMcpCaller, SERVER_CORE_READ_ONLY_TOOL_ANNOTATIONS,
  type ServerCoreMcpCallContext } from './mcp-tool-host';
import { serverCoreMcpError, serverCoreMcpOk } from './mcp-result';

export function registerServerCoreFeishuWorkSessionTool(server: McpServer, context: ServerCoreMcpCallContext): void {
  if (!context.host.feishuWorkSessions) return;
  server.registerTool('list_work_sessions', {
    description: 'List the paired owner\'s current work-session metadata when a Feishu assistant is asked which work sessions exist. Requires a live authenticated assistant identity registered by the Feishu owner channel. Includes active and dormant work sessions across this Core Workspace; excludes assistant chats, internal sessions, closed and archived rows. This is the work directory, while list_sessions retains its separate caller-related collaboration scope. No messages, history, provider turns, session changes or permission changes occur. The result identifies the assistant caller, lists session metadata with Workspace-relative cwd, and supplies hasMore and nullable nextOffset. Continue with the returned nextOffset while hasMore is true, including after an empty page: each call examines at most 2000 raw rows. Pages reflect current state, not a frozen snapshot; do not claim a complete list until nextOffset is null. No timeout or automatic retry is configured; an identical read may safely be retried. If the assistant registration is unavailable, ask the owner to send a fresh private message or use /sessions; never substitute the assistant itself as a work session.',
    inputSchema: {
      limit: z.number().int().min(1).max(100).optional().describe('Maximum work sessions to return; default 50. Null is invalid.'),
      offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 2_000).optional()
        .describe('Opaque raw-row continuation returned as nextOffset; omit for the first page. Default 0. Null is invalid.'),
    },
    outputSchema: {
      scope: z.literal('open-work-sessions'),
      assistantSessionId: z.string(),
      sessions: z.array(GET_SESSION_OUTPUT_SCHEMA).max(100),
      nextOffset: z.number().int().nonnegative().nullable(),
      hasMore: z.boolean(),
    },
    annotations: SERVER_CORE_READ_ONLY_TOOL_ANNOTATIONS,
  }, args => {
    try {
      const caller = requireServerCoreMcpCaller(context);
      return serverCoreMcpOk(context.host.feishuWorkSessions!.list(caller.sessionId, args));
    } catch {
      return serverCoreMcpError(new Error('Work-session directory is unavailable for this assistant'),
        'Ask the owner to send a fresh private message to register this assistant, or use /sessions. Do not treat list_sessions as the complete work directory.');
    }
  });
}
