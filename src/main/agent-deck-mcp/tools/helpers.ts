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
import {
  EXTERNAL_CALLER_ALLOWED,
  EXTERNAL_CALLER_SENTINEL,
  type CallerContext,
} from '../types';
import log from '@main/utils/logger';

const logger = log.scope('mcp-helpers');

/** Handler 共享上下文 —— 所有 handler 第二参数。 */
export interface HandlerContext {
  caller: CallerContext;
}

/** SDK tool handler 的标准返回结构。 */
export type HandlerResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

/**
 * Tool handler 共用：把 zod 解析后的 callerSessionId（args 字段）规范为
 * CallerContext。in-process transport 在外层 wrapper 内会**再次**用 closure
 * 覆盖 callerSessionId（强制语义防 prompt 注入伪造）。
 */
export function makeCallerContext(
  rawCallerSid: string | null | undefined,
  rawParentSid: string | undefined,
  transport: CallerContext['transport'],
): CallerContext {
  // REVIEW_32 HIGH-9：callerSessionId 改 optional 后，in-process 走 override 注入真实 sid；
  // external (HTTP/stdio) 没 override → 用占位 EXTERNAL_CALLER_SENTINEL，下游 denyExternalIfNotAllowed
  // 兜底拒绝需要真实 session 上下文的 tool。空字符串 / null 都视为缺省。
  // REVIEW_56 §F8 修法 (Plan-Review Round 1 + spike 决策): raw '__external__' literal 替换为
  // EXTERNAL_CALLER_SENTINEL const (types.ts:16 已 SSOT);其他 user-facing error / hint message
  // text (L81/L96/L104/L190) 故意保留字面值方便用户 grep 定位,不替换。
  const callerSid = rawCallerSid && rawCallerSid.length > 0 ? rawCallerSid : EXTERNAL_CALLER_SENTINEL;
  return {
    callerSessionId: callerSid,
    parentSessionId: rawParentSid ?? callerSid,
    transport,
  };
}

/**
 * external caller 防御：若工具不允许外部调用且 caller = `__external__`，
 * 直接返回 isError，handler 不执行业务逻辑。
 *
 * **B-HIGH-1 (C) 修法 (a) — stdio invariant assertion 兜底层**
 * （deep-review-batch-a1-b-fixes-20260519 plan / REVIEW_46）:
 * 旧版仅 sentinel 检测让 stdio caller 能传 `args.callerSessionId` 当任意 active sid 调写工具
 * （EXTERNAL_CALLER_ALLOWED[X]=false 但 callerSid != sentinel → bypass deny → 以 victim 身份执行）。
 * 修法 (b)/(c) 在 transport 层把 stdio / HTTP global token fallback 强制 force sentinel
 * 切断 spoofing 源头；本处 (a) 加 stdio transport invariant 兜底守门：transport=stdio 时
 * callerSid 应该总是 sentinel（transport-stdio.ts:77 修法已 force），如出现非 sentinel =
 * transport 层漏改 invariant violation → deny + console.error 兜底。
 *
 * **不**对 HTTP transport 加同款守门：HTTP per-session authn（authInfo.resolvedSid = real sid）
 * 是合法路径，误杀会破坏 mcp-session-token-map 流程（plan-review v2 NEW-H1 codex 反馈）。
 * HTTP global token fallback 的 spoofing 防御**完全靠 transport-http.ts:92-98 修法 (c)** 在源头
 * force sentinel；本处仅 stdio 兜底，不再尝试集中守门 HTTP。
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
            hint: 'External MCP clients can only call read-only tools (list_sessions, get_session). To spawn / send / shutdown sessions, use the in-process or HTTP transport with a real callerSessionId.',
          }),
        },
      ],
      isError: true as const,
    };
  }
  // B-HIGH-1 (C) 修法 (a): stdio invariant assertion 兜底守门
  if (
    caller.transport === 'stdio' &&
    caller.callerSessionId !== EXTERNAL_CALLER_SENTINEL &&
    !EXTERNAL_CALLER_ALLOWED[toolName]
  ) {
    logger.error(
      `[helpers] invariant violated: stdio transport callerSid="${caller.callerSessionId}" (should always be "__external__" sentinel — check transport-stdio.ts callerSessionIdOverride is set to () => EXTERNAL_CALLER_SENTINEL)`,
    );
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            error: `tool ${toolName} not allowed for stdio transport with non-sentinel callerSessionId (stdio invariant violation — transport layer should force sentinel).`,
            hint: 'stdio transport must use callerSessionId="__external__" sentinel for write tools (no per-session authn supported on stdio). If you see this error, transport-stdio.ts:77 callerSessionIdOverride was not properly set to () => EXTERNAL_CALLER_SENTINEL.',
          }),
        },
      ],
      isError: true as const,
    };
  }
  return null;
}

/**
 * R37 P1 Step 1.1：18 个 handler 共用「deny external + caller 反查」防御链 wrapper。
 * 抽出前每个 handler 起手都是 5 行模板（4 处独立维护 → 一处漏 denyExternalIfNotAllowed
 * 即 security risk: external caller 能调禁用 tool）。抽出后 handler 业务直接写 wrapper body。
 *
 * 透传 spawnSessionHandler 的第三参数 `opts?: { handOffMode?: boolean; batonRole?: 'lead' | 'teammate' }`
 * + archive-plan / hand-off-session 的 `handlerDeps?` 用 rest param `...extra` 实现 — wrapper
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

/**
 * 构造 error result。
 *
 * **R3 fix-5 (M5 codex Batch B MED-2)**: 加 optional `extras` 第三参 — partial-success error
 * path 透传额外结构化字段（如 exit-worktree handler 的 `markerCleared` 状态）给 MCP caller。
 * 旧 caller (仅 message + hint) 行为不变 — extras 缺省时仍 serialize `{error, hint?}`。
 *
 * 使用约束: extras 仅用于结构化 partial-success 字段（caller 需要根据这些字段决定 retry / 兜底
 * 行为）。普通 error 不传 extras（避免无意义 noise）。
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
 * caller 反查（HTTP/stdio transport 用；in-process 已通过 closure 强制覆盖跳过）：
 * - external caller（__external__）已被 denyExternalIfNotAllowed 拦下，不到这里
 * - in-process closure 覆盖后的 caller 也直接信任
 * - HTTP/stdio：args.callerSessionId 必须能反查到 sessionRepo 且未 closed
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
      'callerSessionId must reference a session managed by Agent Deck. Use list_sessions to find valid session ids, or use the literal "__external__" for read-only access from non-Agent-Deck MCP clients.',
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

// 测试 hooks（保留 _internalOk / _internalErr 老 export 名，向后兼容；当前无 caller 但保留
// 以防 external 测试依赖）
export { ok as _internalOk, err as _internalErr };
