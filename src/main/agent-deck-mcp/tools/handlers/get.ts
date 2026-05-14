/**
 * get_session handler —— 单 sessionId 查询，返回与 list_sessions 同款投影。
 *
 * 拆分历史：从 src/main/agent-deck-mcp/tools.ts 996-1017 抽出（CHANGELOG_81 / plan
 * deep-review-and-split-20260513 H2 Step 2.1）。
 *
 * R37 P1 Step 1.1：5 行 deny external + caller 反查 boilerplate 走 withMcpGuard wrapper。
 */

import { sessionManager } from '@main/session/manager';

import {
  err,
  ok,
  projectSession,
  withMcpGuard,
  type HandlerContext,
} from '../helpers';
import type { GetSessionArgs, GetSessionResult } from '../schemas';

export const getSessionHandler = withMcpGuard(
  'get_session',
  async (args: GetSessionArgs, _ctx: HandlerContext) => {
    // plan team-cohesion-fix-20260513 Phase A Step A7：走 sessionManager.get（已 enrich）
    const session = sessionManager.get(args.session_id);
    if (!session) {
      return err(
        `session ${args.session_id} not found`,
        'session_id must reference an existing session. Use list_sessions to discover ids; pass status_filter:"all" to include closed sessions.',
      );
    }
    return ok(projectSession(session) satisfies GetSessionResult);
  },
);
