import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
  requireServerCoreMcpCaller,
  type ServerCoreMcpCallContext,
} from './mcp-tool-host';
import {
  ServerCoreWorktreeError,
  type ServerCoreEnterWorktreeArgs,
  type ServerCoreExitWorktreeArgs,
} from './mcp-worktree-port';
import {
  SERVER_CORE_ENTER_WORKTREE_SCHEMA,
  SERVER_CORE_EXIT_WORKTREE_SCHEMA,
} from './mcp-worktree-schema';
import { serverCoreMcpOk } from './mcp-result';

function failure(error: unknown) {
  if (error instanceof ServerCoreWorktreeError) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ error: error.message, hint: error.hint }, null, 2),
      }],
      isError: true,
    };
  }
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        error: 'Server Core worktree operation failed',
        hint: 'Core 已保留 Workspace、Git 引用和 transition 状态；请检查后再试。',
      }),
    }],
    isError: true,
  };
}

export function registerServerCoreWorktreeTools(
  server: McpServer,
  context: ServerCoreMcpCallContext,
): void {
  server.registerTool('enter_worktree', {
    description:
      'Create a detached Git worktree inside this Core Workspace and automatically move this session after the exact tool result is observed. Paths are Workspace-relative.',
    inputSchema: SERVER_CORE_ENTER_WORKTREE_SCHEMA,
  }, async (args) => {
    try {
      const caller = requireServerCoreMcpCaller(context);
      return serverCoreMcpOk(await context.host.worktree.enter(
        caller.sessionId,
        args as ServerCoreEnterWorktreeArgs,
      ));
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool('exit_worktree', {
    description:
      'Restore this session to its original Workspace directory and remove only its structured worktree lease. Dirty removal requires explicit discardChanges=true authorization.',
    inputSchema: SERVER_CORE_EXIT_WORKTREE_SCHEMA,
  }, async (args) => {
    try {
      const caller = requireServerCoreMcpCaller(context);
      return serverCoreMcpOk(await context.host.worktree.exit(
        caller.sessionId,
        args as ServerCoreExitWorktreeArgs,
      ));
    } catch (error) {
      return failure(error);
    }
  });
}
