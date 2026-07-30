import type Database from 'better-sqlite3';
import { getDb } from './db';
import type { WorktreeTransitionQueuedInput } from '@main/session/worktree-transition/types';

interface WorktreeTransitionInputRow {
  session_id: string;
  generation: number;
  sequence: number;
  agent_id: string;
  text: string;
  attachments_json: string | null;
  created_at: number;
  delivered_at: number | null;
}

function parseAttachments(value: string | null): unknown[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function rowToInput(
  row: WorktreeTransitionInputRow,
): WorktreeTransitionQueuedInput {
  return {
    sessionId: row.session_id,
    generation: row.generation,
    sequence: row.sequence,
    agentId: row.agent_id,
    text: row.text,
    attachments: parseAttachments(row.attachments_json),
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
  };
}

export function appendWorktreeTransitionInputWithDb(
  db: Database.Database,
  input: {
    sessionId: string;
    generation: number;
    agentId: string;
    text: string;
    attachments?: unknown[];
    createdAt: number;
  },
): WorktreeTransitionQueuedInput {
  const row = db.transaction(() => {
    const transition = db
      .prepare(
        `SELECT phase FROM worktree_cwd_transitions
         WHERE session_id = ? AND generation = ?`,
      )
      .get(input.sessionId, input.generation) as
      | { phase: string }
      | undefined;
    if (
      !transition ||
      transition.phase === 'active' ||
      transition.phase === 'cleared'
    ) {
      throw new Error(
        `Worktree transition ${input.sessionId}:${input.generation} is not accepting queued input.`,
      );
    }
    const next = db
      .prepare(
        `SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
         FROM worktree_cwd_transition_inputs
         WHERE session_id = ? AND generation = ?`,
      )
      .get(input.sessionId, input.generation) as { sequence: number };
    db.prepare(
      `INSERT INTO worktree_cwd_transition_inputs
        (session_id, generation, sequence, agent_id, text, attachments_json,
         created_at, delivered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      input.sessionId,
      input.generation,
      next.sequence,
      input.agentId,
      input.text,
      input.attachments?.length ? JSON.stringify(input.attachments) : null,
      input.createdAt,
    );
    return db
      .prepare(
        `SELECT * FROM worktree_cwd_transition_inputs
         WHERE session_id = ? AND generation = ? AND sequence = ?`,
      )
      .get(
        input.sessionId,
        input.generation,
        next.sequence,
      ) as WorktreeTransitionInputRow;
  })();
  return rowToInput(row);
}

export function listPendingWorktreeTransitionInputsWithDb(
  db: Database.Database,
  sessionId: string,
  generation: number,
): WorktreeTransitionQueuedInput[] {
  return (
    db
      .prepare(
        `SELECT * FROM worktree_cwd_transition_inputs
         WHERE session_id = ? AND generation = ? AND delivered_at IS NULL
         ORDER BY sequence ASC`,
      )
      .all(sessionId, generation) as WorktreeTransitionInputRow[]
  ).map(rowToInput);
}

export function markWorktreeTransitionInputDeliveredWithDb(
  db: Database.Database,
  sessionId: string,
  generation: number,
  sequence: number,
  deliveredAt: number,
): boolean {
  return (
    db
      .prepare(
        `UPDATE worktree_cwd_transition_inputs
         SET delivered_at = ?
         WHERE session_id = ? AND generation = ? AND sequence = ?
           AND delivered_at IS NULL`,
      )
      .run(deliveredAt, sessionId, generation, sequence).changes === 1
  );
}

export function deleteWorktreeTransitionInputsWithDb(
  db: Database.Database,
  sessionId: string,
): void {
  db.prepare(
    `DELETE FROM worktree_cwd_transition_inputs WHERE session_id = ?`,
  ).run(sessionId);
}

export function renameWorktreeTransitionInputsWithDb(
  db: Database.Database,
  fromSessionId: string,
  toSessionId: string,
): void {
  db.prepare(
    `UPDATE worktree_cwd_transition_inputs SET session_id = ?
     WHERE session_id = ?`,
  ).run(toSessionId, fromSessionId);
}

export const worktreeTransitionInputRepo = {
  append(input: Parameters<typeof appendWorktreeTransitionInputWithDb>[1]) {
    return appendWorktreeTransitionInputWithDb(getDb(), input);
  },
  listPending(sessionId: string, generation: number) {
    return listPendingWorktreeTransitionInputsWithDb(
      getDb(),
      sessionId,
      generation,
    );
  },
  markDelivered(
    sessionId: string,
    generation: number,
    sequence: number,
    deliveredAt: number,
  ) {
    return markWorktreeTransitionInputDeliveredWithDb(
      getDb(),
      sessionId,
      generation,
      sequence,
      deliveredAt,
    );
  },
};
