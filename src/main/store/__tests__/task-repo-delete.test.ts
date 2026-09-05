import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { TaskRepo } from '../task-repo';
import { bindingAvailable, makeMemoryRepo, insertSession, insertTeam } from './task-repo.fixture';

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
