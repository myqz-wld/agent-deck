/**
 * Task Manager 持久层 smoke test（CHANGELOG_41）。
 *
 * 不依赖 Electron app：直接 `new Database(':memory:')` + 跑 v007 migration（用
 * Vite ?raw import 拿到原始 SQL 字符串），通过 `createTaskRepo(db)` 工厂注入 db
 * 跑全套用例。覆盖范围对齐 sdk-task-manager-spec §6 验收 + plan 列出的 12 类断言。
 *
 * 关键测试维度：
 * - 基本 CRUD / 自动字段填充
 * - update 后 updated_at 单调递增
 * - list 默认按 updated_at DESC
 * - status / subjectKeyword / teamName 三类过滤（teamName 三态：undefined / null / string）
 * - cascade=true 级联删 blocks 下游 + 清反向引用
 * - cascade=false 仅断引用（保留下游 task）
 * - 100 条并发 create 全部入库 + ID unique（验证 better-sqlite3 同步语义不丢数据）
 * - 持久化：写到 tmp 文件 → 重新打开 → 数据还在
 * - 损坏 JSON 字段（人工写脏 blocks 列）容错：rowToRecord 退化空数组 + warn
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import v007 from '../migrations/v007_tasks.sql?raw';
import { createTaskRepo, type TaskRepo } from '../task-repo';

/**
 * better-sqlite3 native binding 是 electron-builder install-app-deps 给 Electron
 * Node 重编的（NODE_MODULE_VERSION 跟系统 Node 大概率不同），vitest 走系统 Node
 * 加载会抛 NODE_MODULE_VERSION mismatch。本文件全部用例都依赖真实 SQLite 行为，
 * 没法拆成纯函数测试，所以照搬 search-predicate.test.ts:5 的项目惯例：检测 binding
 * 加载失败 → 跳过整组 + warn 一次，本机若需 spec §6 的实测验收，临时用
 * `pnpm rebuild better-sqlite3` 切到系统 Node 版 binding 跑，再 `pnpm install` 切回。
 */
function probeBetterSqliteBinding(): boolean {
  try {
    const db = new Database(':memory:');
    db.close();
    return true;
  } catch (e) {
    // 仅在跑测试时打一行 warn，避免污染 typecheck / build 路径
    console.warn(
      `[task-repo.test] better-sqlite3 binding 不可用，跳过本文件全部用例。` +
        `若需本地实测：临时跑 pnpm rebuild better-sqlite3，跑完 pnpm install 还原。原因：${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
}
const bindingAvailable = probeBetterSqliteBinding();

function makeMemoryRepo(): { db: Database.Database; repo: TaskRepo } {
  const db = new Database(':memory:');
  db.exec(v007);
  return { db, repo: createTaskRepo(db) };
}

describe.skipIf(!bindingAvailable)('task-repo / 基本 CRUD', () => {
  let db: Database.Database;
  let repo: TaskRepo;
  beforeEach(() => {
    ({ db, repo } = makeMemoryRepo());
  });
  afterEach(() => db.close());

  it('create 自动填 id / created_at / updated_at / 默认值', () => {
    const t = repo.create({ subject: 'A' });
    expect(t.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(t.subject).toBe('A');
    expect(t.status).toBe('pending');
    expect(t.priority).toBe(5);
    expect(t.blocks).toEqual([]);
    expect(t.blockedBy).toEqual([]);
    expect(t.labels).toEqual([]);
    expect(t.teamName).toBeNull();
    expect(t.description).toBeNull();
    expect(t.activeForm).toBeNull();
    expect(t.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(t.updatedAt).toBe(t.createdAt);
  });

  it('subject 空 / 全空白 → 抛错', () => {
    expect(() => repo.create({ subject: '' })).toThrow(/subject/);
    expect(() => repo.create({ subject: '   ' })).toThrow(/subject/);
  });

  it('get 找得到 / 找不到', () => {
    const t = repo.create({ subject: 'A', priority: 8 });
    const got = repo.get(t.id);
    expect(got?.id).toBe(t.id);
    expect(got?.priority).toBe(8);
    expect(repo.get('nonexistent')).toBeNull();
  });

  it('update 增量改字段 + 强制刷新 updated_at', async () => {
    const t = repo.create({ subject: 'A' });
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

  it('update 显式 null 可清空 description / activeForm（teamName 不可改，REVIEW_17 H1）', () => {
    const t = repo.create({
      subject: 'A',
      description: 'd',
      activeForm: 'agent',
      teamName: 'team-1',
    });
    const u = repo.update(t.id, { description: null, activeForm: null, teamName: null });
    expect(u?.description).toBeNull();
    expect(u?.activeForm).toBeNull();
    // REVIEW_17 H1：teamName 不再支持通过 update 改（含清空）。tool 层闭包锁本来
    // 就禁止跨 team，repo 层主动忽略防 ts 直调绕过。
    expect(u?.teamName).toBe('team-1');
  });

  it('update subject 不能改成空', () => {
    const t = repo.create({ subject: 'A' });
    expect(() => repo.update(t.id, { subject: '' })).toThrow(/subject/);
    expect(() => repo.update(t.id, { subject: '  ' })).toThrow(/subject/);
  });

  it('delete 单条', () => {
    const t = repo.create({ subject: 'A' });
    expect(repo.delete(t.id)).toBe(true);
    expect(repo.get(t.id)).toBeNull();
    expect(repo.delete(t.id)).toBe(false); // 第二次返回 false
  });
});

describe.skipIf(!bindingAvailable)('task-repo / list 排序与过滤', () => {
  let db: Database.Database;
  let repo: TaskRepo;
  beforeEach(() => {
    ({ db, repo } = makeMemoryRepo());
  });
  afterEach(() => db.close());

  it('默认按 updated_at DESC', async () => {
    const a = repo.create({ subject: 'A' });
    await new Promise((r) => setTimeout(r, 5));
    const b = repo.create({ subject: 'B' });
    await new Promise((r) => setTimeout(r, 5));
    const c = repo.create({ subject: 'C' });
    const list = repo.list();
    expect(list.map((x) => x.id)).toEqual([c.id, b.id, a.id]);
  });

  it('status 过滤', () => {
    repo.create({ subject: 'A', status: 'pending' });
    repo.create({ subject: 'B', status: 'active' });
    repo.create({ subject: 'C', status: 'active' });
    expect(repo.list({ status: 'active' })).toHaveLength(2);
    expect(repo.list({ status: 'pending' })).toHaveLength(1);
    expect(repo.list({ status: 'completed' })).toHaveLength(0);
  });

  it('subjectKeyword 模糊匹配（case-insensitive）', () => {
    repo.create({ subject: 'Fix login bug' });
    repo.create({ subject: 'Refactor LOGIN flow' });
    repo.create({ subject: 'Add cache' });
    expect(repo.list({ subjectKeyword: 'login' })).toHaveLength(2);
    expect(repo.list({ subjectKeyword: 'LOGIN' })).toHaveLength(2);
    expect(repo.list({ subjectKeyword: 'cache' })).toHaveLength(1);
  });

  it('teamName 三态：不传=全部 / null=仅全局 / string=该 team', () => {
    repo.create({ subject: 'global-1' });
    repo.create({ subject: 'global-2' });
    repo.create({ subject: 't-foo-1', teamName: 'foo' });
    repo.create({ subject: 't-foo-2', teamName: 'foo' });
    repo.create({ subject: 't-bar-1', teamName: 'bar' });
    expect(repo.list()).toHaveLength(5);
    expect(repo.list({ teamName: null })).toHaveLength(2);
    expect(repo.list({ teamName: 'foo' })).toHaveLength(2);
    expect(repo.list({ teamName: 'bar' })).toHaveLength(1);
    expect(repo.list({ teamName: 'nonexistent' })).toHaveLength(0);
  });

  it('limit / offset 分页', () => {
    for (let i = 0; i < 10; i += 1) repo.create({ subject: `t-${i}` });
    expect(repo.list({ limit: 3 })).toHaveLength(3);
    expect(repo.list({ limit: 3, offset: 8 })).toHaveLength(2);
    expect(repo.list({ limit: 100 })).toHaveLength(10);
  });

  it('多条件组合：status + teamName + subjectKeyword', () => {
    repo.create({ subject: 'foo-A', status: 'active', teamName: 'X' });
    repo.create({ subject: 'foo-B', status: 'pending', teamName: 'X' });
    repo.create({ subject: 'foo-C', status: 'active', teamName: 'Y' });
    expect(
      repo.list({ status: 'active', teamName: 'X', subjectKeyword: 'foo' }),
    ).toHaveLength(1);
  });
});

describe.skipIf(!bindingAvailable)('task-repo / cascade delete', () => {
  let db: Database.Database;
  let repo: TaskRepo;
  beforeEach(() => {
    ({ db, repo } = makeMemoryRepo());
  });
  afterEach(() => db.close());

  it('cascade=true 级联删 blocks 下游', () => {
    const c = repo.create({ subject: 'C' });
    const b = repo.create({ subject: 'B', blocks: [c.id] });
    const a = repo.create({ subject: 'A', blocks: [b.id] });
    expect(repo.delete(a.id, { cascade: true })).toBe(true);
    expect(repo.get(a.id)).toBeNull();
    expect(repo.get(b.id)).toBeNull();
    expect(repo.get(c.id)).toBeNull();
  });

  it('cascade=false 仅断引用：下游 task 保留 + 反向引用清理', () => {
    const b = repo.create({ subject: 'B' });
    const a = repo.create({
      subject: 'A',
      blocks: [b.id],
      blockedBy: [],
    });
    repo.update(b.id, { blockedBy: [a.id] });
    expect(repo.delete(a.id)).toBe(true);
    const survivor = repo.get(b.id);
    expect(survivor).not.toBeNull();
    expect(survivor?.blockedBy).toEqual([]); // a 被删，b.blockedBy 清掉对 a 的引用
  });

  it('cascade=true 防自循环：cascade 链路里有环不会死循环', () => {
    const b = repo.create({ subject: 'B' });
    const a = repo.create({ subject: 'A', blocks: [b.id] });
    // 人工制造循环依赖（store 不做循环检测，但 cascade 内必须挡住死循环）
    repo.update(b.id, { blocks: [a.id] });
    expect(() => repo.delete(a.id, { cascade: true })).not.toThrow();
    expect(repo.get(a.id)).toBeNull();
    expect(repo.get(b.id)).toBeNull();
  });

  it('删除不存在的 id 返回 false', () => {
    expect(repo.delete('nope')).toBe(false);
  });

  it('级联删后清理多条 task 的反向引用', () => {
    const target = repo.create({ subject: 'target' });
    const ref1 = repo.create({ subject: 'ref1', blocks: [target.id] });
    const ref2 = repo.create({ subject: 'ref2', blockedBy: [target.id] });
    repo.delete(target.id);
    expect(repo.get(ref1.id)?.blocks).toEqual([]);
    expect(repo.get(ref2.id)?.blockedBy).toEqual([]);
  });

  it('REVIEW_17 H1：cascade 带 predicate 时跨 team child 被跳过（不删 + 不展开下游）', () => {
    // chain: A(team-X) → B(team-Y) → C(team-Y)。删 A 时 predicate 只让 team-X 通过，
    // B 应被跳过（保留），C 也不应被删（链路在 B 处中断）。
    const c = repo.create({ subject: 'C', teamName: 'team-Y' });
    const b = repo.create({ subject: 'B', teamName: 'team-Y', blocks: [c.id] });
    const a = repo.create({ subject: 'A', teamName: 'team-X', blocks: [b.id] });
    expect(repo.delete(a.id, { cascade: true, predicate: (_, t) => t === 'team-X' })).toBe(true);
    expect(repo.get(a.id)).toBeNull(); // self 总会被删（predicate 不挡 root）
    expect(repo.get(b.id)).not.toBeNull(); // cross-team 跳过
    expect(repo.get(c.id)).not.toBeNull(); // 链路中断，下游也保留
  });

  it('REVIEW_17 H1：cascade predicate 通过的 child 才进 toDelete + 继续展开', () => {
    // chain: A(team-X) → B(team-X) → C(team-Y) → D(team-X)。删 A，predicate 只让 team-X 通过。
    // 期望：A 删 + B 删，C 跳过（不删），D 因链路在 C 处断也保留。
    const d = repo.create({ subject: 'D', teamName: 'team-X' });
    const c = repo.create({ subject: 'C', teamName: 'team-Y', blocks: [d.id] });
    const b = repo.create({ subject: 'B', teamName: 'team-X', blocks: [c.id] });
    const a = repo.create({ subject: 'A', teamName: 'team-X', blocks: [b.id] });
    repo.delete(a.id, { cascade: true, predicate: (_, t) => t === 'team-X' });
    expect(repo.get(a.id)).toBeNull();
    expect(repo.get(b.id)).toBeNull();
    expect(repo.get(c.id)).not.toBeNull();
    expect(repo.get(d.id)).not.toBeNull();
  });

  it('REVIEW_17 H1 / L9：repo.update 主动忽略 patch.teamName（双保险防 ts 直调绕过 closure）', () => {
    const t = repo.create({ subject: 'A', teamName: 'team-X' });
    // 把 patch.teamName 写成 cross-team value，repo 应静默忽略，DB 列保持原值
    const updated = repo.update(t.id, { teamName: 'team-Y' as never, status: 'completed' });
    expect(updated?.teamName).toBe('team-X'); // 不被改
    expect(updated?.status).toBe('completed'); // 其他字段照改
  });
});

describe.skipIf(!bindingAvailable)('task-repo / 并发与持久化', () => {
  it('100 条 create 并发：全部入库 + ID 全 unique', async () => {
    const { db, repo } = makeMemoryRepo();
    try {
      // 严格说 better-sqlite3 是同步 API，"并发" 在 Node 单线程里是 microtask 串行；
      // 但仍然验证我们没在 create 里依赖外部异步状态导致竞态。
      const promises = Array.from({ length: 100 }, (_, i) =>
        Promise.resolve().then(() => repo.create({ subject: `t-${i}` })),
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
      const db1 = new Database(dbPath);
      db1.exec(v007);
      const repo1 = createTaskRepo(db1);
      const a = repo1.create({ subject: 'persist-me', teamName: 'X' });
      db1.close();

      const db2 = new Database(dbPath);
      const repo2 = createTaskRepo(db2);
      const got = repo2.get(a.id);
      expect(got?.subject).toBe('persist-me');
      expect(got?.teamName).toBe('X');
      db2.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!bindingAvailable)('task-repo / 损坏数据容错', () => {
  it('blocks / blocked_by / labels 列里写脏 JSON：rowToRecord 退化空数组 + warn', () => {
    const { db, repo } = makeMemoryRepo();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const t = repo.create({ subject: 'A' });
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
    const { db, repo } = makeMemoryRepo();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const t = repo.create({ subject: 'A' });
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
