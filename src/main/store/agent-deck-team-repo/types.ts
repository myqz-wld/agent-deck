/**
 * Agent Deck Universal Team Backend repo —— types / errors / row-record converters。
 *
 * 拆分历史：从 src/main/store/agent-deck-team-repo.ts 抽出（CHANGELOG_82 / plan
 * deep-review-and-split-20260513 H2 Step 2.2）。原文件 658 行 → 5 文件目录化。
 *
 * 不依赖任何 sibling sub-module，仅 zod-style 数据契约 + sqlite row 转换；
 * team-crud / member-crud / member-query 三 sub-module 共享 import 此处。
 */

import type {
  AgentDeckTeam,
  AgentDeckTeamMember,
  AgentDeckTeamMemberRole,
} from '@shared/types';
import log from '@main/utils/logger';

const logger = log.scope('agent-deck-team-repo-types');

// ────────────────────────────────────────────────────────────────────────────
// Errors
// ────────────────────────────────────────────────────────────────────────────

/** repo 层 invariant 违反（ADR §2.1）；caller 看到 throw 应当 catch + 给用户提示 */
export class TeamInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TeamInvariantError';
  }
}

/** team 不存在或已 hard-delete */
export class TeamNotFoundError extends Error {
  constructor(public teamId: string) {
    super(`team not found: ${teamId}`);
    this.name = 'TeamNotFoundError';
  }
}

// ────────────────────────────────────────────────────────────────────────────
// SQLite row shapes
// ────────────────────────────────────────────────────────────────────────────

export interface TeamRow {
  id: string;
  name: string;
  created_at: number;
  archived_at: number | null;
  // REVIEW_32 MED-7: v016 加列；旧数据 NULL
  archive_reason: string | null;
  metadata: string;
}

export interface MemberRow {
  team_id: string;
  session_id: string;
  role: string;
  display_name: string | null;
  joined_at: number;
  left_at: number | null;
}

// ────────────────────────────────────────────────────────────────────────────
// Row → Record 转换
// ────────────────────────────────────────────────────────────────────────────

export function teamRowToRecord(r: TeamRow): AgentDeckTeam {
  // metadata: 存的是 JSON 字符串（CHECK json_valid 保证可解析）
  // 解析失败兜底：返空对象 + warn（防御 future schema 漂移）
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(r.metadata) as Record<string, unknown>;
    if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
      logger.warn(
        `[agent-deck-team-repo] team ${r.id} metadata 不是 object，退化空对象：${r.metadata}`,
      );
      metadata = {};
    }
  } catch (e) {
    logger.warn(`[agent-deck-team-repo] team ${r.id} metadata JSON 解析失败：${e}`);
    metadata = {};
  }
  return {
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    archivedAt: r.archived_at,
    // REVIEW_32 MED-7：v016 加列；旧数据 NULL（视为「未知来源」，unarchive 联动不复活）
    archiveReason: (r.archive_reason as AgentDeckTeam['archiveReason']) ?? null,
    metadata,
  };
}

export function memberRowToRecord(r: MemberRow): AgentDeckTeamMember {
  if (r.role !== 'lead' && r.role !== 'teammate') {
    // SQL CHECK 已挡，理论上不应到这里；防御性 fallback
    logger.warn(
      `[agent-deck-team-repo] member ${r.team_id}/${r.session_id} role ${r.role} 不合法，退化 teammate`,
    );
  }
  return {
    teamId: r.team_id,
    sessionId: r.session_id,
    role: (r.role === 'lead' ? 'lead' : 'teammate') as AgentDeckTeamMemberRole,
    displayName: r.display_name,
    joinedAt: r.joined_at,
    leftAt: r.left_at,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Input shapes
// ────────────────────────────────────────────────────────────────────────────

export interface CreateTeamInput {
  /** 1-128 char；active 内 unique（部分索引落地） */
  name: string;
  /** JSON 自由扩展位（描述 / 标签 / 来源 'cli'/'ui'/'mcp' 等） */
  metadata?: Record<string, unknown>;
}

export interface AddMemberInput {
  teamId: string;
  sessionId: string;
  role: AgentDeckTeamMemberRole;
  displayName?: string | null;
}

export interface ListTeamsOptions {
  /** true = 仅 active（archived_at IS NULL）；false = 含 archived；默认 true */
  activeOnly?: boolean;
  /** 默认 100 */
  limit?: number;
  /** 默认 0 */
  offset?: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────

export const MAX_LEADS_PER_TEAM = 10;
