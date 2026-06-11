import { sessionRepo } from '@main/store/session-repo';
import { planReviewService } from '@main/plan-review/service';

import {
  err,
  ok,
  withMcpGuard,
  type HandlerContext,
} from '../helpers';
import type { RequestPlanReviewArgs, RequestPlanReviewResult } from '../schemas';

export const requestPlanReviewHandler = withMcpGuard(
  'request_plan_review',
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

      const decision = await planReviewService.request({
        sessionId: callerSid,
        agentId: session.agentId,
        plan: args.plan,
        ...(args.title ? { title: args.title } : {}),
        ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}),
      });

      return ok(decision satisfies RequestPlanReviewResult);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
);
