import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createTaskRepo, type TaskRepo } from '../task-repo';
import log from 'electron-log/main';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindingAvailable, makeMemoryDb, makeMemoryRepo, insertSession, DEFAULT_SID } from './task-repo.fixture';

describe.skipIf(!bindingAvailable)('task-repo / 基本 CRUD', () => {
  let db: Database.Database;
  let repo: TaskRepo;
  let sid: string;
  beforeEach(() => {
    ({ db, repo, sid } = makeMemoryRepo());
  });
  afterEach(() => db.close());

  it('create 自动填 id / created_at / updated_at / 默认值', () => {
    const t = repo.create({ subject: 'A', ownerSessionId: sid });
    expect(t.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(t.subject).toBe('A');
    expect(t.ownerSessionId).toBe(sid);
    expect(t.status).toBe('pending');
    expect(t.priority).toBe(5);
    expect(t.blocks).toEqual([]);
    expect(t.blockedBy).toEqual([]);
    expect(t.labels).toEqual([]);
    expect(t.description).toBeNull();
    expect(t.activeForm).toBeNull();
    expect(t.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(t.updatedAt).toBe(t.createdAt);
  });

  it('subject 空 / 全空白 → 抛错', () => {
    expect(() => repo.create({ subject: '', ownerSessionId: sid })).toThrow(/subject/);
    expect(() => repo.create({ subject: '   ', ownerSessionId: sid })).toThrow(/subject/);
  });

  it('ownerSessionId 缺失 → 抛错（v023 §不变量 1）', () => {
    expect(() =>
      repo.create({ subject: 'A', ownerSessionId: '' as unknown as string }),
    ).toThrow(/ownerSessionId/);
  });

  it('ownerSessionId 指向不存在的 session → FK 抛错（v023 §不变量 1 兜底）', () => {
    expect(() =>
      repo.create({ subject: 'A', ownerSessionId: 'sess-not-exist' }),
    ).toThrow();
  });

  it('get 找得到 / 找不到', () => {
    const t = repo.create({ subject: 'A', ownerSessionId: sid, priority: 8 });
    const got = repo.get(t.id);
    expect(got?.id).toBe(t.id);
    expect(got?.priority).toBe(8);
    expect(repo.get('nonexistent')).toBeNull();
  });

  it('update 增量改字段 + 强制刷新 updated_at', async () => {
    const t = repo.create({ subject: 'A', ownerSessionId: sid });
    await new Promise((r) => setTimeout(r, 5)); // 确保 ISO timestamp 变化
    const updated = repo.update(t.id, { status: 'completed', priority: 9 });
    expect(updated?.status).toBe('completed');
    expect(updated?.priority).toBe(9);
    expect(updated?.subject).toBe('A'); // 没改的字段保留
    expect(updated && updated.updatedAt > t.updatedAt).toBe(true);
    expect(updated?.createdAt).toBe(t.createdAt); // created_at 不动
  });

  it('update id 不存在 → 返回 null', () => {
    expect(repo.update('nope', { status: 'active' })).toBeNull();
  });

  it('update 显式 null 可清空 description / activeForm', () => {
    const t = repo.create({
      subject: 'A',
      ownerSessionId: sid,
      description: 'd',
      activeForm: 'agent',
    });
    const u = repo.update(t.id, { description: null, activeForm: null });
    expect(u?.description).toBeNull();
    expect(u?.activeForm).toBeNull();
  });

  it('update 主动忽略 patch.ownerSessionId（v023 §不变量 5 + repo 层双保险）', () => {
    insertSession(db, 'sess-other');
    const t = repo.create({ subject: 'A', ownerSessionId: sid });
    // 把 ownerSessionId 改成另一个真实 sid（不会 FK 错），repo 应该静默忽略
    const updated = repo.update(t.id, {
      ownerSessionId: 'sess-other' as never,
      status: 'completed',
    });
    expect(updated?.ownerSessionId).toBe(sid); // 不被改
    expect(updated?.status).toBe('completed'); // 其他字段照改
  });

  it('update subject 不能改成空', () => {
    const t = repo.create({ subject: 'A', ownerSessionId: sid });
    expect(() => repo.update(t.id, { subject: '' })).toThrow(/subject/);
    expect(() => repo.update(t.id, { subject: '  ' })).toThrow(/subject/);
  });

  it('delete 单条', () => {
    const t = repo.create({ subject: 'A', ownerSessionId: sid });
    expect(repo.delete(t.id)).toEqual([t.id]);
    expect(repo.get(t.id)).toBeNull();
    expect(repo.delete(t.id)).toEqual([]); // 第二次返回 []
  });
});

describe.skipIf(!bindingAvailable)('task-repo / list 排序与过滤', () => {
  let db: Database.Database;
  let repo: TaskRepo;
  let sid: string;
  beforeEach(() => {
    ({ db, repo, sid } = makeMemoryRepo());
  });
  afterEach(() => db.close());

  it('默认按 updated_at DESC', async () => {
    const a = repo.create({ subject: 'A', ownerSessionId: sid });
    await new Promise((r) => setTimeout(r, 5));
    const b = repo.create({ subject: 'B', ownerSessionId: sid });
    await new Promise((r) => setTimeout(r, 5));
    const c = repo.create({ subject: 'C', ownerSessionId: sid });
    const list = repo.list();
    expect(list.map((x) => x.id)).toEqual([c.id, b.id, a.id]);
  });

  it('same-ms updated_at tie-breaker：rowid DESC 保 newest-first + 分页无重漏（REVIEW_106 MED）', () => {
    // REVIEW_106 MED（lead 预备 + reviewer-claude + reviewer-codex 三重命中,真 SQLite 实证）:
    // updated_at 用 new Date().toISOString()（ms 精度）,plan workflow 批量建/改 task 易撞
    // 同毫秒。仅 ORDER BY updated_at DESC 对同毫秒簇无 total order — 修前返 rowid-ASC
    // （最旧在前,违背 jsdoc newest-first）。修后 ORDER BY updated_at DESC, rowid DESC。
    //
    // raw SQL 固定 5 行**完全相同** updated_at（绕过 create() 的 new Date() 无法保证同 ms）,
    // rowid 按 insert 顺序 1..5 单调递增。预期 newest-first = rowid DESC = 后插入的排前。
    const SAME_TS = '2026-06-02T10:00:00.000Z';
    const ins = db.prepare(
      `INSERT INTO tasks (id, owner_session_id, team_id, subject, description, status,
        active_form, priority, blocks, blocked_by, labels, created_at, updated_at)
       VALUES (?, ?, NULL, ?, NULL, 'pending', NULL, 5, '[]', '[]', '[]', ?, ?)`,
    );
    // insert 顺序 = rowid 顺序：r1..r5（r5 最后插入 = 最新）
    const ids = ['r1', 'r2', 'r3', 'r4', 'r5'];
    for (const id of ids) ins.run(id, sid, `subj-${id}`, SAME_TS, SAME_TS);

    // 全量：newest-first = rowid DESC = [r5,r4,r3,r2,r1]
    const all = repo.list({ limit: 100 });
    expect(all.map((x) => x.id)).toEqual(['r5', 'r4', 'r3', 'r2', 'r1']);

    // 分页：page1(limit2 offset0) + page2(offset2) + page3(offset4) 拼起来无重漏,
    // 与全量序严格一致（修前同毫秒边界行跨页可能漏/重）。
    const page1 = repo.list({ limit: 2, offset: 0 }).map((x) => x.id);
    const page2 = repo.list({ limit: 2, offset: 2 }).map((x) => x.id);
    const page3 = repo.list({ limit: 2, offset: 4 }).map((x) => x.id);
    expect(page1).toEqual(['r5', 'r4']);
    expect(page2).toEqual(['r3', 'r2']);
    expect(page3).toEqual(['r1']);
    expect([...page1, ...page2, ...page3]).toEqual(['r5', 'r4', 'r3', 'r2', 'r1']);
  });

  it('status 过滤', () => {
    repo.create({ subject: 'A', ownerSessionId: sid, status: 'pending' });
    repo.create({ subject: 'B', ownerSessionId: sid, status: 'active' });
    repo.create({ subject: 'C', ownerSessionId: sid, status: 'active' });
    expect(repo.list({ status: 'active' })).toHaveLength(2);
    expect(repo.list({ status: 'pending' })).toHaveLength(1);
    expect(repo.list({ status: 'completed' })).toHaveLength(0);
  });

  it('subjectKeyword 模糊匹配（case-insensitive）', () => {
    repo.create({ subject: 'Fix login bug', ownerSessionId: sid });
    repo.create({ subject: 'Refactor LOGIN flow', ownerSessionId: sid });
    repo.create({ subject: 'Add cache', ownerSessionId: sid });
    expect(repo.list({ subjectKeyword: 'login' })).toHaveLength(2);
    expect(repo.list({ subjectKeyword: 'LOGIN' })).toHaveLength(2);
    expect(repo.list({ subjectKeyword: 'cache' })).toHaveLength(1);
  });

  it('subjectKeyword LIKE wildcard 字面匹配（REVIEW_61 R1 LOW-β + R2 INFO codex regression）', () => {
    // R1 LOW-β fix: 用户输入 `%` `_` `\` 必须按字面匹配,不再被 SQL LIKE 当 wildcard 解释。
    // 旧实现 `%${keyword}%` 直接拼让 `100%` 等价「任意以 100 开头」;新实现 escape `% _ \\`
    // + ESCAPE '\\' 让 SQL LIKE 把它们当字面字符。
    repo.create({ subject: 'price 100%', ownerSessionId: sid });
    repo.create({ subject: 'price 1000', ownerSessionId: sid });
    repo.create({ subject: 'foo_bar', ownerSessionId: sid });
    repo.create({ subject: 'fooXbar', ownerSessionId: sid });
    repo.create({ subject: 'c:\\path\\foo', ownerSessionId: sid });

    // `%` 字面: 只匹配 `price 100%`,不匹配 `price 1000`
    expect(repo.list({ subjectKeyword: '100%' })).toHaveLength(1);
    expect(repo.list({ subjectKeyword: '100%' })[0].subject).toBe('price 100%');

    // `_` 字面: 只匹配 `foo_bar`,不匹配 `fooXbar`(`_` 旧实现是 SQL 单字符 wildcard)
    expect(repo.list({ subjectKeyword: 'foo_bar' })).toHaveLength(1);
    expect(repo.list({ subjectKeyword: 'foo_bar' })[0].subject).toBe('foo_bar');

    // `\\` 字面: 匹配 Windows 路径
    expect(repo.list({ subjectKeyword: 'c:\\path' })).toHaveLength(1);
    expect(repo.list({ subjectKeyword: 'c:\\path' })[0].subject).toBe('c:\\path\\foo');
  });

  it('ownerSessionIds 三态：不传=全部 / 空数组=0 行 / 非空=IN 过滤', () => {
    insertSession(db, 'sess-X');
    insertSession(db, 'sess-Y');
    repo.create({ subject: 'default-1', ownerSessionId: sid });
    repo.create({ subject: 'default-2', ownerSessionId: sid });
    repo.create({ subject: 'x-1', ownerSessionId: 'sess-X' });
    repo.create({ subject: 'x-2', ownerSessionId: 'sess-X' });
    repo.create({ subject: 'y-1', ownerSessionId: 'sess-Y' });

    // 不传 = 全部
    expect(repo.list()).toHaveLength(5);
    // 空数组 = 0 行（短路）
    expect(repo.list({ ownerSessionIds: [] })).toHaveLength(0);
    // 单 sid IN
    expect(repo.list({ ownerSessionIds: ['sess-X'] })).toHaveLength(2);
    expect(repo.list({ ownerSessionIds: ['sess-Y'] })).toHaveLength(1);
    // 多 sid IN
    expect(repo.list({ ownerSessionIds: ['sess-X', 'sess-Y'] })).toHaveLength(3);
    expect(repo.list({ ownerSessionIds: [sid, 'sess-X', 'sess-Y'] })).toHaveLength(5);
    // 不存在的 sid IN
    expect(repo.list({ ownerSessionIds: ['sess-nonexistent'] })).toHaveLength(0);
  });

  it('limit / offset 分页', () => {
    for (let i = 0; i < 10; i += 1) repo.create({ subject: `t-${i}`, ownerSessionId: sid });
    expect(repo.list({ limit: 3 })).toHaveLength(3);
    expect(repo.list({ limit: 3, offset: 8 })).toHaveLength(2);
    expect(repo.list({ limit: 100 })).toHaveLength(10);
  });

  it('多条件组合：status + ownerSessionIds + subjectKeyword', () => {
    insertSession(db, 'sess-X');
    insertSession(db, 'sess-Y');
    repo.create({ subject: 'foo-A', ownerSessionId: 'sess-X', status: 'active' });
    repo.create({ subject: 'foo-B', ownerSessionId: 'sess-X', status: 'pending' });
    repo.create({ subject: 'foo-C', ownerSessionId: 'sess-Y', status: 'active' });
    expect(
      repo.list({ status: 'active', ownerSessionIds: ['sess-X'], subjectKeyword: 'foo' }),
    ).toHaveLength(1);
  });
});

describe.skipIf(!bindingAvailable)('task-repo / 并发与持久化', () => {
  it('100 条 create 并发：全部入库 + ID 全 unique', async () => {
    const { db, repo, sid } = makeMemoryRepo();
    try {
      // 严格说 better-sqlite3 是同步 API，"并发" 在 Node 单线程里是 microtask 串行；
      // 但仍然验证我们没在 create 里依赖外部异步状态导致竞态。
      const promises = Array.from({ length: 100 }, (_, i) =>
        Promise.resolve().then(() => repo.create({ subject: `t-${i}`, ownerSessionId: sid })),
      );
      const tasks = await Promise.all(promises);
      const ids = new Set(tasks.map((t) => t.id));
      expect(ids.size).toBe(100);
      expect(repo.list({ limit: 200 })).toHaveLength(100);
    } finally {
      db.close();
    }
  });

  it('持久化：写文件 → close → 重新打开 → 数据还在', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'agent-deck-task-repo-'));
    const dbPath = join(tmpDir, 'test.db');
    try {
      const db1 = makeMemoryDb(dbPath);
      insertSession(db1, DEFAULT_SID);
      const repo1 = createTaskRepo(db1);
      const a = repo1.create({ subject: 'persist-me', ownerSessionId: DEFAULT_SID });
      db1.close();

      // 同 dbPath 重新 open：v_meta 已有 schema_version=23，再跑 v001-v023 应短路 / 幂等
      // 但 _setup.makeMemoryDb 无短路逻辑 — 直接重跑会撞 already-exists；改用裸 better-sqlite3
      // open 验证 row 还在
      const db2 = new Database(dbPath);
      const repo2 = createTaskRepo(db2);
      const got = repo2.get(a.id);
      expect(got?.subject).toBe('persist-me');
      expect(got?.ownerSessionId).toBe(DEFAULT_SID);
      db2.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!bindingAvailable)('task-repo / 损坏数据容错', () => {
  // _deps.ts:23 用 `log.scope('task-repo-deps')`，其 .warn 在 vitest-setup electron-log/main
  // mock 下是按 scope name 缓存的 vi.fn。scope name 必须与 _deps.ts **完全一致** `'task-repo-deps'`，
  // typo 成别名 → 拿到另一 cache 实例 → toHaveBeenCalled 永远 false 假绿（plan D5）。
  it('blocks / blocked_by / labels 列里写脏 JSON：rowToRecord 退化空数组 + warn', () => {
    const { db, repo, sid } = makeMemoryRepo();
    const warnSpy = log.scope('task-repo-deps').warn as ReturnType<typeof vi.fn>;
    warnSpy.mockClear();
    try {
      const t = repo.create({ subject: 'A', ownerSessionId: sid });
      // 直接用 SQL 写入坏数据，绕过 repo 的 JSON.stringify
      db.prepare(`UPDATE tasks SET blocks = ?, labels = ? WHERE id = ?`).run(
        'not-json',
        '{"key": "not-array"}',
        t.id,
      );
      const got = repo.get(t.id);
      expect(got?.blocks).toEqual([]);
      expect(got?.labels).toEqual([]);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it('blocks 数组里有非 string 元素：退化空数组 + warn', () => {
    const { db, repo, sid } = makeMemoryRepo();
    const warnSpy = log.scope('task-repo-deps').warn as ReturnType<typeof vi.fn>;
    warnSpy.mockClear();
    try {
      const t = repo.create({ subject: 'A', ownerSessionId: sid });
      db.prepare(`UPDATE tasks SET blocks = ? WHERE id = ?`).run('[1, 2, 3]', t.id);
      const got = repo.get(t.id);
      expect(got?.blocks).toEqual([]);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      db.close();
    }
  });
});
