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
import log from 'electron-log/main';
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
    // v024 plan §不变量 12 + Step B1 HIGH-2 修法:predicate 签名改 (id, child: Pick<TaskRecord,
    // 'ownerSessionId' | 'teamId'>) — 拿 child 完整 task 让 isCallerAuthorizedToWrite 按 team_id 判。
    const c = repo.create({ subject: 'C', ownerSessionId: 'sess-Y' });
    const b = repo.create({ subject: 'B', ownerSessionId: 'sess-Y', blocks: [c.id] });
    const a = repo.create({ subject: 'A', ownerSessionId: 'sess-X', blocks: [b.id] });
    expect(
      repo.delete(a.id, {
        cascade: true,
        predicate: (_, child) => child.ownerSessionId === 'sess-X',
      }),
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
    // v024 HIGH-2 修法:同款 (id, child) predicate 签名。
    const d = repo.create({ subject: 'D', ownerSessionId: 'sess-X' });
    const c = repo.create({ subject: 'C', ownerSessionId: 'sess-Y', blocks: [d.id] });
    const b = repo.create({ subject: 'B', ownerSessionId: 'sess-X', blocks: [c.id] });
    const a = repo.create({ subject: 'A', ownerSessionId: 'sess-X', blocks: [b.id] });
    repo.delete(a.id, {
      cascade: true,
      predicate: (_, child) => child.ownerSessionId === 'sess-X',
    });
    expect(repo.get(a.id)).toBeNull();
    expect(repo.get(b.id)).toBeNull();
    expect(repo.get(c.id)).not.toBeNull();
    expect(repo.get(d.id)).not.toBeNull();
  });
});

describe.skipIf(!bindingAvailable)('task-repo / reassignOwner (v023 §D3 hand_off 过继 + v024 §D4 policy 两态)', () => {
  let db: Database.Database;
  let repo: TaskRepo;
  let sid: string;
  beforeEach(() => {
    ({ db, repo, sid } = makeMemoryRepo());
  });
  afterEach(() => db.close());

  it('单 SQL 改 owner_session_id 把 oldSid 拥有的所有 task 转给 newSid（policy clear-team）', () => {
    insertSession(db, 'sess-new');
    const t1 = repo.create({ subject: 'T1', ownerSessionId: sid });
    const t2 = repo.create({ subject: 'T2', ownerSessionId: sid });
    const t3 = repo.create({ subject: 'T3', ownerSessionId: sid });

    const changed = repo.reassignOwner(sid, 'sess-new', { policy: 'clear-team' });

    expect(changed).toBe(3);
    expect(repo.get(t1.id)?.ownerSessionId).toBe('sess-new');
    expect(repo.get(t2.id)?.ownerSessionId).toBe('sess-new');
    expect(repo.get(t3.id)?.ownerSessionId).toBe('sess-new');
  });

  it('oldSid 没拥有任何 task → 返回 0', () => {
    insertSession(db, 'sess-new');
    insertSession(db, 'sess-empty');
    expect(repo.reassignOwner('sess-empty', 'sess-new', { policy: 'clear-team' })).toBe(0);
  });

  it('只过继 oldSid 拥有的 task，其他 owner 的 task 不动', () => {
    insertSession(db, 'sess-other');
    insertSession(db, 'sess-new');
    const own = repo.create({ subject: 'mine', ownerSessionId: sid });
    const other = repo.create({ subject: 'other', ownerSessionId: 'sess-other' });

    const changed = repo.reassignOwner(sid, 'sess-new', { policy: 'clear-team' });

    expect(changed).toBe(1);
    expect(repo.get(own.id)?.ownerSessionId).toBe('sess-new');
    expect(repo.get(other.id)?.ownerSessionId).toBe('sess-other'); // 不动
  });

  it('reassignOwner 不刷新 updated_at(F5 deep-review Round 1 修法)', async () => {
    insertSession(db, 'sess-new');
    const t = repo.create({ subject: 'T', ownerSessionId: sid });
    const before = t.updatedAt;
    await new Promise((r) => setTimeout(r, 5));

    repo.reassignOwner(sid, 'sess-new', { policy: 'clear-team' });

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
    expect(() => repo.reassignOwner(sid, 'sess-not-exist', { policy: 'clear-team' })).toThrow();
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

// ===================================================================
// v024 plan task-team-id-restore-20260525 §Phase G2 新 case 块
// ===================================================================

/**
 * insertTeam helper（v024 测试用 — _setup.ts 默认只有 insertSession）。
 * agent_deck_teams 表 schema 见 v010_agent_deck_teams.sql。
 */
function insertTeam(db: Database.Database, id: string, name = `team-${id}`): void {
  db.prepare(
    `INSERT INTO agent_deck_teams (id, name, created_at, archived_at)
     VALUES (?, ?, ?, NULL)`,
  ).run(id, name, 1000);
}

describe.skipIf(!bindingAvailable)('task-repo v024 / create with teamId', () => {
  let db: Database.Database;
  let repo: TaskRepo;
  let sid: string;
  beforeEach(() => {
    ({ db, repo, sid } = makeMemoryRepo());
  });
  afterEach(() => db.close());

  it('create 不传 teamId → personal task (teamId === null) — plan §D1+D2', () => {
    const t = repo.create({ subject: 'P1', ownerSessionId: sid });
    expect(t.teamId).toBeNull();
    expect(repo.get(t.id)?.teamId).toBeNull();
  });

  it('create teamId === null 显式 → personal task', () => {
    const t = repo.create({ subject: 'P2', ownerSessionId: sid, teamId: null });
    expect(t.teamId).toBeNull();
  });

  it('create teamId = "<uuid>" → team-bound task — plan §D1', () => {
    insertTeam(db, 'team-A');
    const t = repo.create({ subject: 'T1', ownerSessionId: sid, teamId: 'team-A' });
    expect(t.teamId).toBe('team-A');
    expect(repo.get(t.id)?.teamId).toBe('team-A');
  });

  it('create teamId 指向不存在的 team → FK 抛错', () => {
    expect(() =>
      repo.create({ subject: 'T1', ownerSessionId: sid, teamId: 'team-not-exist' }),
    ).toThrow();
  });
});

describe.skipIf(!bindingAvailable)('task-repo v024 / update teamId 字段', () => {
  let db: Database.Database;
  let repo: TaskRepo;
  let sid: string;
  beforeEach(() => {
    ({ db, repo, sid } = makeMemoryRepo());
  });
  afterEach(() => db.close());

  it('update teamId = null → 改 team-bound 为 personal', () => {
    insertTeam(db, 'team-A');
    const t = repo.create({ subject: 'T', ownerSessionId: sid, teamId: 'team-A' });
    expect(t.teamId).toBe('team-A');

    const updated = repo.update(t.id, { teamId: null });
    expect(updated?.teamId).toBeNull();
  });

  it('update teamId = "<uuid>" → 改 personal 为 team-bound', () => {
    insertTeam(db, 'team-A');
    const t = repo.create({ subject: 'P', ownerSessionId: sid }); // 默认 personal
    expect(t.teamId).toBeNull();

    const updated = repo.update(t.id, { teamId: 'team-A' });
    expect(updated?.teamId).toBe('team-A');
  });

  it('update teamId 不传 → 不动 teamId', () => {
    insertTeam(db, 'team-A');
    const t = repo.create({ subject: 'T', ownerSessionId: sid, teamId: 'team-A' });

    const updated = repo.update(t.id, { status: 'completed' });
    expect(updated?.teamId).toBe('team-A');
  });

  it('update teamId 指向不存在的 team → FK 抛错', () => {
    insertTeam(db, 'team-A');
    const t = repo.create({ subject: 'T', ownerSessionId: sid, teamId: 'team-A' });
    expect(() => repo.update(t.id, { teamId: 'team-bogus' })).toThrow();
  });
});

describe.skipIf(!bindingAvailable)('task-repo v024 / list 三态 filter (D5)', () => {
  let db: Database.Database;
  let repo: TaskRepo;
  let sid: string;
  beforeEach(() => {
    ({ db, repo, sid } = makeMemoryRepo());
  });
  afterEach(() => db.close());

  function seedThree(): { p: ReturnType<TaskRepo['create']>; ta: ReturnType<TaskRepo['create']>; tb: ReturnType<TaskRepo['create']> } {
    insertTeam(db, 'team-A');
    insertTeam(db, 'team-B');
    const p = repo.create({ subject: 'P', ownerSessionId: sid }); // personal
    const ta = repo.create({ subject: 'TA', ownerSessionId: sid, teamId: 'team-A' });
    const tb = repo.create({ subject: 'TB', ownerSessionId: sid, teamId: 'team-B' });
    return { p, ta, tb };
  }

  it('teamIdFilter === undefined + 无 visibleScope + 无 ownerSessionIds → 不过滤 team_id（拿全部）', () => {
    const { p, ta, tb } = seedThree();
    const list = repo.list();
    expect(new Set(list.map((x) => x.id))).toEqual(new Set([p.id, ta.id, tb.id]));
  });

  it('teamIdFilter === "<team-A uuid>" → 仅返 team_id = "team-A"', () => {
    const { ta } = seedThree();
    const list = repo.list({ teamIdFilter: 'team-A' });
    expect(list.map((x) => x.id)).toEqual([ta.id]);
  });

  it('teamIdFilter === "null-personal" 字面量 → 仅返 team_id IS NULL（personal）', () => {
    const { p } = seedThree();
    const list = repo.list({ teamIdFilter: 'null-personal' });
    expect(list.map((x) => x.id)).toEqual([p.id]);
  });

  it('teamIdFilter + ownerSessionIds 组合 AND（personal owner=caller）', () => {
    insertSession(db, 'sess-other');
    insertTeam(db, 'team-A');
    const ownPersonal = repo.create({ subject: 'P-mine', ownerSessionId: sid });
    repo.create({ subject: 'P-other', ownerSessionId: 'sess-other' });
    repo.create({ subject: 'T-mine', ownerSessionId: sid, teamId: 'team-A' });

    // 拉「caller 自己 personal」
    const list = repo.list({
      teamIdFilter: 'null-personal',
      ownerSessionIds: [sid],
    });
    expect(list.map((x) => x.id)).toEqual([ownPersonal.id]);
  });

  it('visibleScope OR 模式: teamIds=[A,B] + callerSid → 拿 (team A ∪ team B) ∪ caller-own-personal', () => {
    insertSession(db, 'sess-mate');
    insertTeam(db, 'team-A');
    insertTeam(db, 'team-B');
    insertTeam(db, 'team-C');
    const callerPersonal = repo.create({ subject: 'P-mine', ownerSessionId: sid });
    repo.create({ subject: 'P-mate', ownerSessionId: 'sess-mate' }); // 别人 personal 不进
    const teamA = repo.create({ subject: 'TA-mate', ownerSessionId: 'sess-mate', teamId: 'team-A' });
    const teamB = repo.create({ subject: 'TB-mine', ownerSessionId: sid, teamId: 'team-B' });
    repo.create({ subject: 'TC-mate', ownerSessionId: 'sess-mate', teamId: 'team-C' }); // 不在 scope

    const list = repo.list({
      visibleScope: { teamIds: ['team-A', 'team-B'], callerSid: sid },
    });
    expect(new Set(list.map((x) => x.id))).toEqual(
      new Set([callerPersonal.id, teamA.id, teamB.id]),
    );
  });

  it('visibleScope teamIds=[] → 退化为仅 caller own personal（OR 退化分支）', () => {
    insertSession(db, 'sess-mate');
    insertTeam(db, 'team-A');
    const callerPersonal = repo.create({ subject: 'P-mine', ownerSessionId: sid });
    repo.create({ subject: 'P-mate', ownerSessionId: 'sess-mate' });
    repo.create({ subject: 'T', ownerSessionId: sid, teamId: 'team-A' }); // team task 不进退化分支

    const list = repo.list({
      visibleScope: { teamIds: [], callerSid: sid },
    });
    expect(list.map((x) => x.id)).toEqual([callerPersonal.id]);
  });

  it('visibleScope teamIds>500 → 退化为仅 caller personal 不丢失（REVIEW_106 LOW）', () => {
    // REVIEW_106 LOW（reviewer-codex 单方 + lead 现场核实 handler 默认走 visibleScope）:
    // 旧实现 teamIds>500 直接 return [] 连 caller 自己 personal task 也丢 = 破坏可见性契约。
    // 修后退化为 personal-only（与 teamIds.length===0 同款）:team-bound task 放弃命中,
    // 但 caller personal task 仍可见。
    insertSession(db, 'sess-mate');
    insertTeam(db, 'team-real');
    const callerPersonal = repo.create({ subject: 'P-mine', ownerSessionId: sid });
    repo.create({ subject: 'P-mate', ownerSessionId: 'sess-mate' }); // 别人 personal 不进
    repo.create({ subject: 'T-real', ownerSessionId: sid, teamId: 'team-real' }); // team task >500 分支放弃

    // 构造 501 个 teamId（极端病态：caller 同 active team 数超 SQLite IN 上限 500）
    const teamIds = Array.from({ length: 501 }, (_, i) => `team-${i}`);
    const list = repo.list({
      visibleScope: { teamIds, callerSid: sid },
    });
    // 修前：[] （personal 也丢）；修后：[callerPersonal]（personal 保住，team task 放弃）
    expect(list.map((x) => x.id)).toEqual([callerPersonal.id]);
  });
});

describe.skipIf(!bindingAvailable)('task-repo v024 / reassignOwner policy 两态 (D4)', () => {
  let db: Database.Database;
  let repo: TaskRepo;
  let sid: string;
  beforeEach(() => {
    ({ db, repo, sid } = makeMemoryRepo());
  });
  afterEach(() => db.close());

  it("'clear-team' → UPDATE owner + team_id = NULL（team-bound 变 personal）", () => {
    insertSession(db, 'sess-new');
    insertTeam(db, 'team-A');
    const tTeam = repo.create({ subject: 'T-team', ownerSessionId: sid, teamId: 'team-A' });
    const tPersonal = repo.create({ subject: 'T-personal', ownerSessionId: sid });

    const changed = repo.reassignOwner(sid, 'sess-new', { policy: 'clear-team' });

    expect(changed).toBe(2);
    const aTeam = repo.get(tTeam.id);
    const aPersonal = repo.get(tPersonal.id);
    expect(aTeam?.ownerSessionId).toBe('sess-new');
    expect(aTeam?.teamId).toBeNull(); // 关键：team_id 被清成 NULL
    expect(aPersonal?.ownerSessionId).toBe('sess-new');
    expect(aPersonal?.teamId).toBeNull(); // 本来就是 null
  });

  it("'preserve-team' → UPDATE owner 不动 team_id（team-bound 保留）", () => {
    insertSession(db, 'sess-new');
    insertTeam(db, 'team-A');
    const tTeam = repo.create({ subject: 'T-team', ownerSessionId: sid, teamId: 'team-A' });
    const tPersonal = repo.create({ subject: 'T-personal', ownerSessionId: sid });

    const changed = repo.reassignOwner(sid, 'sess-new', { policy: 'preserve-team' });

    expect(changed).toBe(2);
    const aTeam = repo.get(tTeam.id);
    const aPersonal = repo.get(tPersonal.id);
    expect(aTeam?.ownerSessionId).toBe('sess-new');
    expect(aTeam?.teamId).toBe('team-A'); // 关键：team_id 保留
    expect(aPersonal?.ownerSessionId).toBe('sess-new');
    expect(aPersonal?.teamId).toBeNull(); // 还是 null
  });
});

describe.skipIf(!bindingAvailable)('task-repo v024 / applyHandOffSkipPolicy 三 case (B1 + D4)', () => {
  let db: Database.Database;
  let repo: TaskRepo;
  let sid: string;
  beforeEach(() => {
    ({ db, repo, sid } = makeMemoryRepo());
  });
  afterEach(() => db.close());

  it('case A 正常 commit: 删 caller team task + 过继 personal + 其他 owner 不动', () => {
    insertSession(db, 'sess-new');
    insertSession(db, 'sess-other');
    insertTeam(db, 'team-A');
    insertTeam(db, 'team-B');

    const callerTeamA = repo.create({ subject: 'CA', ownerSessionId: sid, teamId: 'team-A' });
    const callerTeamB = repo.create({ subject: 'CB', ownerSessionId: sid, teamId: 'team-B' });
    const callerPersonal = repo.create({ subject: 'CP', ownerSessionId: sid });
    const otherTeam = repo.create({ subject: 'OT', ownerSessionId: 'sess-other', teamId: 'team-A' });
    const otherPersonal = repo.create({ subject: 'OP', ownerSessionId: 'sess-other' });

    const result = repo.applyHandOffSkipPolicy(sid, 'sess-new');

    expect(new Set(result.deletedTeamTaskIds)).toEqual(new Set([callerTeamA.id, callerTeamB.id]));
    expect(result.reassignedPersonalCount).toBe(1);

    // caller team task 都被删
    expect(repo.get(callerTeamA.id)).toBeNull();
    expect(repo.get(callerTeamB.id)).toBeNull();
    // caller personal task 过继 owner
    expect(repo.get(callerPersonal.id)?.ownerSessionId).toBe('sess-new');
    expect(repo.get(callerPersonal.id)?.teamId).toBeNull();
    // other owner 完全不动
    expect(repo.get(otherTeam.id)?.ownerSessionId).toBe('sess-other');
    expect(repo.get(otherTeam.id)?.teamId).toBe('team-A');
    expect(repo.get(otherPersonal.id)?.ownerSessionId).toBe('sess-other');
  });

  it('case A 边界: caller 没拥有任何 team task → deletedTeamTaskIds=[]; 仅 personal 过继', () => {
    insertSession(db, 'sess-new');
    const callerPersonal = repo.create({ subject: 'CP', ownerSessionId: sid });

    const result = repo.applyHandOffSkipPolicy(sid, 'sess-new');

    expect(result.deletedTeamTaskIds).toEqual([]);
    expect(result.reassignedPersonalCount).toBe(1);
    expect(repo.get(callerPersonal.id)?.ownerSessionId).toBe('sess-new');
  });

  it('case A 空: caller 啥都没 → 全 0', () => {
    insertSession(db, 'sess-new');
    insertSession(db, 'sess-empty');

    const result = repo.applyHandOffSkipPolicy('sess-empty', 'sess-new');
    expect(result.deletedTeamTaskIds).toEqual([]);
    expect(result.reassignedPersonalCount).toBe(0);
  });

  it('case C blocks/blocked_by cleanup: 删 caller team task 后 survivor 引用清', () => {
    insertSession(db, 'sess-new');
    insertSession(db, 'sess-other');
    insertTeam(db, 'team-A');

    // caller team task 被 other survivor 引用
    const callerTeam = repo.create({ subject: 'CT', ownerSessionId: sid, teamId: 'team-A' });
    const survivorOther = repo.create({
      subject: 'SO',
      ownerSessionId: 'sess-other',
      blocks: [callerTeam.id],
      blockedBy: [callerTeam.id],
    });
    // caller personal task 也引用 caller team task — 它会被过继到 newSid 但 blocks 该被清
    const callerPersonal = repo.create({
      subject: 'CP',
      ownerSessionId: sid,
      blocks: [callerTeam.id],
    });

    const result = repo.applyHandOffSkipPolicy(sid, 'sess-new');

    expect(result.deletedTeamTaskIds).toEqual([callerTeam.id]);
    expect(result.reassignedPersonalCount).toBe(1);

    // survivor 引用 callerTeam 被清
    const so = repo.get(survivorOther.id);
    expect(so?.blocks).toEqual([]);
    expect(so?.blockedBy).toEqual([]);

    // caller personal 过继 + 自己 blocks 引用也清
    const cp = repo.get(callerPersonal.id);
    expect(cp?.ownerSessionId).toBe('sess-new');
    expect(cp?.blocks).toEqual([]);
  });

  it('case B 事务中段 throw → 整个 transaction ROLLBACK，team task / personal task 全保留', () => {
    insertSession(db, 'sess-new');
    insertTeam(db, 'team-A');

    const callerTeam = repo.create({ subject: 'CT', ownerSessionId: sid, teamId: 'team-A' });
    const callerPersonal = repo.create({ subject: 'CP', ownerSessionId: sid });

    // 触发 throw：close db 之前先 prepare 一个 mock 让 SELECT/DELETE 抛错。
    // 最直接的办法：把 newSid 指向 sessions 表中不存在的 sid → step 4 UPDATE 改 FK 触发抛
    // 但 step 4 不是 FK 改动（不会撞 FK 错），所以改用另一种触发：把 sess-new 不 insertSession
    // → step 4 UPDATE owner_session_id 撞 FK → 整个 tx ROLLBACK
    // （不调 insertSession(db, 'sess-new') 故意触发）
    // 注意：上面 insertSession(db, 'sess-new') 实际已 insert，所以删 sessions row 让 FK fail
    db.prepare(`DELETE FROM sessions WHERE id = ?`).run('sess-new');

    expect(() => repo.applyHandOffSkipPolicy(sid, 'sess-new')).toThrow();

    // ROLLBACK 验证：team task 与 personal 都还在，owner 仍是 caller
    expect(repo.get(callerTeam.id)?.ownerSessionId).toBe(sid);
    expect(repo.get(callerTeam.id)?.teamId).toBe('team-A');
    expect(repo.get(callerPersonal.id)?.ownerSessionId).toBe(sid);
  });
});

describe.skipIf(!bindingAvailable)('task-repo v024 / findOwnedDistinctTeamIds (D2 preserve-team safety)', () => {
  let db: Database.Database;
  let repo: TaskRepo;
  let sid: string;
  beforeEach(() => {
    ({ db, repo, sid } = makeMemoryRepo());
  });
  afterEach(() => db.close());

  it('返 caller owned distinct non-null team_id 列表（personal 排除）', () => {
    insertSession(db, 'sess-other');
    insertTeam(db, 'team-A');
    insertTeam(db, 'team-B');
    insertTeam(db, 'team-C');

    // caller 拥有：2 个 team-A + 1 个 team-B + 1 personal + 0 team-C
    repo.create({ subject: 'T1', ownerSessionId: sid, teamId: 'team-A' });
    repo.create({ subject: 'T2', ownerSessionId: sid, teamId: 'team-A' }); // 重复 team
    repo.create({ subject: 'T3', ownerSessionId: sid, teamId: 'team-B' });
    repo.create({ subject: 'P1', ownerSessionId: sid }); // personal 排除
    // other owner 在 team-C — 不算 caller 的
    repo.create({ subject: 'O1', ownerSessionId: 'sess-other', teamId: 'team-C' });

    const result = repo.findOwnedDistinctTeamIds(sid);
    expect(new Set(result)).toEqual(new Set(['team-A', 'team-B']));
    expect(result.length).toBe(2); // distinct, team-A 不重复
  });

  it('caller 仅有 personal task → 返空', () => {
    repo.create({ subject: 'P1', ownerSessionId: sid });
    repo.create({ subject: 'P2', ownerSessionId: sid });
    expect(repo.findOwnedDistinctTeamIds(sid)).toEqual([]);
  });

  it('caller 啥都没 → 返空', () => {
    insertSession(db, 'sess-empty');
    expect(repo.findOwnedDistinctTeamIds('sess-empty')).toEqual([]);
  });
});

describe.skipIf(!bindingAvailable)('task-repo v024 / team hard delete → tasks.team_id ON DELETE SET NULL', () => {
  let db: Database.Database;
  let repo: TaskRepo;
  let sid: string;
  beforeEach(() => {
    ({ db, repo, sid } = makeMemoryRepo());
  });
  afterEach(() => db.close());

  it('hard delete agent_deck_teams row → tasks.team_id 自动 SET NULL（不级联删 task — plan §不变量 4 GC 兜底）', () => {
    insertTeam(db, 'team-A');
    const tTeam = repo.create({ subject: 'T-team', ownerSessionId: sid, teamId: 'team-A' });
    const tPersonal = repo.create({ subject: 'T-personal', ownerSessionId: sid });

    db.prepare(`DELETE FROM agent_deck_teams WHERE id = ?`).run('team-A');

    // task 都还在
    expect(repo.get(tTeam.id)).not.toBeNull();
    expect(repo.get(tTeam.id)?.teamId).toBeNull(); // team-A 删后退化 personal
    expect(repo.get(tTeam.id)?.ownerSessionId).toBe(sid);
    expect(repo.get(tPersonal.id)?.teamId).toBeNull(); // 本来就是 null
  });
});

describe.skipIf(!bindingAvailable)('task-repo v024 / cascade delete cross-team scenarios (HIGH-2)', () => {
  let db: Database.Database;
  let repo: TaskRepo;
  let sid: string;
  beforeEach(() => {
    ({ db, repo, sid } = makeMemoryRepo());
  });
  afterEach(() => db.close());

  it('root team A → child team A（同 team）+ predicate 允许 team A → child 一并删', () => {
    insertTeam(db, 'team-A');
    const child = repo.create({ subject: 'C', ownerSessionId: sid, teamId: 'team-A' });
    const root = repo.create({ subject: 'R', ownerSessionId: sid, teamId: 'team-A', blocks: [child.id] });

    const deleted = repo.delete(root.id, {
      cascade: true,
      predicate: (_, c) => c.teamId === 'team-A',
    });
    expect(new Set(deleted)).toEqual(new Set([root.id, child.id]));
    expect(repo.get(root.id)).toBeNull();
    expect(repo.get(child.id)).toBeNull();
  });

  it('root team A → child team B + predicate 仅允许 team A → child 跳过 + 链路断', () => {
    insertTeam(db, 'team-A');
    insertTeam(db, 'team-B');
    const grandChild = repo.create({ subject: 'GC', ownerSessionId: sid, teamId: 'team-A' });
    const child = repo.create({ subject: 'C', ownerSessionId: sid, teamId: 'team-B', blocks: [grandChild.id] });
    const root = repo.create({ subject: 'R', ownerSessionId: sid, teamId: 'team-A', blocks: [child.id] });

    const deleted = repo.delete(root.id, {
      cascade: true,
      predicate: (_, c) => c.teamId === 'team-A', // 仅 team A 通过
    });
    expect(deleted).toEqual([root.id]); // root 总会被删（predicate 不挡 root）
    expect(repo.get(child.id)).not.toBeNull(); // team B 跳过保留
    expect(repo.get(grandChild.id)).not.toBeNull(); // 链路断，下游也保留
  });

  it('root personal → child personal（同 owner）+ predicate caller == owner → child 一并删', () => {
    const child = repo.create({ subject: 'C', ownerSessionId: sid });
    const root = repo.create({ subject: 'R', ownerSessionId: sid, blocks: [child.id] });

    const deleted = repo.delete(root.id, {
      cascade: true,
      predicate: (_, c) => c.teamId === null && c.ownerSessionId === sid,
    });
    expect(new Set(deleted)).toEqual(new Set([root.id, child.id]));
  });

  it('root personal → child team A + predicate 仅允许 personal → child 跳过', () => {
    insertTeam(db, 'team-A');
    const child = repo.create({ subject: 'C', ownerSessionId: sid, teamId: 'team-A' });
    const root = repo.create({ subject: 'R', ownerSessionId: sid, blocks: [child.id] });

    const deleted = repo.delete(root.id, {
      cascade: true,
      predicate: (_, c) => c.teamId === null && c.ownerSessionId === sid,
    });
    expect(deleted).toEqual([root.id]);
    expect(repo.get(child.id)).not.toBeNull();
  });
});
