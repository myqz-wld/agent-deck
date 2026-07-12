import type { Database } from 'better-sqlite3';

const DEFAULT_AUTO_CHECKPOINT_PAGES = 1_000;

/** Exception-atomic ownership transfer for the main connection's WAL autocheckpoint hook. */
export class MainWalCheckpointLease {
  private priorPages: number | null = null;

  acquire(db: Database): void {
    if (this.priorPages !== null) return;
    const configured = Number(db.pragma('wal_autocheckpoint', { simple: true }));
    const prior = Number.isInteger(configured) && configured > 0
      ? configured
      : DEFAULT_AUTO_CHECKPOINT_PAGES;
    // Record rollback state before mutating SQLite. A failed readback must still be recoverable.
    this.priorPages = prior;
    try {
      db.pragma('wal_autocheckpoint = 0');
      const actual = Number(db.pragma('wal_autocheckpoint', { simple: true }));
      if (actual !== 0) {
        throw new Error(`failed to disable main WAL autocheckpoint (actual=${actual})`);
      }
    } catch (cause) {
      try {
        db.pragma(`wal_autocheckpoint = ${prior}`);
        this.priorPages = null;
      } catch (rollbackCause) {
        throw new Error(
          `main WAL checkpoint lease failed and rollback failed: ` +
            `${messageOf(cause)}; rollback=${messageOf(rollbackCause)}`,
        );
      }
      throw cause;
    }
  }

  release(db: Database): void {
    if (this.priorPages === null) return;
    const restore = this.priorPages;
    // Retain priorPages when SQLite rejects the restore so a later lifecycle path can retry it.
    db.pragma(`wal_autocheckpoint = ${restore}`);
    this.priorPages = null;
  }

  get active(): boolean {
    return this.priorPages !== null;
  }
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
