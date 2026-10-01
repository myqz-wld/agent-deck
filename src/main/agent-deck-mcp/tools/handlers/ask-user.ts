import { askUserService } from '@main/ask-user/service';
import { sessionRepo } from '@main/store/session-repo';
import { ASK_USER_ARGS_SCHEMA, type AskUserArgs } from '../schemas/ask-user';
import { err, structuredOk, withMcpGuard, type HandlerContext } from '../helpers';

export const askUserHandler = withMcpGuard(
  'ask_user',
  async (args: AskUserArgs, ctx: HandlerContext, signal?: AbortSignal) => {
    const parsed = ASK_USER_ARGS_SCHEMA.safeParse(args);
    if (!parsed.success) {
      return err(`ask_user input validation failed: ${parsed.error.message}`,
        'Correct the named fields according to the ask_user schema and retry. No question was created.');
    }
    const sessionId = ctx.caller.callerSessionId;
    const session = sessionRepo.get(sessionId);
    if (!session || session.lifecycle === 'closed') {
      return err('ask_user requires a live caller session', 'Start a live in-app session before asking.');
    }
    try {
      return structuredOk(await askUserService.request(sessionId, session.agentId, parsed.data, signal));
    } catch (error) {
      return err(error instanceof Error ? error.message : String(error),
        'Check existing Pending questions before retrying ask_user. Resolve them first if the queue is full; if publication keeps failing, stop and report that the question could not be displayed.');
    }
  },
);

export function askUserAbortSignal(extra: unknown): AbortSignal | undefined {
  if (!extra || typeof extra !== 'object' || !('signal' in extra)) return undefined;
  const signal = extra.signal as AbortSignal | undefined;
  return signal && typeof signal.addEventListener === 'function' ? signal : undefined;
}
