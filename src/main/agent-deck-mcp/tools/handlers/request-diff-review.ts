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

interface DiffReviewValidationError {
  error: string;
  hint: string;
}

function validateDiffReviewArgs(args: RequestDiffReviewArgs): DiffReviewValidationError | null {
  if (args.mode === 'pr' && !args.pr) {
    return {
      error: 'present_diff requires `pr` when mode="pr"',
      hint: 'Set pr={before,after}; omit conflict.',
    };
  }
  if (args.mode === 'pr' && args.conflict) {
    return {
      error: 'present_diff rejects `conflict` when mode="pr"',
      hint: 'Remove conflict; use only pr when mode="pr".',
    };
  }
  if (args.mode === 'merge-conflict' && !args.conflict) {
    return {
      error: 'present_diff requires `conflict` when mode="merge-conflict"',
      hint: 'Set conflict={ours,theirs,resolution[,base]}; omit pr.',
    };
  }
  if (args.mode === 'merge-conflict' && args.pr) {
    return {
      error: 'present_diff rejects `pr` when mode="merge-conflict"',
      hint: 'Remove pr; use only conflict when mode="merge-conflict".',
    };
  }
  for (const annotation of args.annotations ?? []) {
    if (args.mode === 'pr' && !['before', 'after', 'both'].includes(annotation.pane)) {
      return {
        error: `present_diff annotation pane "${annotation.pane}" is not valid when mode="pr"`,
        hint: 'Use annotation.pane "before", "after", or "both".',
      };
    }
    if (
      args.mode === 'merge-conflict' &&
      !['base', 'ours', 'theirs', 'resolution'].includes(annotation.pane)
    ) {
      return {
        error: `present_diff annotation pane "${annotation.pane}" is not valid when mode="merge-conflict"`,
        hint: 'Use annotation.pane "base", "ours", "theirs", or "resolution".',
      };
    }
    if (args.mode === 'merge-conflict' && annotation.pane === 'base' && !args.conflict?.base) {
      return {
        error: 'present_diff annotation pane "base" requires conflict.base',
        hint: 'Add conflict.base, remove the base annotation, or change its pane.',
      };
    }
  }
  return null;
}

export const requestDiffReviewHandler = withMcpGuard(
  'present_diff',
  async (args: RequestDiffReviewArgs, ctx: HandlerContext) => {
    try {
      const invalid = validateDiffReviewArgs(args);
      if (invalid) return err(invalid.error, invalid.hint);

      const callerSid = ctx.caller.callerSessionId;
      const session = sessionRepo.get(callerSid);
      if (!session) {
        return err(
          `caller session "${callerSid}" not in sessions table — cannot display diff review`,
          'Retry once after session initialization completes. If it persists, stop; present_diff requires a live Agent Deck session.',
        );
      }
      if (session.lifecycle === 'closed') {
        return err(
          `caller session "${callerSid}" is closed`,
          'Do not retry. Ask the user to start a new Agent Deck session and present the diff there.',
        );
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
        ...(args.annotations ? { annotations: args.annotations } : {}),
        ...(args.pr ? { pr: args.pr } : {}),
        ...(args.conflict ? { conflict: args.conflict } : {}),
        ...(timeoutMs && timeoutMs > 0 ? { timeoutMs } : {}),
      });

      return ok(decision satisfies RequestDiffReviewResult);
    } catch (e) {
      return err(
        e instanceof Error ? e.message : String(e),
        'Retry present_diff once. If it fails again, stop and inspect Agent Deck main-process logs.',
      );
    }
  },
);
