/**
 * Task Manager 持久层 smoke test（plan task-mcp-owner-session-id-rewrite-20260521 v023 重写）。
 *
 * v007 schema 已被 v023 DROP + CREATE 替换为 owner_session_id NOT NULL FK → sessions(id)
 * ON DELETE CASCADE 模型。所有 create 调用必须传 ownerSessionId，repo 层无 teamName /
 * teamId 字段。team scope 留给 tool 层 reverse join 算（详 task-repo.ts §plan §D6）。
 *
 * 复用 agent-deck-repos/_setup（已含 v001-v023 完整 migration loader + insertSession
 * helper）—— task-repo v023 起也是 sessions FK 子表，与 agent_deck_team_members /
 * agent_deck_messages 同款依赖，应共享同款 fixture。
 *
 * 关键测试维度：
 * - 基本 CRUD / 自动字段填充 / subject 校验
 * - update 后 updated_at 单调递增 + patch.ownerSessionId 被静默忽略（v023 §不变量 5）
 * - list 默认按 updated_at DESC
 * - status / subjectKeyword / ownerSessionIds 三类过滤（ownerSessionIds 三态：
 *   不传=全部 / 空数组=0 行 / 非空数组=IN 过滤）
 * - cascade=true 级联删 blocks 下游 + 清反向引用
 * - cascade=false 仅断引用（保留下游 task）
 * - cascade predicate 签名改用 (id, ownerSessionId) — 配合 tool 层写权限校验
 * - reassignOwner 单 SQL 改 owner（v023 §D3 hand_off 过继）
 * - sessions ON DELETE CASCADE 删 session 时 task 自动删（v023 §不变量 2 + §D4 GC）
 * - 100 条并发 create 全部入库 + ID unique
 * - 持久化：写到 tmp 文件 → 重新打开 → 数据还在
 * - 损坏 JSON 字段（人工写脏 blocks 列）容错：rowToRecord 退化空数组 + warn
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTaskRepo, type TaskRepo } from '../task-repo';
import { bindingAvailable, makeMemoryDb, insertSession } from './agent-deck-repos/_setup';

/**
 * 内置 default session id `sess-default`，所有「不关心 owner 是谁」的用例都用它。
 * 需要测多 owner / cross-owner 场景时单独 insertSession 拿新 sid。
 */
const DEFAULT_SID = 'sess-default';

function makeMemoryRepo(): { db: Database.Database; repo: TaskRepo; sid: string } {
  const db = makeMemoryDb();
  insertSession(db, DEFAULT_SID);
  return { db, repo: createTaskRepo(db), sid: DEFAULT_SID };
}

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

describe.skipIf(!bindingAvailable)('task-repo / cascade delete', () => {
  let db: Database.Database;
  let repo: TaskRepo;
  let sid: string;
  beforeEach(() => {
    ({ db, repo, sid } = makeMemoryRepo());
  });
  afterEach(() => db.close());

  it('cascade=true 级联删 blocks 下游', () => {
    const c = repo.create({ subject: 'C', ownerSessionId: sid });
    const b = repo.create({ subject: 'B', ownerSessionId: sid, blocks: [c.id] });
    const a = repo.create({ subject: 'A', ownerSessionId: sid, blocks: [b.id] });
    const deleted = repo.delete(a.id, { cascade: true });
    expect(new Set(deleted)).toEqual(new Set([a.id, b.id, c.id]));
    expect(repo.get(a.id)).toBeNull();
    expect(repo.get(b.id)).toBeNull();
    expect(repo.get(c.id)).toBeNull();
  });

  it('cascade=false 仅断引用：下游 task 保留 + 反向引用清理', () => {
    const b = repo.create({ subject: 'B', ownerSessionId: sid });
    const a = repo.create({
      subject: 'A',
      ownerSessionId: sid,
      blocks: [b.id],
      blockedBy: [],
    });
    repo.update(b.id, { blockedBy: [a.id] });
    expect(repo.delete(a.id)).toEqual([a.id]);
    const survivor = repo.get(b.id);
    expect(survivor).not.toBeNull();
    expect(survivor?.blockedBy).toEqual([]); // a 被删，b.blockedBy 清掉对 a 的引用
  });

  it('cascade=true 防自循环：cascade 链路里有环不会死循环', () => {
    const b = repo.create({ subject: 'B', ownerSessionId: sid });
    const a = repo.create({ subject: 'A', ownerSessionId: sid, blocks: [b.id] });
    // 人工制造循环依赖（store 不做循环检测，但 cascade 内必须挡住死循环）
    repo.update(b.id, { blocks: [a.id] });
    expect(() => repo.delete(a.id, { cascade: true })).not.toThrow();
    expect(repo.get(a.id)).toBeNull();
    expect(repo.get(b.id)).toBeNull();
  });

  it('删除不存在的 id 返回空数组', () => {
    expect(repo.delete('nope')).toEqual([]);
  });

  it('级联删后清理多条 task 的反向引用', () => {
    const target = repo.create({ subject: 'target', ownerSessionId: sid });
    const ref1 = repo.create({ subject: 'ref1', ownerSessionId: sid, blocks: [target.id] });
    const ref2 = repo.create({ subject: 'ref2', ownerSessionId: sid, blockedBy: [target.id] });
    repo.delete(target.id);
    expect(repo.get(ref1.id)?.blocks).toEqual([]);
    expect(repo.get(ref2.id)?.blockedBy).toEqual([]);
  });

  it('F6 (deep-review Round 1 LOW-1):脏 JSON survivor 不让 delete cleanup 整 tx 回滚', () => {
    // 触发 bug 场景:survivor task 有脏 JSON 的 blocks / blocked_by,删除另一无关 task
    // 走 cleanup 路径调裸 JSON.parse(s.blocks)/JSON.parse(s.blocked_by) → 修前抛错让
    // outer transaction 回滚,target 都没删成。修后 try/catch 兜底 + 标 changed=true
    // 让 cleanup 写回 clean JSON,target 正常删 + survivor 脏 JSON 被清。
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const dirty = repo.create({ subject: 'dirty-survivor', ownerSessionId: sid });
      const target = repo.create({ subject: 'target-to-delete', ownerSessionId: sid });
      // 人工把 dirty 的 blocks 列写成坏 JSON,绕过 repo.create JSON.stringify
      db.prepare(`UPDATE tasks SET blocks = ? WHERE id = ?`).run('not-json{{', dirty.id);

      // 删 target — cleanup 阶段会扫所有 survivors,包括 dirty
      // 修前:dirty 的裸 JSON.parse 抛错 → tx 回滚 → target 没删成
      // 修后:不抛错,target 删成 + dirty.blocks 被清成 '[]'
      expect(() => repo.delete(target.id)).not.toThrow();
      expect(repo.get(target.id)).toBeNull(); // target 真删了

      // dirty.blocks 被 cleanup 写回 clean(safeJsonArray 退化空数组 + cleanStmt 写回)
      const dirtyAfter = repo.get(dirty.id);
      expect(dirtyAfter).not.toBeNull(); // dirty 自身没删(只是 cleanup 顺手清了它的脏 JSON)
      expect(dirtyAfter?.blocks).toEqual([]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('v023 §D2：cascade 带 predicate 时跨 owner child 被跳过（不删 + 不展开下游）', () => {
    insertSession(db, 'sess-X');
    insertSession(db, 'sess-Y');
    // chain: A(sess-X) → B(sess-Y) → C(sess-Y)。删 A 时 predicate 只让 sess-X 通过，
    // B 应被跳过（保留），C 也不应被删（链路在 B 处中断）。
    const c = repo.create({ subject: 'C', ownerSessionId: 'sess-Y' });
    const b = repo.create({ subject: 'B', ownerSessionId: 'sess-Y', blocks: [c.id] });
    const a = repo.create({ subject: 'A', ownerSessionId: 'sess-X', blocks: [b.id] });
    expect(
      repo.delete(a.id, { cascade: true, predicate: (_, owner) => owner === 'sess-X' }),
    ).toEqual([a.id]);
    expect(repo.get(a.id)).toBeNull(); // self 总会被删（predicate 不挡 root）
    expect(repo.get(b.id)).not.toBeNull(); // cross-owner 跳过
    expect(repo.get(c.id)).not.toBeNull(); // 链路中断，下游也保留
  });

  it('v023 §D2：cascade predicate 通过的 child 才进 toDelete + 继续展开', () => {
    insertSession(db, 'sess-X');
    insertSession(db, 'sess-Y');
    // chain: A(sess-X) → B(sess-X) → C(sess-Y) → D(sess-X)。删 A，predicate 只让 sess-X 通过。
    // 期望：A 删 + B 删，C 跳过（不删），D 因链路在 C 处断也保留。
    const d = repo.create({ subject: 'D', ownerSessionId: 'sess-X' });
    const c = repo.create({ subject: 'C', ownerSessionId: 'sess-Y', blocks: [d.id] });
    const b = repo.create({ subject: 'B', ownerSessionId: 'sess-X', blocks: [c.id] });
    const a = repo.create({ subject: 'A', ownerSessionId: 'sess-X', blocks: [b.id] });
    repo.delete(a.id, { cascade: true, predicate: (_, owner) => owner === 'sess-X' });
    expect(repo.get(a.id)).toBeNull();
    expect(repo.get(b.id)).toBeNull();
    expect(repo.get(c.id)).not.toBeNull();
    expect(repo.get(d.id)).not.toBeNull();
  });
});

describe.skipIf(!bindingAvailable)('task-repo / reassignOwner (v023 §D3 hand_off 过继)', () => {
  let db: Database.Database;
  let repo: TaskRepo;
  let sid: string;
  beforeEach(() => {
    ({ db, repo, sid } = makeMemoryRepo());
  });
  afterEach(() => db.close());

  it('单 SQL 改 owner_session_id 把 oldSid 拥有的所有 task 转给 newSid', () => {
    insertSession(db, 'sess-new');
    const t1 = repo.create({ subject: 'T1', ownerSessionId: sid });
    const t2 = repo.create({ subject: 'T2', ownerSessionId: sid });
    const t3 = repo.create({ subject: 'T3', ownerSessionId: sid });

    const changed = repo.reassignOwner(sid, 'sess-new');

    expect(changed).toBe(3);
    expect(repo.get(t1.id)?.ownerSessionId).toBe('sess-new');
    expect(repo.get(t2.id)?.ownerSessionId).toBe('sess-new');
    expect(repo.get(t3.id)?.ownerSessionId).toBe('sess-new');
  });

  it('oldSid 没拥有任何 task → 返回 0', () => {
    insertSession(db, 'sess-new');
    insertSession(db, 'sess-empty');
    expect(repo.reassignOwner('sess-empty', 'sess-new')).toBe(0);
  });

  it('只过继 oldSid 拥有的 task，其他 owner 的 task 不动', () => {
    insertSession(db, 'sess-other');
    insertSession(db, 'sess-new');
    const own = repo.create({ subject: 'mine', ownerSessionId: sid });
    const other = repo.create({ subject: 'other', ownerSessionId: 'sess-other' });

    const changed = repo.reassignOwner(sid, 'sess-new');

    expect(changed).toBe(1);
    expect(repo.get(own.id)?.ownerSessionId).toBe('sess-new');
    expect(repo.get(other.id)?.ownerSessionId).toBe('sess-other'); // 不动
  });

  it('reassignOwner 不刷新 updated_at(F5 deep-review Round 1 修法)', async () => {
    insertSession(db, 'sess-new');
    const t = repo.create({ subject: 'T', ownerSessionId: sid });
    const before = t.updatedAt;
    await new Promise((r) => setTimeout(r, 5));

    repo.reassignOwner(sid, 'sess-new');

    const after = repo.get(t.id);
    // F5 修法:reassignOwner 不刷新 updated_at(详 task-repo.ts reassignOwner 注释)。
    // task content 没变,只换 owner,不算用户「修改」task → 保留原 updated_at 让 list
    // 默认 ORDER BY updated_at DESC 排序保持稳定(修前刷 updated_at 让 hand_off baton
    // 后所有过继 task 全部浮顶 UI stale)。
    expect(after?.updatedAt).toBe(before);
    expect(after?.ownerSessionId).toBe('sess-new'); // owner 已换
  });

  it('newSid 不存在 → FK 抛错（caller 保证 newSid 已落 DB；plan §已知踩坑 2）', () => {
    repo.create({ subject: 'T', ownerSessionId: sid });
    expect(() => repo.reassignOwner(sid, 'sess-not-exist')).toThrow();
  });
});

describe.skipIf(!bindingAvailable)('task-repo / sessions ON DELETE CASCADE (v023 §不变量 2 + §D4 GC)', () => {
  let db: Database.Database;
  let repo: TaskRepo;
  let sid: string;
  beforeEach(() => {
    ({ db, repo, sid } = makeMemoryRepo());
  });
  afterEach(() => db.close());

  it('删 sessions row → owner=sid 的 task 全部 CASCADE 删（GC 路径）', () => {
    insertSession(db, 'sess-other');
    const t1 = repo.create({ subject: 'T1', ownerSessionId: sid });
    const t2 = repo.create({ subject: 'T2', ownerSessionId: sid });
    const other = repo.create({ subject: 'other', ownerSessionId: 'sess-other' });

    db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sid);

    expect(repo.get(t1.id)).toBeNull(); // CASCADE 删
    expect(repo.get(t2.id)).toBeNull(); // CASCADE 删
    expect(repo.get(other.id)).not.toBeNull(); // other owner 不动
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
  it('blocks / blocked_by / labels 列里写脏 JSON：rowToRecord 退化空数组 + warn', () => {
    const { db, repo, sid } = makeMemoryRepo();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
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
      warnSpy.mockRestore();
      db.close();
    }
  });

  it('blocks 数组里有非 string 元素：退化空数组 + warn', () => {
    const { db, repo, sid } = makeMemoryRepo();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const t = repo.create({ subject: 'A', ownerSessionId: sid });
      db.prepare(`UPDATE tasks SET blocks = ? WHERE id = ?`).run('[1, 2, 3]', t.id);
      const got = repo.get(t.id);
      expect(got?.blocks).toEqual([]);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      db.close();
    }
  });
});
