/**
 * Agent Deck MCP server tool 共用 helper（CHANGELOG_81 / plan deep-review-and-split-20260513
 * H2 Step 2.1：从原 src/main/agent-deck-mcp/tools.ts 拆出，关注「caller 上下文 + 防御 + 响应
 * 投影」三组 helper）。
 *
 * 依赖：仅 sessionRepo / SessionRecord types / EXTERNAL_CALLER_* 常量；
 * 不依赖 zod schema / SDK runtime —— 任何 handler 都可安全 import。
 */

import type { SessionRecord } from '@shared/types';
import { sessionRepo } from '@main/store/session-repo';
import { agentDeckTeamRepo } from '@main/store/agent-deck-team-repo';
import {
  sessionOwnershipLineage,
  sessionOwnershipLineages,
} from '@main/session/hand-off/ownership';
import {
  EXTERNAL_CALLER_ALLOWED,
  EXTERNAL_CALLER_SENTINEL,
  type CallerContext,
} from '../types';
const MAX_SPAWN_WALK_DEPTH = 64;

/** Handler 共享上下文 —— 所有 handler 第二参数。 */
export interface HandlerContext {
  caller: CallerContext;
}

/** SDK tool handler 的标准返回结构。 */
export type HandlerResult = {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/** Builds the shared handler context from a transport-authenticated caller id. */
export function makeCallerContext(
  callerSessionId: string,
  transport: CallerContext['transport'],
): CallerContext {
  return {
    callerSessionId,
    transport,
  };
}

/**
 * external caller 防御：若工具不允许外部调用且 caller = `__external__`，
 * 直接返回 isError，handler 不执行业务逻辑。
 *
 * HTTP per-session authentication may resolve a real caller; global-token access is forced to the
 * external sentinel by the transport before this guard runs.
 */
export function denyExternalIfNotAllowed(
  toolName: keyof typeof EXTERNAL_CALLER_ALLOWED,
  caller: CallerContext,
): HandlerResult | null {
  if (
    caller.callerSessionId === EXTERNAL_CALLER_SENTINEL &&
    !EXTERNAL_CALLER_ALLOWED[toolName]
  ) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            error: `tool ${toolName} not allowed for external caller (callerSessionId=__external__)`,
            hint: 'External MCP clients can only call read-only tools (list_sessions, get_session, task_list). To spawn / send / shutdown sessions, use an in-process session or a per-session HTTP token.',
          }),
        },
      ],
      isError: true as const,
    };
  }
  return null;
}

/**
 * R37 P1 Step 1.1：MCP handler 共用「deny external + caller 反查」防御链 wrapper。
 * 抽出前每个 handler 起手都是 5 行模板（4 处独立维护 → 一处漏 denyExternalIfNotAllowed
 * 即 security risk: external caller 能调禁用 tool）。抽出后 handler 业务直接写 wrapper body。
 *
 * 透传 handler 的测试 seam / runtime options，用 rest param `...extra` 实现 — wrapper
 * 对 handler 任意签名都透明。
 */
export function withMcpGuard<
  TArgs,
  TExtra extends unknown[],
  TResult extends HandlerResult,
>(
  toolName: keyof typeof EXTERNAL_CALLER_ALLOWED,
  handler: (args: TArgs, ctx: HandlerContext, ...extra: TExtra) => Promise<TResult>,
): (args: TArgs, ctx: HandlerContext, ...extra: TExtra) => Promise<TResult | HandlerResult> {
  return async (args, ctx, ...extra) => {
    const denial = denyExternalIfNotAllowed(toolName, ctx.caller);
    if (denial) return denial;
    const callerCheck = validateExternalCaller(ctx.caller);
    if (callerCheck) return callerCheck;
    return handler(args, ctx, ...extra);
  };
}

export function ok(data: unknown): HandlerResult {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

/** Return a successful MCP result through the structured content channel. */
export function structuredOk<T extends Record<string, unknown>>(
  data: T,
): HandlerResult {
  return {
    content: [],
    structuredContent: data,
  };
}

/**
 * 构造 error result。
 *
 * Optional extras add machine-readable recovery context while the text body remains a single JSON
 * error object. Ordinary errors should use only message and hint.
 */
export function err(
  message: string,
  hint?: string,
  extras?: Record<string, unknown>,
): HandlerResult {
  const payload: Record<string, unknown> = { error: message };
  if (hint !== undefined) payload.hint = hint;
  if (extras !== undefined) Object.assign(payload, extras);
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(payload),
      },
    ],
    isError: true as const,
  };
}

/**
 * caller 反查（HTTP transport 用；in-process 已通过 closure 强制覆盖跳过）：
 * - external caller（__external__）已被 denyExternalIfNotAllowed 拦下，不到这里
 * - in-process closure 覆盖后的 caller 也直接信任
 * - HTTP：transport-authenticated callerSessionId 必须能反查到 sessionRepo 且未 closed
 *
 * 返回 null 表示通过；返回错误对象表示 deny。
 */
export function validateExternalCaller(caller: CallerContext): HandlerResult | null {
  if (caller.transport === 'in-process') return null;
  if (caller.callerSessionId === EXTERNAL_CALLER_SENTINEL) return null;
  const session = sessionRepo.get(caller.callerSessionId);
  if (!session) {
    return err(
      `unknown callerSessionId: ${caller.callerSessionId}`,
      'Use a per-session MCP token issued by Agent Deck, or the global MCP token for read-only external access.',
    );
  }
  if (session.lifecycle === 'closed') {
    return err(
      `callerSessionId ${caller.callerSessionId} is closed`,
      'Closed sessions cannot initiate new MCP tool calls. Open a new session via the application.',
    );
  }
  return null;
}

function findSpawnParent(
  sessionId: string,
  cache: Map<string, string | null>,
): string | null {
  if (cache.has(sessionId)) return cache.get(sessionId) ?? null;
  const rec = sessionRepo.get(sessionId);
  const parent = rec?.spawnedBy ?? null;
  cache.set(sessionId, parent);
  return parent;
}

function isSpawnAncestor(
  ancestorId: string,
  childId: string,
  cache: Map<string, string | null>,
): boolean {
  const seen = new Set<string>();
  let current: string | null = findSpawnParent(childId, cache);
  for (let depth = 0; current && depth < MAX_SPAWN_WALK_DEPTH; depth += 1) {
    if (current === ancestorId) return true;
    if (seen.has(current)) return false;
    seen.add(current);
    current = findSpawnParent(current, cache);
  }
  return false;
}

export function isSpawnRelatedSession(
  candidateId: string,
  callerId: string,
  cache: Map<string, string | null> = new Map(),
): boolean {
  return (
    candidateId === callerId ||
    isSpawnAncestor(candidateId, callerId, cache) ||
    isSpawnAncestor(callerId, candidateId, cache)
  );
}

export function isRelatedSessionVisible(
  caller: SessionRecord,
  candidate: SessionRecord,
  opts?: {
    spawnParentCache?: Map<string, string | null>;
    callerTeamIds?: Set<string>;
    ownershipLineageCache?: Map<string, string[]>;
  },
): boolean {
  const spawnParentCache = opts?.spawnParentCache ?? new Map<string, string | null>();
  const callerLineage = opts?.ownershipLineageCache?.get(caller.id) ?? sessionOwnershipLineage(caller.id);
  const candidateLineage = opts?.ownershipLineageCache?.get(candidate.id) ?? sessionOwnershipLineage(candidate.id);
  if (
    callerLineage.some((callerId) =>
      candidateLineage.some((candidateId) =>
        isSpawnRelatedSession(candidateId, callerId, spawnParentCache),
      ),
    )
  ) return true;
  const callerTeamIds = opts?.callerTeamIds ?? new Set((caller.teams ?? []).map((t) => t.teamId));
  return (candidate.teams ?? []).some((t) => callerTeamIds.has(t.teamId));
}

export type RelatedSessionReadAccess =
  | { allowed: true }
  | {
      allowed: false;
      reason: 'external-caller' | 'caller-not-found' | 'caller-closed' | 'target-not-found' | 'unrelated';
      message: string;
      hint?: string;
    };

export function getRelatedSessionReadAccess(
  callerSessionId: string,
  targetSessionId: string,
): RelatedSessionReadAccess {
  if (callerSessionId === EXTERNAL_CALLER_SENTINEL) {
    return {
      allowed: false,
      reason: 'external-caller',
      message: 'list_session_events requires a real Agent Deck session caller',
      hint: 'External MCP clients have no session identity for self/spawn/team visibility checks. Use an in-app SDK session or inspect history in the Agent Deck UI.',
    };
  }

  const caller = sessionRepo.get(callerSessionId);
  if (!caller) {
    return {
      allowed: false,
      reason: 'caller-not-found',
      message: `callerSessionId ${callerSessionId} not found`,
      hint: 'callerSessionId must reference an existing Agent Deck session.',
    };
  }
  if (caller.lifecycle === 'closed') {
    return {
      allowed: false,
      reason: 'caller-closed',
      message: `callerSessionId ${callerSessionId} is closed`,
      hint: 'Open a new session before reading another session trajectory.',
    };
  }

  const target = sessionRepo.get(targetSessionId);
  if (!target) {
    return {
      allowed: false,
      reason: 'target-not-found',
      message: `session ${targetSessionId} not found`,
      hint: 'Use list_sessions to discover readable session ids.',
    };
  }

  const spawnParentCache = new Map<string, string | null>();
  spawnParentCache.set(caller.id, caller.spawnedBy ?? null);
  spawnParentCache.set(target.id, target.spawnedBy ?? null);
  const ownershipLineages = sessionOwnershipLineages([caller.id, target.id]);
  const callerLineage = ownershipLineages.get(caller.id) ?? [caller.id];
  const targetLineage = ownershipLineages.get(target.id) ?? [target.id];
  if (
    callerLineage.some((callerId) =>
      targetLineage.some((targetId) =>
        isSpawnRelatedSession(targetId, callerId, spawnParentCache),
      ),
    )
  ) return { allowed: true };

  if (agentDeckTeamRepo.findSharedActiveTeams(caller.id, target.id).length > 0) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: 'unrelated',
    message: `session ${targetSessionId} is not readable from callerSessionId ${callerSessionId}`,
    hint: 'Trajectory reads are limited to the current handoff ownership chain, spawn ancestors/descendants, or sessions sharing an active team.',
  };
}

/**
 * SessionRecord → metadata 投影。**list_sessions / get_session 共用同一份 projector**
 * （REVIEW_28 reviewer-codex LOW-2 修法）：避免 get_session 暴露 raw SessionRecord 引入额外
 * metadata；future visibility predicate 加在这一层即可两 tool 同步生效。
 *
 * plan team-cohesion-fix-20260513 Phase A Step A7：直接消费 enriched `s.teams` 字段
 * （由 sessionManager.enrichWithTeams / enrichWithTeamsBatch 注入），不再 N+1 反查。
 * 调用方必须传 enriched SessionRecord（list_sessions / get_session handler 已切到
 * sessionManager facade 路径保证 enriched）。teamName 取 teams[0]?.teamName 与 SessionCard 一致。
 *
 * 多 team 共享时取第一个（teamName 字段语义是「展示用」非路由标识；路由用 spawn 时
 * 显式 args.teamName / send_message 显式 teamId）。新增 teams 完整数组字段方便
 * caller 自行查多 team 共享场景。
 */
export function projectSession(s: SessionRecord) {
  return {
    sessionId: s.id,
    adapter: s.agentId,
    gateway: s.agentId === 'claude-code' ? s.runtimeProvider ?? null : null,
    profile: s.agentId === 'codex-cli' ? s.runtimeProvider ?? null : null,
    cwd: s.cwd,
    lifecycle: s.lifecycle,
    title: s.title,
    lastEventAt: s.lastEventAt,
    teamName: s.teams?.[0]?.teamName ?? null,
    teams: s.teams ?? [],
    spawnedBy: s.spawnedBy ?? null,
    spawnDepth: s.spawnDepth ?? 0,
  };
}
