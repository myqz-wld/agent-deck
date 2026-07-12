/**
 * send_message handler —— 跨 session 消息入队（universal-message-watcher 投递 + 持久化）。
 *
 * 拆分历史：从 src/main/agent-deck-mcp/tools.ts 671-751 抽出（CHANGELOG_81 / plan
 * deep-review-and-split-20260513 H2 Step 2.1）。
 *
 * MED-3 (send teamId 跨污染) 修法：replyToMessageId 给定时反查 original.teamId
 * 必须 === resolved teamId，避免 caller 把 team A 消息挂到 team B 的 reply chain。
 *
 * CHANGELOG_100 / plan mcp-tool-simplify-20260514：删 reply_message tool 后所有 reply
 * 改走 send_message + replyToMessageId；J fix 删 → reply 与普通 message 同款 dispatch
 * 进 receiver SDK conversation flow，receiver 自动看到 reply 作为 user-role message。
 *
 * R37 P1 Step 1.1：5 行 deny external + caller 反查 boilerplate 走 withMcpGuard wrapper。
 *
 * plan teamless-dm-20260601：解除「双方必须共享 active team」限制。无 shared team 且未显式
 * 传 teamId 时降级 teamless DM（teamId=null）；有 shared team 时行为完全不变（byte-identical）。
 * teamless 分支补 caller/target archived 前置 reject（绕过 findSharedActiveTeams 的 archived
 * 过滤后必须显式补）+ teamless reply 的 from/to pair-scope 校验（防 null!==null 放行任意 DM 挂链）。
 */

import { sessionRepo } from '@main/store/session-repo';
import { agentDeckMessageRepo } from '@main/store/agent-deck-message-repo';
import { agentDeckTeamRepo } from '@main/store/agent-deck-team-repo';
import { enqueueAgentDeckMessage } from '@main/teams/universal-message-watcher';
import { handOffCutoverCoordinator } from '@main/session/hand-off/cutover-coordinator';

import {
  err,
  ok,
  withMcpGuard,
  type HandlerContext,
} from '../helpers';
import type { SendMessageArgs, SendMessageResult } from '../schemas';
import type { SessionRecord } from '@shared/types';

function resolveSendTarget(sessionId: string): SessionRecord | null {
  return sessionRepo.get(sessionId) ?? sessionRepo.findByCliSessionId(sessionId);
}

export const sendMessageHandler = withMcpGuard(
  'send_message',
  async (args: SendMessageArgs, ctx: HandlerContext) => {
    const { caller } = ctx;

    const requestedTarget = resolveSendTarget(args.sessionId);
    const redirectedTargetId = handOffCutoverCoordinator.successorFor(
      requestedTarget?.id ?? args.sessionId,
    );
    const target = redirectedTargetId
      ? resolveSendTarget(redirectedTargetId)
      : requestedTarget;
    if (!target) {
      return err(
        `session ${args.sessionId} not found`,
        'Call list_sessions to get a live target session ID, then retry. If the target no longer exists, call spawn_session.',
      );
    }
    const targetSessionId = target.id;
    if (target.lifecycle === 'closed') {
      return err(
        `session ${args.sessionId} is closed`,
        'Call spawn_session to create a replacement, then send_message to the returned sessionId.',
      );
    }
    if (caller.callerSessionId === targetSessionId) {
      return err(
        'cannot send_message to self',
        'Continue in the current session directly; do not call send_message for self-directed context.',
      );
    }

    // teamId resolve（plan teamless-dm-20260601 D4：无 shared team 时降级 teamless DM）。
    // **分支顺序关键**（codex-3）：显式 args.teamId 必须**先**校验，再 fallback teamless——
    // 否则 caller 传错/stale/越权 teamId 给无 shared team 的 target 时会被静默降级成 DM，
    // 破坏 caller 对 teamId 的显式意图。
    const sharedTeams = agentDeckTeamRepo.findSharedActiveTeams(
      caller.callerSessionId,
      targetSessionId,
    );
    let teamId: string | null;
    if (args.teamId) {
      // 显式 scope：必须 ∈ shared active set，否则 reject（不降级 teamless）
      if (!sharedTeams.includes(args.teamId)) {
        return err(
          `team-not-shared: teamId ${args.teamId} is not in the shared active set [${sharedTeams.join(', ')}]`,
          'Use a team ID from the shared active set shown in the error. If the set is empty, omit teamId for a teamless DM.',
        );
      }
      teamId = args.teamId;
    } else if (sharedTeams.length === 1) {
      teamId = sharedTeams[0];
    } else if (sharedTeams.length >= 2) {
      return err(
        `ambiguous-team: caller and target share ${sharedTeams.length} active teams [${sharedTeams.join(', ')}]`,
        'Retry with teamId set to one of the listed IDs.',
      );
    } else {
      // sharedTeams.length === 0 且未显式传 teamId → teamless DM 分支。
      // **archived 前置补强**（codex-2）：findSharedActiveTeams 的 archived 过滤（team / caller /
      // target 任一 archived → 返 []）在此被绕过。team 路径靠它隐式拒 archived；teamless 路径
      // 必须显式反查，否则 archived caller/target 会静默入队再被 watcher 异步 markFailed（误导
      // caller 拿到 queued ok）。§不变量 4。
      const callerSession = sessionRepo.get(caller.callerSessionId);
      if (!callerSession) {
        return err(
          `caller session ${caller.callerSessionId.slice(0, 8)} not found`,
          'Retry once after session initialization completes. If it persists, stop and inspect Agent Deck main-process logs.',
        );
      }
      if (callerSession.archivedAt != null) {
        return err(
          `caller session ${caller.callerSessionId.slice(0, 8)} is archived`,
          'Stop and ask the user to restore or replace this session in the Agent Deck UI.',
        );
      }
      if (target.archivedAt != null) {
        return err(
          `target session ${targetSessionId.slice(0, 8)} is archived`,
          'Ask the user to restore the target in the Agent Deck UI, or call spawn_session to create a replacement.',
        );
      }
      teamId = null;
    }

    // replyToMessageId scope 校验（plan teamless-dm-20260601 D4）。
    // - team 模式（teamId 非 null）：original.teamId 必须 === teamId（REVIEW_32 MED-3 防 cross-team
    //   污染；`!==` 在 team↔teamless 边界天然对称：teamless reply 挂 team chain `null !== 't1'` 拒，
    //   team reply 挂 teamless chain `'t1' !== null` 拒）。
    // - teamless 模式（teamId === null）：`original.teamId !== null` 对 teamless↔teamless 恒为 false
    //   （null!==null），单独不够——会放行**任意** teamless reply。必须额外 pair-scope（codex-1）：
    //   original 的 {from,to} 与本次 {caller,target} 是同一对 session，防持有任意 teamless messageId
    //   挂无关 DM chain 污染 reply graph。
    if (args.replyToMessageId) {
      const original = agentDeckMessageRepo.get(args.replyToMessageId);
      if (!original) {
        return err(
          `replyToMessageId ${args.replyToMessageId} not found`,
          'Omit replyToMessageId to start a new thread, or use the messageId from the latest wire prefix.',
        );
      }
      if (original.teamId !== teamId) {
        return err(
          `cross-team reply not allowed: replyToMessageId ${args.replyToMessageId} belongs to team ${original.teamId ?? '(teamless)'}, not target team ${teamId ?? '(teamless)'}`,
          "Use the original message's teamId when it is shared; otherwise omit replyToMessageId to start a new chain.",
        );
      }
      if (teamId === null) {
        const canonicalSessionId = (sessionId: string): string =>
          handOffCutoverCoordinator.successorFor(sessionId) ?? sessionId;
        const originalFrom = canonicalSessionId(original.fromSessionId);
        const originalTo = canonicalSessionId(original.toSessionId);
        const pairMatch =
          (originalFrom === caller.callerSessionId && originalTo === targetSessionId) ||
          (originalFrom === targetSessionId && originalTo === caller.callerSessionId);
        if (!pairMatch) {
          return err(
            `teamless reply chain mismatch: replyToMessageId ${args.replyToMessageId} is between other sessions, not (${caller.callerSessionId.slice(0, 8)}, ${targetSessionId.slice(0, 8)})`,
            'Omit replyToMessageId to start a new thread with this target.',
          );
        }
      }
    }

    // 入队（messageRateLimiter + repo.insert 100KB cap + self-message 防御都在内部）
    // plan team-cohesion-fix-20260513 Phase B Step B2：透传 replyToMessageId 建对话链
    let result: ReturnType<typeof enqueueAgentDeckMessage>;
    try {
      result = enqueueAgentDeckMessage({
        teamId,
        fromSessionId: caller.callerSessionId,
        toSessionId: targetSessionId,
        body: args.text,
        replyToMessageId: args.replyToMessageId ?? null,
      });
    } catch (e) {
      return err(
        e instanceof Error ? e.message : String(e),
        'Correct any message invariant named in the error. For a transient storage error, retry once; if it repeats, stop and inspect Agent Deck main-process logs.',
      );
    }
    if (!result.ok) {
      return err(
        `${result.error} (retryAfterMs=${result.retryAfterMs})`,
        `Wait at least ${result.retryAfterMs} ms, then retry once. To change the limit, ask the user to update mcpMessageRatePerTeamPerMin in Settings.`,
      );
    }
    return ok({
      sessionId: targetSessionId,
      teamId,
      messageId: result.message.id,
      replyToMessageId: result.message.replyToMessageId,
      sentAt: result.message.sentAt,
      queued: true,
    } satisfies SendMessageResult);
  },
);
