/**
 * list_sessions handler —— 只读列表（statusFilter / adapterFilter / spawnedByFilter
 * + slice limit）。返回 enrich 过 teams[] 的 metadata。
 *
 * 拆分历史：从 src/main/agent-deck-mcp/tools.ts 943-993 抽出（CHANGELOG_81 / plan
 * deep-review-and-split-20260513 H2 Step 2.1）。
 *
 * R37 P1 Step 1.1：5 行 deny external + caller 反查 boilerplate 走 withMcpGuard wrapper。
 */

import { sessionRepo } from '@main/store/session-repo';
import { sessionManager } from '@main/session/manager';
import type { SessionRecord } from '@shared/types';

import { EXTERNAL_CALLER_SENTINEL } from '../../types';
import {
  isRelatedSessionVisible,
  ok,
  projectSession,
  withMcpGuard,
  type HandlerContext,
} from '../helpers';
import type { ListSessionsArgs, ListSessionsResult } from '../schemas';

const DEFAULT_LIMIT = 50;
const DEFAULT_OFFSET = 0;
const MAX_PAGE_SCAN_BATCH = 500;
const MIN_PAGE_SCAN_BATCH = 200;

function pageScanBatch(limit: number): number {
  return Math.min(Math.max(limit * 4, MIN_PAGE_SCAN_BATCH), MAX_PAGE_SCAN_BATCH);
}

function listBasePage(args: ListSessionsArgs, limit: number, offset: number): SessionRecord[] {
  const statusFilter = args.statusFilter ?? 'active';
  if (statusFilter === 'active' || statusFilter === 'dormant') {
    return sessionRepo.listActiveAndDormant(
      limit,
      offset,
      statusFilter,
      args.spawnedByFilter,
      args.adapterFilter,
    );
  }
  if (statusFilter === 'closed') {
    return sessionRepo.listHistory({
      limit,
      offset,
      spawnedBy: args.spawnedByFilter,
      agentId: args.adapterFilter,
    });
  }
  const needed = offset + limit;
  const live = sessionRepo.listActiveAndDormant(
    needed,
    0,
    undefined,
    args.spawnedByFilter,
    args.adapterFilter,
  );
  const closed = sessionRepo.listHistory({
    limit: needed,
    spawnedBy: args.spawnedByFilter,
    agentId: args.adapterFilter,
  });
  return [...live, ...closed]
    .sort((a, b) => (b.lastEventAt ?? 0) - (a.lastEventAt ?? 0))
    .slice(offset, needed);
}

function filterRelatedForCaller(
  sessions: SessionRecord[],
  callerSessionId: string,
): SessionRecord[] {
  const caller = sessionManager.get(callerSessionId);
  if (!caller) return [];

  const enriched = sessionManager.enrichWithTeamsBatch(sessions);
  const callerTeamIds = new Set((caller.teams ?? []).map((t) => t.teamId));
  const spawnParentCache = new Map<string, string | null>();
  spawnParentCache.set(caller.id, caller.spawnedBy ?? null);
  for (const s of sessions) {
    spawnParentCache.set(s.id, s.spawnedBy ?? null);
  }

  return enriched.filter((s) => {
    return isRelatedSessionVisible(caller, s, { spawnParentCache, callerTeamIds });
  });
}

function applyExplicitFilters(sessions: SessionRecord[], args: ListSessionsArgs): SessionRecord[] {
  let out = sessions;
  // Repo 查询已经下推 adapterFilter / spawnedByFilter；这里保留防御性收口，避免 mock 或旧
  // 调用路径漏传时扩大可见结果。
  if (args.adapterFilter) {
    out = out.filter((s) => s.agentId === args.adapterFilter);
  }
  if (args.spawnedByFilter) {
    out = out.filter((s) => s.spawnedBy === args.spawnedByFilter);
  }
  return out;
}

function applyDefaultScope(
  sessions: SessionRecord[],
  args: ListSessionsArgs,
  ctx: HandlerContext,
): SessionRecord[] {
  if (!args.spawnedByFilter && ctx.caller.callerSessionId !== EXTERNAL_CALLER_SENTINEL) {
    return filterRelatedForCaller(sessions, ctx.caller.callerSessionId);
  }
  return sessionManager.enrichWithTeamsBatch(sessions);
}

function collectOutputPage(
  args: ListSessionsArgs,
  ctx: HandlerContext,
): { page: SessionRecord[]; hasMore: boolean } {
  const limit = args.limit ?? DEFAULT_LIMIT;
  const outputOffset = args.offset ?? DEFAULT_OFFSET;
  const outputEnd = outputOffset + limit;
  const scanUntil = outputEnd + 1;
  const batch = pageScanBatch(limit);
  const collected: SessionRecord[] = [];

  for (let baseOffset = 0; collected.length < scanUntil; baseOffset += batch) {
    const basePage = listBasePage(args, batch, baseOffset);
    if (basePage.length === 0) break;
    const explicitlyFiltered = applyExplicitFilters(basePage, args);
    const scoped = applyDefaultScope(explicitlyFiltered, args, ctx);
    collected.push(...scoped);
    if (basePage.length < batch) break;
  }

  return {
    page: collected.slice(outputOffset, outputEnd),
    hasMore: collected.length > outputEnd,
  };
}

export const listSessionsHandler = withMcpGuard(
  'list_sessions',
  async (args: ListSessionsArgs, ctx: HandlerContext) => {
    // 现有 sessionRepo API：
    // - status='active' 默认 → listActiveAndDormant(..., lifecycle='active')
    // - status='dormant' → listActiveAndDormant(..., lifecycle='dormant')
    // - status='closed' → listHistory({ archivedOnly:false }) 含 closed + archived
    // - status='all' → 合并去重
    // 注：此处用现有 API 拼装，避免新增 sessionRepo 通用 list({status,adapter,limit})
    // 接口（ADR §6.5.2 #6 实施清单建议加，但需要重构现有 47 个调用点 — 留 R2 收口或 R3）
    const { page, hasMore } = collectOutputPage(args, ctx);
    // plan team-cohesion-fix-20260513 Phase A Step A7：projectSession 不再自反查 universal
    // team backend，依赖 caller 传 enriched SessionRecord。collectOutputPage 已按 page batch enrich
    // 并做默认 caller-related 过滤，避免 list_sessions 默认暴露无关 active sessions。
    return ok({
      total: page.length,
      hasMore,
      sessions: page.map(projectSession),
    } satisfies ListSessionsResult);
  },
);
