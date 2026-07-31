import type { Database } from 'better-sqlite3';
import { getDb } from '../db';
import type { Row } from './types';

/**
 * Atomically replace a temporary application session id with the first canonical provider id.
 * The canonical target must not exist: merging two persisted session identities would silently
 * combine unrelated history. Child references move before the temporary row is deleted.
 */
export function rename(fromId: string, toId: string): void {
  renameWithDb(getDb(), fromId, toId);
}

/**
 * Session-id moves are intentionally excluded from the per-event UPDATE revision trigger: allocating
 * one revision per moved row would make rename cost and semantics depend on history size. Instead,
 * rename publishes one destructive boundary after every event has moved. The boundary is strictly
 * greater than every moved effective revision, so migrated summary metadata cannot collide with the
 * new epoch. The next derived state must rebuild there, including when there is no event.
 */
function recomputeEventRevisionAfterRename(db: Database, toId: string): void {
  const result = db
    .prepare(
      `WITH next_boundary AS (
         SELECT MAX(
           revision + 1,
           COALESCE(
             (SELECT MAX(change_revision)
                FROM events
               WHERE session_id = ?),
             0
           ) + 1
         ) AS boundary
           FROM session_event_revisions
          WHERE session_id = ?
       )
       UPDATE session_event_revisions
          SET revision = (SELECT boundary FROM next_boundary),
              rebuild_after_revision = (SELECT boundary FROM next_boundary)
        WHERE session_id = ?`,
    )
    .run(toId, toId, toId);

  if (result.changes !== 1) {
    throw new Error(`Cannot recompute event revision for renamed session ${toId}`);
  }
}

/** Database-injected variant used by repository tests. */
export function renameWithDb(db: Database, fromId: string, toId: string): void {
  if (fromId === toId) return;
  const tx = db.transaction(() => {
    const fromRow = db
      .prepare(`SELECT * FROM sessions WHERE id = ?`)
      .get(fromId) as Row | undefined;
    if (!fromRow) return; // tempKey 行不存在就什么都不做
    if (db.prepare(`SELECT 1 FROM sessions WHERE id = ?`).get(toId)) {
      throw new Error(`Cannot rename session ${fromId} to existing session ${toId}`);
    }

    db.prepare(
      `INSERT INTO sessions
         (id, agent_id, runtime_provider, cwd, title, source, lifecycle, activity, started_at, last_event_at, ended_at, archived_at, permission_mode, session_mode, agent_profile_name, agent_profile_source, agent_plugin_dir, codex_sandbox, codex_approval_policy, claude_code_sandbox, grok_sandbox, model, thinking, extra_allow_write, spawned_by, spawn_depth, cli_session_id, network_access_enabled, additional_directories, grok_usage_watermark, pinned_at, hidden_from_history)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      toId,
      fromRow.agent_id,
      fromRow.runtime_provider,
      fromRow.cwd,
      fromRow.title,
      fromRow.source,
      fromRow.lifecycle,
      fromRow.activity,
      fromRow.started_at,
      fromRow.last_event_at,
      fromRow.ended_at,
      fromRow.archived_at,
      fromRow.permission_mode,
      fromRow.session_mode,
      fromRow.agent_profile_name,
      fromRow.agent_profile_source,
      fromRow.agent_plugin_dir,
      fromRow.codex_sandbox,
      fromRow.codex_approval_policy,
      fromRow.claude_code_sandbox,
      fromRow.grok_sandbox,
      fromRow.model,
      fromRow.thinking,
      fromRow.extra_allow_write,
      fromRow.spawned_by,
      fromRow.spawn_depth,
      toId,
      fromRow.network_access_enabled,
      fromRow.additional_directories,
      fromRow.grok_usage_watermark,
      fromRow.pinned_at,
      fromRow.hidden_from_history,
    );
    db.prepare(`UPDATE sessions SET context_usage = ? WHERE id = ?`).run(
      fromRow.context_usage ?? null,
      toId,
    );
    // Move FK-owned history before deleting the temporary row.
    db.prepare(`UPDATE events SET session_id = ? WHERE session_id = ?`).run(toId, fromId);
    recomputeEventRevisionAfterRename(db, toId);
    db.prepare(`UPDATE file_changes SET session_id = ? WHERE session_id = ?`).run(toId, fromId);
    db.prepare(`UPDATE summaries SET session_id = ? WHERE session_id = ?`).run(toId, fromId);

    // Preserve current team ownership instead of letting source deletion cascade it away.
    db.prepare(
      `UPDATE agent_deck_team_members SET session_id = ? WHERE session_id = ?`,
    ).run(toId, fromId);

    // Message references have no FK so deleted senders remain attributable. During rename, move
    // both endpoints explicitly so the surviving session owns current delivery and reply chains.
    db.prepare(
      `UPDATE agent_deck_messages SET from_session_id = ? WHERE from_session_id = ?`,
    ).run(toId, fromId);
    db.prepare(
      `UPDATE agent_deck_messages SET to_session_id = ? WHERE to_session_id = ?`,
    ).run(toId, fromId);

    // Durable handoff aliases are identity references too. Point older chains at the surviving id,
    // move any continuation owned by the renamed row, then retain OLD → NEW. Keeping the old key is
    // essential: provider history and wire prefixes may mention it long after the sessions row is
    // gone, and this table intentionally has no session FK for exactly that reason.
    // The destination now names a live session, so discard any older alias with that source key
    // before retargeting predecessors; otherwise a historical NEW → OLD row becomes a CHECK-
    // violating NEW → NEW self-loop during the update below.
    db.prepare(
      `DELETE FROM session_handoff_aliases WHERE source_session_id = ?`,
    ).run(toId);
    db.prepare(
      `UPDATE session_handoff_aliases
          SET successor_session_id = ?
        WHERE successor_session_id = ?`,
    ).run(toId, fromId);
    db.prepare(
      `INSERT INTO session_handoff_aliases
         (source_session_id, successor_session_id, created_at)
       SELECT ?, successor_session_id, created_at
         FROM session_handoff_aliases
        WHERE source_session_id = ?
          AND successor_session_id <> ?
       ON CONFLICT(source_session_id) DO UPDATE SET
         successor_session_id = excluded.successor_session_id,
         created_at = MAX(session_handoff_aliases.created_at, excluded.created_at)`,
    ).run(toId, fromId, toId);
    db.prepare(
      `INSERT INTO session_handoff_aliases
         (source_session_id, successor_session_id, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(source_session_id) DO UPDATE SET
         successor_session_id = excluded.successor_session_id,
         created_at = MAX(session_handoff_aliases.created_at, excluded.created_at)`,
    ).run(fromId, toId, Date.now());

    // Preserve spawn lineage instead of allowing source deletion to null child ownership.
    db.prepare(
      `UPDATE sessions SET spawned_by = ? WHERE spawned_by = ?`,
    ).run(toId, fromId);

    // Tasks and issue provenance are session identity state too; move them before FK cleanup.
    db.prepare(
      `UPDATE tasks SET owner_session_id = ? WHERE owner_session_id = ?`,
    ).run(toId, fromId);
    db.prepare(
      `UPDATE issues SET source_session_id = ? WHERE source_session_id = ?`,
    ).run(toId, fromId);
    db.prepare(
      `UPDATE issues SET resolution_session_id = ? WHERE resolution_session_id = ?`,
    ).run(toId, fromId);
    db.prepare(
      `UPDATE issue_appendices SET appended_session_id = ? WHERE appended_session_id = ?`,
    ).run(toId, fromId);

    db.prepare(`DELETE FROM sessions WHERE id = ?`).run(fromId);
  });
  tx();
}
