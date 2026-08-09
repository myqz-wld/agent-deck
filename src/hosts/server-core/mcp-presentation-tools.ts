import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  REQUEST_DIFF_REVIEW_SCHEMA,
  REQUEST_PLAN_REVIEW_SCHEMA,
  type RequestDiffReviewArgs,
  type RequestPlanReviewArgs,
} from '@main/agent-deck-mcp/tools/schemas';

import {
  requireServerCoreMcpCaller,
  type ServerCoreMcpCallContext,
} from './mcp-tool-host';
import { serverCoreMcpError, serverCoreMcpOk } from './mcp-result';

export function registerServerCorePresentationTools(
  server: McpServer,
  context: ServerCoreMcpCallContext,
): void {
  server.registerTool('present_plan', {
    description: 'Present a markdown plan in the connected Agent Deck Remote UI and block until the user approves it or requests revisions. The gate is owned by Server Core and never falls back to Local session state.',
    inputSchema: REQUEST_PLAN_REVIEW_SCHEMA,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  }, async (args) => {
    try {
      const caller = requireServerCoreMcpCaller(context);
      return serverCoreMcpOk(await context.host.presentations.requestPlan(
        caller.sessionId,
        args as RequestPlanReviewArgs,
      ));
    } catch (error) {
      return serverCoreMcpError(
        error,
        '在 Remote 待处理界面确认计划；若展示已切换或会话已关闭，请重新提交计划。',
      );
    }
  });

  server.registerTool('present_diff', {
    description: 'Present one PR or merge-conflict fragment in the connected Agent Deck Remote UI and block for approval, revision feedback, or the requested timeout. The exact presentation remains Server Core-owned.',
    inputSchema: REQUEST_DIFF_REVIEW_SCHEMA,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  }, async (args) => {
    try {
      const caller = requireServerCoreMcpCaller(context);
      return serverCoreMcpOk(await context.host.presentations.requestDiff(
        caller.sessionId,
        args as RequestDiffReviewArgs,
      ));
    } catch (error) {
      return serverCoreMcpError(
        error,
        '在 Remote 待处理界面确认差异；若展示已过期或会话已关闭，请重新提交该片段。',
      );
    }
  });
}
