/**
 * list_sessions handler —— 只读列表（status_filter / adapter_filter / spawned_by_filter
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

import {
  ok,
  projectSession,
  withMcpGuard,
  type HandlerContext,
} from '../helpers';
import type { ListSessionsArgs, ListSessionsResult } from '../schemas';

export const listSessionsHandler = withMcpGuard(
  'list_sessions',
  async (args: ListSessionsArgs, _ctx: HandlerContext) => {
    // 现有 sessionRepo API：
    // - status='active' 默认 → listActiveAndDormant().filter(lifecycle==='active')
    // - status='dormant' → listActiveAndDormant().filter(lifecycle==='dormant')
    // - status='closed' → listHistory({ archivedOnly:false }) 含 closed + archived
    // - status='all' → 合并去重
    // 注：此处用现有 API 拼装，避免新增 sessionRepo 通用 list({status,adapter,limit})
    // 接口（ADR §6.5.2 #6 实施清单建议加，但需要重构现有 47 个调用点 — 留 R2 收口或 R3）
    let sessions: SessionRecord[] = [];
    if (args.status_filter === 'active' || args.status_filter === 'dormant') {
      sessions = sessionRepo
        .listActiveAndDormant(args.limit * 2)
        .filter((s) => s.lifecycle === args.status_filter);
    } else if (args.status_filter === 'closed') {
      sessions = sessionRepo.listHistory({ limit: args.limit });
    } else {
      // 'all'
      const live = sessionRepo.listActiveAndDormant(args.limit);
      const closed = sessionRepo.listHistory({ limit: args.limit });
      sessions = [...live, ...closed];
    }
    if (args.adapter_filter) {
      sessions = sessions.filter((s) => s.agentId === args.adapter_filter);
    }
    // spawned_by_filter 在 slice(limit) 前执行（REVIEW_28 reviewer-codex INFO-1 修法），
    // 避免大 lead 反查少量 children 时被 limit cutoff 误报空列表。
    if (args.spawned_by_filter) {
      sessions = sessions.filter((s) => s.spawnedBy === args.spawned_by_filter);
    }
    const truncated = sessions.slice(0, args.limit);
    // plan team-cohesion-fix-20260513 Phase A Step A7：projectSession 不再自反查 universal
    // team backend，依赖 caller 传 enriched SessionRecord。这里在 slice 后 batch enrich
    // 一次（避免 list 整批 ≤ 100 sessions 各反查一次 N+1）。
    const enriched = sessionManager.enrichWithTeamsBatch(truncated);
    return ok({
      total: enriched.length,
      sessions: enriched.map(projectSession),
    } satisfies ListSessionsResult);
  },
);
