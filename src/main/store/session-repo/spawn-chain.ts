/**
 * session-repo —— Agent Deck MCP server (R2 / B'0 ADR §6.5) spawn 链路 4 个反查 / 写操作。
 *
 * 拆分历史：从 src/main/store/session-repo.ts 抽出（CHANGELOG_83 / plan
 * deep-review-and-split-20260513 H2 Step 2.3）。
 */

import type { LifecycleState, SessionRecord } from '@shared/types';
import { getDb } from '../db';
import { rowToRecord, type Row } from './types';
import log from '@main/utils/logger';

const logger = log.scope('session-repo-spawn-chain');

/**
 * 单查 sessions.spawn_depth。session 不存在返回 0（兜底，与 spawn_session
 * handler 计算「parent_depth + 1」保持一致：未知 caller → 默认顶层）。
 * 用于 §6.1 depth 上限校验。
 */
export function getSpawnDepth(id: string): number {
  const row = getDb()
    .prepare(`SELECT spawn_depth FROM sessions WHERE id = ?`)
    .get(id) as { spawn_depth: number } | undefined;
  return row?.spawn_depth ?? 0;
}

/**
 * UPDATE sessions SET spawned_by, spawn_depth WHERE id = ?。
 * MCP `spawn_session` handler 在 reserve 占位行 + createSession 后调，
 * 写入 spawn 链路关系。session 必须先存在（通常先 INSERT 占位行 / 由 createSession
 * adapter 写入），否则该调用 changes=0。
 *
 * **CHANGELOG_139 加 changes=0 console.warn 配套(reviewer-claude LOW-2 + reviewer-codex MED-1
 * 共识)**:旧版 SQL UPDATE 失败完全静默,任何 sid mismatch 类 bug(如 codex spawn 主路径
 * applicationSid 漏切到 realId,setSpawnLink 写到不存在的 tempKey row)隐藏到现在。加 warn
 * 让 future regression 能从 log 早抓到,不静默淹没。
 */
export function setSpawnLink(id: string, spawnedBy: string | null, depth: number): void {
  const info = getDb()
    .prepare(`UPDATE sessions SET spawned_by = ?, spawn_depth = ? WHERE id = ?`)
    .run(spawnedBy, depth, id);
  if (info.changes === 0) {
    logger.warn(
      `[setSpawnLink] UPDATE 0 rows for id=${id} (spawnedBy=${spawnedBy}, depth=${depth}) — ` +
        `session row 不存在,spawn-link 写入静默失败。可能根因:adapter.createSession 返了 tempKey 不是 realId,` +
        `或 caller 在 setSpawnLink 之前 row 已被删/未建。`,
    );
  }
}

/**
 * 列出 spawnedBy = parentId 的所有 active children（用于 §6.4 per-parent fan-out）。
 * 默认仅返回 lifecycle = 'active'；可通过 lifecycle 参数 override（'all' = 不限）。
 */
export function listChildren(
  parentId: string,
  lifecycle: LifecycleState | 'all' = 'active',
): SessionRecord[] {
  const db = getDb();
  const rows =
    lifecycle === 'all'
      ? (db
          .prepare(
            `SELECT * FROM sessions WHERE spawned_by = ? AND archived_at IS NULL ORDER BY started_at DESC`,
          )
          .all(parentId) as Row[])
      : (db
          .prepare(
            `SELECT * FROM sessions WHERE spawned_by = ? AND lifecycle = ? AND archived_at IS NULL ORDER BY started_at DESC`,
          )
          .all(parentId, lifecycle) as Row[]);
  return rows.map(rowToRecord);
}
