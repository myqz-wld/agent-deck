/**
 * shutdown_session handler —— 标记 session lifecycle=closed + abort SDK live query。
 * 不删 events / file_changes / summaries。caller 不能 shutdown 自己。
 *
 * 拆分历史：从 src/main/agent-deck-mcp/tools.ts 1020-1054 抽出（CHANGELOG_81 / plan
 * deep-review-and-split-20260513 H2 Step 2.1）。
 */

import { sessionRepo } from '@main/store/session-repo';
import { sessionManager } from '@main/session/manager';

import {
  denyExternalIfNotAllowed,
  err,
  ok,
  validateExternalCaller,
  type HandlerContext,
  type HandlerResult,
} from '../helpers';
import type { ShutdownSessionArgs } from '../schemas';

export async function shutdownSessionHandler(
  args: ShutdownSessionArgs,
  ctx: HandlerContext,
): Promise<HandlerResult> {
  const { caller } = ctx;
  const denial = denyExternalIfNotAllowed('shutdown_session', caller);
  if (denial) return denial;
  const callerCheck = validateExternalCaller(caller);
  if (callerCheck) return callerCheck;
  if (args.session_id === caller.callerSessionId) {
    return err(
      'cannot shutdown self',
      'Use the application UI / IPC to terminate your own session.',
    );
  }
  const session = sessionRepo.get(args.session_id);
  if (!session) {
    return err(`session ${args.session_id} not found`);
  }
  if (session.lifecycle === 'closed') {
    // 已 closed，幂等返回 success（与 IPC delete 同模式：noop）
    return ok({ sessionId: args.session_id, lifecycle: 'closed', alreadyClosed: true });
  }
  try {
    await sessionManager.close(args.session_id);
  } catch (e) {
    return err(
      e instanceof Error ? e.message : String(e),
      'sessionManager.close failed; check main process logs for adapter close errors.',
    );
  }
  return ok({ sessionId: args.session_id, lifecycle: 'closed', alreadyClosed: false });
}
