import { getDb } from '../db';

/** Promote only a proven owner-created work root; preserve its actual delegated descendants. */
export function promoteIndependentWork(id: string, expectedParent: string): readonly string[] {
  const db = getDb();
  return db.transaction(() => {
    const root = db.prepare('SELECT spawned_by AS parent, spawn_depth AS depth FROM sessions WHERE id = ?')
      .get(id) as { parent: string | null; depth: number } | undefined;
    if (!root) throw new Error('Owner work session is missing');
    if (root.parent === null && root.depth === 0) return [];
    if (root.parent !== expectedParent || root.depth <= 0) {
      throw new Error('Owner work creation edge changed');
    }
    const rows = db.prepare(`WITH RECURSIVE descendants(id) AS (
      SELECT ? UNION SELECT child.id FROM sessions child JOIN descendants d ON child.spawned_by = d.id
    ) SELECT s.id, s.spawn_depth AS depth, parent.spawn_depth AS parentDepth
      FROM descendants d JOIN sessions s ON s.id = d.id
      LEFT JOIN sessions parent ON parent.id = s.spawned_by`).all(id) as
      Array<{ id: string; depth: number; parentDepth: number | null }>;
    if (rows.some(row => row.depth < root.depth ||
      (row.id !== id && row.depth !== (row.parentDepth ?? -1) + 1))) {
      throw new Error('Owner work subtree has inconsistent spawn depths');
    }
    const update = db.prepare(`UPDATE sessions SET spawn_depth = spawn_depth - ?,
      spawned_by = CASE WHEN id = ? THEN NULL ELSE spawned_by END WHERE id = ?`);
    for (const row of rows) update.run(root.depth, id, row.id);
    return rows.map(row => row.id);
  })();
}
