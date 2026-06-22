import { sessionRepo } from '@main/store/session-repo';
import { diffReviewService } from '@main/diff-review/service';
import { settingsStore } from '@main/store/settings-store';

import {
  err,
  ok,
  withMcpGuard,
  type HandlerContext,
} from '../helpers';
import { resolvePlanReviewTimeoutMs } from './request-plan-review';
import type { RequestDiffReviewArgs, RequestDiffReviewResult } from '../schemas';

function validateDiffReviewArgs(args: RequestDiffReviewArgs): string | null {
  if (args.mode === 'pr' && !args.pr) {
    return 'present_diff requires `pr` when mode="pr"';
  }
  if (args.mode === 'pr' && args.conflict) {
    return 'present_diff rejects `conflict` when mode="pr"';
  }
  if (args.mode === 'merge-conflict' && !args.conflict) {
    return 'present_diff requires `conflict` when mode="merge-conflict"';
  }
  if (args.mode === 'merge-conflict' && args.pr) {
    return 'present_diff rejects `pr` when mode="merge-conflict"';
  }
  return null;
}

export const requestDiffReviewHandler = withMcpGuard(
  'present_diff',
  async (args: RequestDiffReviewArgs, ctx: HandlerContext) => {
    try {
      const invalid = validateDiffReviewArgs(args);
      if (invalid) return err(invalid);

      const callerSid = ctx.caller.callerSessionId;
      const session = sessionRepo.get(callerSid);
      if (!session) {
        return err(
          `caller session "${callerSid}" not in sessions table — cannot display diff review`,
        );
      }
      if (session.lifecycle === 'closed') {
        return err(`caller session "${callerSid}" is closed`);
      }

      const timeoutMs = resolvePlanReviewTimeoutMs(
        args.timeoutMs,
        settingsStore.get('permissionTimeoutMs'),
      );

      const decision = await diffReviewService.request({
        sessionId: callerSid,
        agentId: session.agentId,
        mode: args.mode,
        rationale: args.rationale,
        ...(args.title ? { title: args.title } : {}),
        ...(args.filePath ? { filePath: args.filePath } : {}),
        ...(args.language ? { language: args.language } : {}),
        ...(args.instructions ? { instructions: args.instructions } : {}),
        ...(args.pr ? { pr: args.pr } : {}),
        ...(args.conflict ? { conflict: args.conflict } : {}),
        ...(timeoutMs && timeoutMs > 0 ? { timeoutMs } : {}),
      });

      return ok(decision satisfies RequestDiffReviewResult);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
);
