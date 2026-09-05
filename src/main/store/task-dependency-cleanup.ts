import type { Database } from 'better-sqlite3';

/** Snapshot task ids before a session deletion cascades through their owner FK. */
export function listSessionTaskIds(db: Database, sessionId: string): string[] {
  const rows = db.prepare('SELECT id FROM tasks WHERE owner_session_id = ?')
    .all(sessionId) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

function cleanReferences(raw: string, deletedIds: ReadonlySet<string>) {
  try {
    const original: unknown = JSON.parse(raw);
    if (Array.isArray(original) && original.every((id) => typeof id === 'string')) {
      const values = original.filter((id) => !deletedIds.has(id));
      return { values, changed: values.length !== original.length };
    }
  } catch {
    // Repair malformed dependency data just as the task reader treats it: an empty list.
  }
  return { values: [] as string[], changed: true };
}

/**
 * Remove both directions of references to deleted tasks. Call inside the deletion
 * transaction so a failed cleanup also rolls back the deletion. This helper must
 * stay independent of Electron because session retention also runs in Server Core.
 */
export function cleanupBlocksReferences(db: Database, deletedIds: ReadonlySet<string>): void {
  if (deletedIds.size === 0) return;
  const survivors = db.prepare('SELECT id, blocks, blocked_by FROM tasks').all() as Array<{
    id: string;
    blocks: string;
    blocked_by: string;
  }>;
  const update = db.prepare('UPDATE tasks SET blocks = ?, blocked_by = ? WHERE id = ?');
  for (const survivor of survivors) {
    const blocks = cleanReferences(survivor.blocks, deletedIds);
    const blockedBy = cleanReferences(survivor.blocked_by, deletedIds);
    if (blocks.changed || blockedBy.changed) {
      update.run(JSON.stringify(blocks.values), JSON.stringify(blockedBy.values), survivor.id);
    }
  }
}
