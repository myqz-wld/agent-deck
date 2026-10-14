import log from '@main/utils/logger';
/**
 * shutdown_session handler —— 标记 session lifecycle=closed + abort SDK live query。
 * 不删 events / file_changes / summaries / messages（agent_deck_messages 表）；
 * team_member 行通过 left_at 软退出保留，spawn_link 全量保留。caller 不能 shutdown 自己。
 *
 * 数据保留 invariant（R1 deep review MED-1 + LOW-4 修；A6 / B12 文档同步）：
 *   - lead 在裁决报告 / 历史 review 里仍可引用 closed teammate 的 messages（双 reviewer
 *     SKILL 流程的核心 affordance）；
 *   - list_sessions(scope: all, statusFilter: closed, spawnedByFilter) 可发现旧 lead 的 closed reviewer，
 *     team_member.left_at 标记之外行不删；
 *   - spawn_link 保留方便 fan-out / 父子链路审计。
 *
 * 拆分历史：从 src/main/agent-deck-mcp/tools.ts 1020-1054 抽出（CHANGELOG_81 / plan
 * deep-review-and-split-20260513 H2 Step 2.1）。
 *
 * R37 P1 Step 1.1：5 行 deny external + caller 反查 boilerplate 走 withMcpGuard wrapper。
 */

import { sessionRepo } from '@main/store/session-repo';
import { sessionManager } from '@main/session/manager';
import { adapterRegistry } from '@main/adapters/registry';
import { retireClosedSessionRuntime } from '@main/adapters/closed-session-runtime-retirement';
import { askUserService } from '@main/ask-user/service';
import { handOffCutoverCoordinator } from '@main/session/hand-off/cutover-coordinator';
import { sessionOwnershipLineage } from '@main/session/hand-off/ownership';
import { authorizeSessionShutdown } from '../../session-shutdown-authority';

import {
  err,
  structuredOk,
  withMcpGuard,
  type HandlerContext,
} from '../helpers';
import type { ShutdownSessionArgs, ShutdownSessionResult } from '../schemas';


const logger = log.scope('mcp-shutdown');

export const shutdownSessionHandler = withMcpGuard(
  'shutdown_session',
  async (args: ShutdownSessionArgs, ctx: HandlerContext, signal?: AbortSignal) => {
    logger.info('[mcp shutdown_session] shutdown requested', {
      callerSessionId: ctx.caller.callerSessionId, targetSessionId: args.sessionId, reason: args.reason ?? null,
    });
    try {
      const consume = await authorizeSessionShutdown(ctx.caller.callerSessionId, args.sessionId, {
        get: (id) => sessionRepo.get(id),
        successor: (id) => handOffCutoverCoordinator.successorForStrict(id),
        lineage: sessionOwnershipLineage,
        request: (callerId, question, abort) => askUserService.request(
          callerId, sessionRepo.get(callerId)!.agentId, question, abort),
      }, signal);
      // Recheck after the asynchronous authority boundary; never redirect an approved target.
      const current = consume();
      if (!current) throw new Error('Shutdown target no longer exists');
      const alreadyClosed = current.lifecycle === 'closed';
      if (alreadyClosed) await retireClosedSessionRuntime(adapterRegistry.get(current.agentId), current.id);
      else await sessionManager.close(current.id);
      return structuredOk({ sessionId: current.id, lifecycle: 'closed', alreadyClosed } satisfies ShutdownSessionResult);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e),
        'Read get_session to reconcile the exact target. Cancellation, denial, or a changed identity does not authorize retrying shutdown.');
    }
  },
);
