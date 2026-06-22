import { sessionRepo } from '@main/store/session-repo';
import { planReviewService } from '@main/plan-review/service';
import { settingsStore } from '@main/store/settings-store';

import {
  err,
  ok,
  withMcpGuard,
  type HandlerContext,
} from '../helpers';
import type { RequestPlanReviewArgs, RequestPlanReviewResult } from '../schemas';

export function resolvePlanReviewTimeoutMs(
  requestedTimeoutMs: number | undefined,
  permissionTimeoutMs: number,
): number | undefined {
  const settingTimeoutMs = Number.isFinite(permissionTimeoutMs)
    ? Math.max(0, permissionTimeoutMs)
    : 0;
  if (settingTimeoutMs === 0) return requestedTimeoutMs;
  if (!requestedTimeoutMs || requestedTimeoutMs <= 0) return settingTimeoutMs;
  return Math.min(requestedTimeoutMs, settingTimeoutMs);
}

export const requestPlanReviewHandler = withMcpGuard(
  'present_plan',
  async (args: RequestPlanReviewArgs, ctx: HandlerContext) => {
    try {
      const callerSid = ctx.caller.callerSessionId;
      const session = sessionRepo.get(callerSid);
      if (!session) {
        return err(
          `caller session "${callerSid}" not in sessions table — cannot display plan review`,
        );
      }
      if (session.lifecycle === 'closed') {
        return err(`caller session "${callerSid}" is closed`);
      }
      const timeoutMs = resolvePlanReviewTimeoutMs(
        args.timeoutMs,
        settingsStore.get('permissionTimeoutMs'),
      );

      const decision = await planReviewService.request({
        sessionId: callerSid,
        agentId: session.agentId,
        plan: args.plan,
        ...(args.title ? { title: args.title } : {}),
        ...(timeoutMs && timeoutMs > 0 ? { timeoutMs } : {}),
      });

      return ok(decision satisfies RequestPlanReviewResult);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
);
