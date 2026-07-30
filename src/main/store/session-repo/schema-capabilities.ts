import type BetterSqlite3 from 'better-sqlite3';

/**
 * Session-repo migration tests intentionally exercise predecessor schemas.
 * Keep lifecycle cleanup compatible until v059 has installed both transition
 * tables; production startup still migrates the database before repositories
 * are used.
 */
export function hasWorktreeTransitionSchema(
  db: BetterSqlite3.Database,
): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM sqlite_master
       WHERE type = 'table'
         AND name IN (
           'worktree_cwd_transitions',
           'worktree_cwd_transition_inputs'
         )`,
    )
    .get() as { count: number };
  return row.count === 2;
}
