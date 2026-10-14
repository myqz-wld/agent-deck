import { sessionRepo } from '@main/store/session-repo';
import { sessionManager } from '@main/session/manager';
import { EXTERNAL_CALLER_SENTINEL } from '../../types';
import { collectSessionDirectory } from '../../session-directory';
import { err, isRelatedSessionVisible, projectSession, structuredOk, withMcpGuard,
  type HandlerContext } from '../helpers';
import type { ListSessionsArgs, ListSessionsResult } from '../schemas';

export const listSessionsHandler = withMcpGuard(
  'list_sessions',
  async (args: ListSessionsArgs, ctx: HandlerContext) => {
    const related = args.scope !== 'all';
    if (related && ctx.caller.callerSessionId === EXTERNAL_CALLER_SENTINEL) {
      return err('Related scope requires a real session caller', 'Use scope "all" for external metadata discovery.');
    }
    const caller = related ? sessionManager.get(ctx.caller.callerSessionId) : null;
    const { page, hasMore } = collectSessionDirectory(sessionRepo, args, (row) =>
      !related || !!caller && isRelatedSessionVisible(caller, sessionManager.enrichWithTeams(row)));
    return structuredOk({
      total: page.length, hasMore,
      sessions: sessionManager.enrichWithTeamsBatch(page).map(projectSession),
    } satisfies ListSessionsResult);
  },
);
