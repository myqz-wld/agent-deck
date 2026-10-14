import { LIST_SESSIONS_DESCRIPTION, GET_SESSION_DESCRIPTION, SESSION_EVENTS_DESCRIPTION, SEND_MESSAGE_DESCRIPTION, SHUTDOWN_SESSION_DESCRIPTION } from '@main/agent-deck-mcp/session-tool-descriptions';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  GET_SESSION_SCHEMA,
  GET_SESSION_OUTPUT_SCHEMA,
  LIST_SESSION_EVENTS_SCHEMA,
  LIST_SESSION_EVENTS_OUTPUT_SCHEMA,
  LIST_SESSIONS_SCHEMA,
  LIST_SESSIONS_OUTPUT_SCHEMA,
  SEND_MESSAGE_SCHEMA,
  SEND_MESSAGE_OUTPUT_SCHEMA,
  SHUTDOWN_SESSION_SCHEMA,
  SHUTDOWN_SESSION_OUTPUT_SCHEMA,
  type GetSessionArgs,
  type ListSessionEventsArgs,
  type ListSessionsArgs,
  type SendMessageArgs,
  type ShutdownSessionArgs,
} from '@main/agent-deck-mcp/tools/schemas';

import {
  requireServerCoreMcpCaller,
  SERVER_CORE_READ_ONLY_TOOL_ANNOTATIONS,
  type ServerCoreMcpCallContext,
} from './mcp-tool-host';
import { serverCoreMcpError, serverCoreMcpOk } from './mcp-result';

const READ_HINT = 'Call list_sessions to discover sessions visible to this authenticated caller.';
const MUTATION_HINT =
  'Inspect the target with get_session before retrying. Do not retry an ambiguous mutation blindly.';

function read<T>(context: ServerCoreMcpCallContext, operation: (callerId: string) => T) {
  try {
    const caller = requireServerCoreMcpCaller(context);
    return serverCoreMcpOk(operation(caller.sessionId));
  } catch (error) {
    return serverCoreMcpError(error, READ_HINT);
  }
}

async function mutate<T>(
  context: ServerCoreMcpCallContext,
  operation: (callerId: string) => Promise<T> | T,
) {
  try {
    const caller = requireServerCoreMcpCaller(context);
    return serverCoreMcpOk(await operation(caller.sessionId));
  } catch (error) {
    return serverCoreMcpError(error, MUTATION_HINT);
  }
}

export function registerServerCoreSessionTools(
  server: McpServer,
  context: ServerCoreMcpCallContext,
): void {
  server.registerTool('list_sessions', {
    description: LIST_SESSIONS_DESCRIPTION,
    inputSchema: LIST_SESSIONS_SCHEMA,
    outputSchema: LIST_SESSIONS_OUTPUT_SCHEMA,
    annotations: SERVER_CORE_READ_ONLY_TOOL_ANNOTATIONS,
  }, (args: ListSessionsArgs) => read(
    context,
    (callerId) => context.host.collaboration.list(callerId, args),
  ));
  server.registerTool('get_session', {
    description: GET_SESSION_DESCRIPTION,
    inputSchema: GET_SESSION_SCHEMA,
    outputSchema: GET_SESSION_OUTPUT_SCHEMA,
    annotations: SERVER_CORE_READ_ONLY_TOOL_ANNOTATIONS,
  }, (args: GetSessionArgs) => read(
    context,
    (callerId) => context.host.collaboration.get(callerId, args.sessionId),
  ));
  server.registerTool('list_session_events', {
    description: SESSION_EVENTS_DESCRIPTION,
    inputSchema: LIST_SESSION_EVENTS_SCHEMA,
    outputSchema: LIST_SESSION_EVENTS_OUTPUT_SCHEMA,
    annotations: SERVER_CORE_READ_ONLY_TOOL_ANNOTATIONS,
  }, (args: ListSessionEventsArgs) => read(
    context,
    (callerId) => context.host.collaboration.listEvents(callerId, args),
  ));
  server.registerTool('send_message', {
    description: SEND_MESSAGE_DESCRIPTION,
    inputSchema: SEND_MESSAGE_SCHEMA,
    outputSchema: SEND_MESSAGE_OUTPUT_SCHEMA,
  }, (args: SendMessageArgs) => mutate(
    context,
    (callerId) => context.host.collaboration.send(callerId, args),
  ));
  server.registerTool('shutdown_session', {
    description: SHUTDOWN_SESSION_DESCRIPTION,
    inputSchema: SHUTDOWN_SESSION_SCHEMA,
    outputSchema: SHUTDOWN_SESSION_OUTPUT_SCHEMA,
  }, (args: ShutdownSessionArgs, extra) => mutate(
    context,
    (callerId) => context.host.collaboration.shutdown(callerId, args, extra.signal),
  ));
}
