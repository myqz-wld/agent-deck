/**
 * v030 migration 单测（plan message-retention-and-index-20260602）— agent_deck_messages 索引补全。
 *
 * v030 纯加 3 索引（不动表结构）：
 *   - idx_messages_from_session_sent_at(from_session_id, sent_at DESC)  — listBySession UNION ALL 第一分支
 *   - idx_messages_to_session_sent_at(to_session_id, sent_at DESC)      — listBySession UNION ALL 第二分支
 *   - idx_messages_terminal_sent_at(sent_at) WHERE status IN (terminal) — GC partial index
 *
 * 验：
 *   - 3 索引全在（PRAGMA index_list / sqlite_master）
 *   - partial index 的 WHERE 定义**字面正确**（不只验 index name——Deep-Review R2 codex MED：
 *     gc.ts literal 必须与本 WHERE 同序同值才命中，验 sqlite_master.sql 锁死 schema 侧字面）
 *   - GC EXPLAIN 走 partial index（无 SCAN / 无 TEMP B-TREE）— 见 agent-deck-message-repo.test.ts
 *     GC describe（跑 gc.ts LIST_EXPIRED_FOR_GC_SQL 真常量）。本文件聚焦 schema 侧。
 *
 * 走 _setup.ts makeMemoryDb（已含 v001..v030 全量 migration）。binding 守门 skip。
 */
import { describe, expect, it, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { bindingAvailable, makeMemoryDb } from './agent-deck-repos/_setup';

describe.skipIf(!bindingAvailable)('v030 migration — agent_deck_messages indexes', () => {
  let db: Database.Database;
  afterEach(() => db?.close());

  it('3 个新索引全部建成', () => {
    db = makeMemoryDb();
    const names = (
      db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'index' AND tbl_name = 'agent_deck_messages'
             AND name IN ('idx_messages_from_session_sent_at',
                          'idx_messages_to_session_sent_at',
                          'idx_messages_terminal_sent_at')
           ORDER BY name`,
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(names).toEqual([
      'idx_messages_from_session_sent_at',
      'idx_messages_terminal_sent_at',
      'idx_messages_to_session_sent_at',
    ]);
  });

  it('partial index idx_messages_terminal_sent_at WHERE 字面正确（status IN 同序同值，锁 gc.ts literal 匹配）', () => {
    db = makeMemoryDb();
    const sql = (
      db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_messages_terminal_sent_at'`)
        .get() as { sql: string }
    ).sql;
    // 验 ON column 是 sent_at（不是 status-first 复合——R1 codex HIGH-1）
    expect(sql).toContain('(sent_at)');
    // 验 partial WHERE 字面同序同值（gc.ts LIST_EXPIRED_FOR_GC_SQL 必须 byte-match 此 WHERE 才命中）
    expect(sql).toContain("WHERE status IN ('delivered', 'failed', 'cancelled')");
  });

  it('listBySession 双索引是 (session, sent_at DESC) 复合（非单列）', () => {
    db = makeMemoryDb();
    const fromSql = (
      db.prepare(`SELECT sql FROM sqlite_master WHERE name='idx_messages_from_session_sent_at'`).get() as { sql: string }
    ).sql;
    const toSql = (
      db.prepare(`SELECT sql FROM sqlite_master WHERE name='idx_messages_to_session_sent_at'`).get() as { sql: string }
    ).sql;
    expect(fromSql).toContain('from_session_id');
    expect(fromSql).toContain('sent_at DESC');
    expect(toSql).toContain('to_session_id');
    expect(toSql).toContain('sent_at DESC');
  });

  it('listBySession UNION ALL EXPLAIN 走双索引 SEARCH，无全表 SCAN', () => {
    db = makeMemoryDb();
    // 复刻 crud.ts listBySession（无 status 分支）UNION ALL SQL 的 EXPLAIN
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT id, team_id, from_session_id, to_session_id, body, status, status_reason,
                sent_at, delivered_at, attempt_count, last_attempt_at, delivering_since,
                reply_to_message_id
         FROM (
           SELECT *, rowid AS _rid FROM agent_deck_messages WHERE from_session_id = ?
           UNION ALL
           SELECT *, rowid AS _rid FROM agent_deck_messages
             WHERE to_session_id = ? AND from_session_id <> ?
         )
         ORDER BY sent_at DESC, _rid DESC LIMIT ? OFFSET ?`,
      )
      .all('sX', 'sX', 'sX', 100, 0) as { detail: string }[];
    const detail = plan.map((r) => r.detail).join(' | ');
    // 无全表 SCAN（宽松否定式——形态依投影/SQLite 版本变，不钉精确 plan 树，Deep-Review R2 claude LOW）
    expect(detail).not.toContain('SCAN agent_deck_messages');
    // 两分支各走一索引
    expect(detail).toContain('idx_messages_from_session_sent_at');
    expect(detail).toContain('idx_messages_to_session_sent_at');
  });

  it('listBySession status-filter 分支 EXPLAIN 也走双索引 SEARCH，无全表 SCAN（impl-review codex INFO）', () => {
    db = makeMemoryDb();
    // 复刻 crud.ts listBySession 的 status-filter 分支 UNION ALL SQL EXPLAIN（参数顺序：
    // from, status, to, from, status——与 crud.ts 一致）。status 分支也是双 session 索引，
    // 加 EXPLAIN 回归锁性能契约防未来 SQL 改坏（codex 实测确认当前走双索引，但原测试仅锁无 status 分支）。
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT id, team_id, from_session_id, to_session_id, body, status, status_reason,
                sent_at, delivered_at, attempt_count, last_attempt_at, delivering_since,
                reply_to_message_id
         FROM (
           SELECT *, rowid AS _rid FROM agent_deck_messages
             WHERE from_session_id = ? AND status = ?
           UNION ALL
           SELECT *, rowid AS _rid FROM agent_deck_messages
             WHERE to_session_id = ? AND from_session_id <> ? AND status = ?
         )
         ORDER BY sent_at DESC, _rid DESC LIMIT ? OFFSET ?`,
      )
      .all('sX', 'delivered', 'sX', 'sX', 'delivered', 100, 0) as { detail: string }[];
    const detail = plan.map((r) => r.detail).join(' | ');
    expect(detail).not.toContain('SCAN agent_deck_messages');
    expect(detail).toContain('idx_messages_from_session_sent_at');
    expect(detail).toContain('idx_messages_to_session_sent_at');
  });
});
