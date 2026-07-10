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
          'Retry once after session initialization completes. If it persists, stop; present_plan requires a live Agent Deck session.',
        );
      }
      if (session.lifecycle === 'closed') {
        return err(
          `caller session "${callerSid}" is closed`,
          'Do not retry. Ask the user to start a new Agent Deck session and present the plan there.',
        );
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
      return err(
        e instanceof Error ? e.message : String(e),
        'Retry present_plan once. If it fails again, stop and inspect Agent Deck main-process logs.',
      );
    }
  },
);
