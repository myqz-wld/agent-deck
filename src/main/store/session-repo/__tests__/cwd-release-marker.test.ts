/**
 * session-repo cwd_release_marker 真 SQLite 单测（plan
 * codex-handoff-team-alignment-20260518 P1 Step 1.5）。
 *
 * 范围:
 * - TC1: upsert 写 cwd_release_marker / setCwdReleaseMarker / clearCwdReleaseMarker /
 *   rowToRecord 投影 cwdReleaseMarker 字段
 * - TC2: migration v020 idempotent (重复 exec v020 ALTER TABLE ADD COLUMN 第二次撞 dup
 *   column 抛错,验证一次 exec 后列存在即可 — 业务上 migration runner 不会重复跑同 version)
 * - TC2b: rename(fromId, toId) 后 cwd_release_marker 跟到 toId
 *   (toExists=false 走 INSERT 20 列分支 + toExists=true 走 UPDATE 覆盖块两条路径 — H1 关键修法)
 *
 * 走真 SQLite + 全 v001-v020 migration 真路径(测试 fixture _setup.ts)。
 * binding 不可用时全跳过(与 task-repo / team-repo 测试同款守门)。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { bindingAvailable, makeMemoryDb } from './_setup';
import { renameWithDb } from '../rename';

// vi.mock 必须放 import 之前;hoisted 工厂返动态读 currentDb 让 beforeEach 切换。
let currentDb: Database.Database | null = null;
vi.mock('../../db', () => ({
  getDb: () => {
    if (!currentDb) throw new Error('[cwd-release-marker.test] currentDb not initialized; beforeEach 未跑');
    return currentDb;
  },
}));

// import 在 vi.mock 之后(vi.mock 是 hoisted,但 import 在 vi.mock 调用前就被求值会拿到 mocked getDb)。
// session-repo 内部用 getDb() 在 setter / upsert 调用时才求值,因此 import 顺序 OK。
import { sessionRepo } from '../index';
import * as coreCrud from '../core-crud';

function insertActiveSession(db: Database.Database, id: string, cwd = '/Users/test/repo'): void {
  db.prepare(
    `INSERT INTO sessions
     (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at)
     VALUES (?, 'claude-code', ?, ?, 'sdk', 'active', 'idle', ?, ?)`,
  ).run(id, cwd, `title-${id}`, 1000, 1000);
}

describe.skipIf(!bindingAvailable)('session-repo / cwd_release_marker (plan P1 Step 1.5)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeMemoryDb();
    currentDb = db;
  });
  afterEach(() => {
    currentDb = null;
    db.close();
  });

  // ─── TC1: setter / clearer / rowToRecord 投影 ───────────────────────────
  it('TC1a: setCwdReleaseMarker 写入 + sessionRepo.get 读回 cwdReleaseMarker', () => {
    insertActiveSession(db, 'sid-A');
    expect(sessionRepo.get('sid-A')?.cwdReleaseMarker).toBeNull(); // 初始 null

    coreCrud.setCwdReleaseMarker('sid-A', '/Users/test/repo/.claude/worktrees/plan1');
    expect(sessionRepo.get('sid-A')?.cwdReleaseMarker).toBe('/Users/test/repo/.claude/worktrees/plan1');
  });

  it('TC1b: clearCwdReleaseMarker (= setCwdReleaseMarker null) 清回 null', () => {
    insertActiveSession(db, 'sid-A');
    coreCrud.setCwdReleaseMarker('sid-A', '/some/wt');
    expect(sessionRepo.get('sid-A')?.cwdReleaseMarker).toBe('/some/wt');

    coreCrud.clearCwdReleaseMarker('sid-A');
    expect(sessionRepo.get('sid-A')?.cwdReleaseMarker).toBeNull();
  });

  it('TC1c: upsert 写入 cwdReleaseMarker 字段(lifecycle 复活路径不丢字段)', () => {
    insertActiveSession(db, 'sid-A');
    coreCrud.setCwdReleaseMarker('sid-A', '/before/upsert/wt');
    const existing = sessionRepo.get('sid-A');
    expect(existing).toBeDefined();
    if (!existing) return;

    // 模拟 lifecycle 复活 spread upsert(典型 SessionManager 路径):
    // `{...existing, lifecycle:'active'}` spread 时,如 upsert ON CONFLICT 不含 cwd_release_marker
    // 字段会静默丢字段(与 v018 model latent bug 同款风险)。验证 upsert 含此字段。
    coreCrud.upsert({ ...existing, lifecycle: 'active' });
    expect(sessionRepo.get('sid-A')?.cwdReleaseMarker).toBe('/before/upsert/wt'); // 不被淹没
  });

  // ─── TC2: migration v020 列存在 ─────────────────────────────────────────
  it('TC2: migration v020 后 sessions.cwd_release_marker 列存在 + DEFAULT NULL', () => {
    const cols = db.prepare('PRAGMA table_info(sessions)').all() as Array<{
      name: string;
      type: string;
      dflt_value: string | null;
    }>;
    const marker = cols.find((c) => c.name === 'cwd_release_marker');
    expect(marker).toBeDefined();
    expect(marker?.type).toBe('TEXT');
    expect(marker?.dflt_value).toBe('NULL');
  });

  // ─── TC2b: rename(fromId, toId) 后 cwdReleaseMarker 跟到 toId (H1 关键修法) ─
  it('TC2b: rename toExists=false (INSERT 20 列分支) → cwdReleaseMarker 跟到 toId', () => {
    insertActiveSession(db, 'sid-OLD');
    coreCrud.setCwdReleaseMarker('sid-OLD', '/wt/path1');
    expect(sessionRepo.get('sid-OLD')?.cwdReleaseMarker).toBe('/wt/path1');
    expect(sessionRepo.get('sid-NEW')).toBeNull(); // NEW 不存在 → 走 INSERT 分支

    renameWithDb(db, 'sid-OLD', 'sid-NEW');

    expect(sessionRepo.get('sid-OLD')).toBeNull(); // OLD 被 DELETE
    const newRow = sessionRepo.get('sid-NEW');
    expect(newRow).toBeDefined();
    expect(newRow?.cwdReleaseMarker).toBe('/wt/path1'); // marker 跟到 NEW
  });

  it('TC2b 反向: rename toExists=true (UPDATE 覆盖块分支) → cwdReleaseMarker 从 fromRow 覆盖到 toRow', () => {
    insertActiveSession(db, 'sid-OLD');
    insertActiveSession(db, 'sid-NEW'); // NEW 预先存在 → 走 UPDATE 覆盖块分支
    coreCrud.setCwdReleaseMarker('sid-OLD', '/wt/old-path');
    // NEW 没 setMarker → cwd_release_marker 为 NULL
    expect(sessionRepo.get('sid-NEW')?.cwdReleaseMarker).toBeNull();

    renameWithDb(db, 'sid-OLD', 'sid-NEW');

    expect(sessionRepo.get('sid-OLD')).toBeNull(); // OLD 被 DELETE
    const newRow = sessionRepo.get('sid-NEW');
    expect(newRow).toBeDefined();
    expect(newRow?.cwdReleaseMarker).toBe('/wt/old-path'); // marker 从 OLD 覆盖到 NEW
  });

  it('TC2b 边角: fromRow.cwd_release_marker 为 null 时 toExists=true 不撞 SQL 错', () => {
    insertActiveSession(db, 'sid-OLD'); // marker = null
    insertActiveSession(db, 'sid-NEW');
    coreCrud.setCwdReleaseMarker('sid-NEW', '/existing/wt'); // NEW 已有 marker
    // OLD 没 marker → rename 时 if (toExists && fromRow.cwd_release_marker) 分支跳过,
    // 不应覆盖 NEW 已有 marker。
    expect(sessionRepo.get('sid-OLD')?.cwdReleaseMarker).toBeNull();

    renameWithDb(db, 'sid-OLD', 'sid-NEW');

    expect(sessionRepo.get('sid-OLD')).toBeNull();
    // NEW 已有 marker 不被 OLD null 淹没
    expect(sessionRepo.get('sid-NEW')?.cwdReleaseMarker).toBe('/existing/wt');
  });
});
