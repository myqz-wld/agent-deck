/**
 * list_session_events handler —— 只读读取某 session 的 normalized SQLite event trajectory。
 *
 * 与 list_sessions 的默认可见性一致：只允许 self、spawn 祖先/后代、共享 active team。
 * 不读取 Claude/Codex 原始 jsonl，避免 adapter transcript 路径和权限语义扩散。
 */

import { eventRepo } from '@main/store/event-repo';

import {
  err,
  getRelatedSessionReadAccess,
  ok,
  withMcpGuard,
  type HandlerContext,
} from '../helpers';
import type { ListSessionEventsArgs, ListSessionEventsResult } from '../schemas';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const MAX_OFFSET = 5000;

function clampLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(value), 1), MAX_LIMIT);
}

function clampOffset(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.trunc(value), 0), MAX_OFFSET);
}

export const listSessionEventsHandler = withMcpGuard(
  'list_session_events',
  async (args: ListSessionEventsArgs, ctx: HandlerContext) => {
    const access = getRelatedSessionReadAccess(ctx.caller.callerSessionId, args.sessionId);
    if (!access.allowed) {
      return err(access.message, access.hint, { reason: access.reason });
    }

    const limit = clampLimit(args.limit);
    const offset = clampOffset(args.offset);
    const rows = eventRepo.listValidForSession(args.sessionId, limit + 1, offset);
    return ok({
      sessionId: args.sessionId,
      hasMore: rows.length > limit,
      events: rows.slice(0, limit),
    } satisfies ListSessionEventsResult);
  },
);
