/**
 * Issue Tracker 持久层单测（plan issue-tracker-mcp-20260529 §Step 3.2.2）。
 *
 * 覆盖维度（与 task-repo.test.ts 同款 binding probe skip 守门）：
 * - CRUD happy path
 * - D15 resolved_at 状态机 8 case repo 层（7 transition + 1 partial patch undefined；
 *   zod enum reject status='foo' 属 IPC 层 case 9 — 在 src/main/ipc/__tests__/issues.test.ts）
 * - appendContext + listAppendices + ON DELETE CASCADE
 * - softDelete / undelete
 * - listForGc 阈值边界
 * - D17 logsRef merge (date / tsRange min-max / scopes union+normalize / note append+截断)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createIssueRepo, type IssueRepo } from '../issue-repo';
import { bindingAvailable, makeMemoryDb, insertSession } from './agent-deck-repos/_setup';

const DEFAULT_SID = 'sess-default';

function makeMemoryRepo(): { db: Database.Database; repo: IssueRepo; sid: string } {
  const db = makeMemoryDb();
  insertSession(db, DEFAULT_SID);
  return { db, repo: createIssueRepo(db), sid: DEFAULT_SID };
}

describe.skipIf(!bindingAvailable)('issue-repo / basic CRUD', () => {
  let db: Database.Database;
  let repo: IssueRepo;
  let sid: string;
  beforeEach(() => { ({ db, repo, sid } = makeMemoryRepo()); });
  afterEach(() => db.close());

  it('create 自动填 id / created_at / updated_at / 默认值', () => {
    const i = repo.create({ title: 'T', description: 'D', sourceSessionId: sid });
    expect(i.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(i.title).toBe('T');
    expect(i.description).toBe('D');
    expect(i.kind).toBe('follow-up'); // §D6 默认
    expect(i.severity).toBe('medium'); // §D9 默认
    expect(i.status).toBe('open'); // §D7 默认
    expect(i.labels).toEqual([]);
    expect(i.repro).toBeNull();
    expect(i.logsRef).toBeNull();
    expect(i.resolutionSessionId).toBeNull();
    expect(i.resolvedAt).toBeNull();
    expect(i.deletedAt).toBeNull();
    expect(typeof i.createdAt).toBe('number');
    expect(i.updatedAt).toBe(i.createdAt);
  });

  it('title 空 / 全空白 → 抛错', () => {
    expect(() => repo.create({ title: '', description: 'D', sourceSessionId: sid })).toThrow(/title/);
    expect(() => repo.create({ title: '   ', description: 'D', sourceSessionId: sid })).toThrow(/title/);
  });

  it('description 空 / 全空白 → 抛错', () => {
    expect(() => repo.create({ title: 'T', description: '', sourceSessionId: sid })).toThrow(/description/);
    expect(() => repo.create({ title: 'T', description: '   ', sourceSessionId: sid })).toThrow(/description/);
  });

  it('sourceSessionId 指向不存在 session → FK 抛错（FK ON DELETE SET NULL 但 INSERT 时 FK 仍校验）', () => {
    expect(() => repo.create({ title: 'T', description: 'D', sourceSessionId: 'sess-not-exist' })).toThrow();
  });

  it('sourceSessionId 可为 null（issue 独立生命周期 §不变量 2 允许 NULL）', () => {
    const i = repo.create({ title: 'T', description: 'D', sourceSessionId: null });
    expect(i.sourceSessionId).toBeNull();
  });

  it('get 找得到 / 找不到', () => {
    const i = repo.create({ title: 'T', description: 'D', sourceSessionId: sid });
    expect(repo.get(i.id)?.id).toBe(i.id);
    expect(repo.get('nonexistent')).toBeNull();
  });

  it('kind free-form fallback (§D6) — 非枚举值原样落库', () => {
    const i = repo.create({ title: 'T', description: 'D', sourceSessionId: sid, kind: 'agent-deck-bug' });
    expect(i.kind).toBe('agent-deck-bug');
    expect(repo.get(i.id)?.kind).toBe('agent-deck-bug');
  });

  it('logsRef 完整字段往返 (date / tsRange / scopes / note)', () => {
    const ref = { date: '2026-05-30', tsRange: { start: 1000, end: 2000 }, scopes: ['a','b'], note: 'n' };
    const i = repo.create({ title: 'T', description: 'D', sourceSessionId: sid, logsRef: ref });
    expect(repo.get(i.id)?.logsRef).toEqual(ref);
  });

  it('labels JSON 字段往返', () => {
    const i = repo.create({ title: 'T', description: 'D', sourceSessionId: sid, labels: ['urgent', 'p0'] });
    expect(repo.get(i.id)?.labels).toEqual(['urgent', 'p0']);
  });
});

describe.skipIf(!bindingAvailable)('issue-repo / D15 resolved_at 状态机 (7 transition + 1 partial idempotent)', () => {
  let db: Database.Database;
  let repo: IssueRepo;
  let sid: string;
  beforeEach(() => { ({ db, repo, sid } = makeMemoryRepo()); });
  afterEach(() => db.close());

  function makeIssue() { return repo.create({ title: 'T', description: 'D', sourceSessionId: sid }); }

  // Case 1: open → resolved → set resolved_at = now
  it('case 1: open → resolved → set resolved_at = now', () => {
    const i = makeIssue();
    expect(i.resolvedAt).toBeNull();
    const t0 = Date.now();
    const u = repo.update(i.id, { status: 'resolved' });
    expect(u?.resolvedAt).not.toBeNull();
    expect(u!.resolvedAt!).toBeGreaterThanOrEqual(t0);
  });

  // Case 2: in-progress → resolved → set resolved_at = now
  it('case 2: in-progress → resolved → set resolved_at = now', () => {
    const i = makeIssue();
    repo.update(i.id, { status: 'in-progress' });
    expect(repo.get(i.id)?.resolvedAt).toBeNull();
    const t0 = Date.now();
    const u = repo.update(i.id, { status: 'resolved' });
    expect(u!.resolvedAt!).toBeGreaterThanOrEqual(t0);
  });

  // Case 3: resolved → open → 保留旧 resolved_at（不清）
  it('case 3: resolved → open → 保留旧 resolved_at（不清）', () => {
    const i = makeIssue();
    repo.update(i.id, { status: 'resolved' });
    const oldR = repo.get(i.id)?.resolvedAt;
    expect(oldR).not.toBeNull();
    repo.update(i.id, { status: 'open' });
    expect(repo.get(i.id)?.resolvedAt).toBe(oldR);
  });

  // Case 4: resolved → in-progress → 保留旧 resolved_at（不清）
  it('case 4: resolved → in-progress → 保留旧 resolved_at（不清）', () => {
    const i = makeIssue();
    repo.update(i.id, { status: 'resolved' });
    const oldR = repo.get(i.id)?.resolvedAt;
    repo.update(i.id, { status: 'in-progress' });
    expect(repo.get(i.id)?.resolvedAt).toBe(oldR);
  });

  // Case 5: resolved → resolved → idempotent 不动 resolved_at
  it('case 5: resolved → resolved → idempotent 不动 resolved_at', async () => {
    const i = makeIssue();
    repo.update(i.id, { status: 'resolved' });
    const oldR = repo.get(i.id)?.resolvedAt;
    await new Promise((r) => setTimeout(r, 5)); // 等 ms 让 now 变化以暴露 idempotent bug
    repo.update(i.id, { status: 'resolved' });
    expect(repo.get(i.id)?.resolvedAt).toBe(oldR);
  });

  // Case 6: open → in-progress → resolved → set 新 resolved_at
  it('case 6: open → in-progress → resolved → set 新 resolved_at', () => {
    const i = makeIssue();
    repo.update(i.id, { status: 'in-progress' });
    const t0 = Date.now();
    const u = repo.update(i.id, { status: 'resolved' });
    expect(u!.resolvedAt!).toBeGreaterThanOrEqual(t0);
  });

  // Case 7: resolved → in-progress → resolved → **刷新** resolved_at 用本次时间
  it('case 7: resolved → in-progress → resolved → **刷新** resolved_at 用本次时间', async () => {
    const i = makeIssue();
    repo.update(i.id, { status: 'resolved' });
    const firstR = repo.get(i.id)!.resolvedAt!;
    await new Promise((r) => setTimeout(r, 10));
    repo.update(i.id, { status: 'in-progress' });
    expect(repo.get(i.id)!.resolvedAt).toBe(firstR); // 中间保留
    await new Promise((r) => setTimeout(r, 10));
    const u = repo.update(i.id, { status: 'resolved' });
    expect(u!.resolvedAt!).toBeGreaterThan(firstR); // 第 3 步刷新
  });

  // Case 8: partial patch undefined（不带 status）→ idempotent 不动 resolved_at
  it('case 8: partial patch undefined（不带 status 字段）→ idempotent 不动 resolved_at', () => {
    const i = makeIssue();
    repo.update(i.id, { status: 'resolved' });
    const oldR = repo.get(i.id)?.resolvedAt;
    repo.update(i.id, { title: 'T2', description: 'D2' });
    expect(repo.get(i.id)?.resolvedAt).toBe(oldR);
  });
});

describe.skipIf(!bindingAvailable)('issue-repo / appendContext + listAppendices + CASCADE', () => {
  let db: Database.Database;
  let repo: IssueRepo;
  let sid: string;
  beforeEach(() => { ({ db, repo, sid } = makeMemoryRepo()); });
  afterEach(() => db.close());

  it('appendContext INSERT 子表行 + 返回完整 record 含 appendices', () => {
    const i = repo.create({ title: 'T', description: 'D', sourceSessionId: sid });
    const after = repo.appendContext({ issueId: i.id, body: 'ctx-1', appendedSessionId: sid });
    expect(after?.appendices?.length).toBe(1);
    expect(after?.appendices?.[0].body).toBe('ctx-1');
    expect(after?.appendices?.[0].appendedSessionId).toBe(sid);
  });

  it('listAppendices 按 appendedAt asc 排序', async () => {
    const i = repo.create({ title: 'T', description: 'D', sourceSessionId: sid });
    repo.appendContext({ issueId: i.id, body: 'first', appendedSessionId: sid });
    await new Promise((r) => setTimeout(r, 5));
    repo.appendContext({ issueId: i.id, body: 'second', appendedSessionId: sid });
    const list = repo.listAppendices(i.id);
    expect(list.length).toBe(2);
    expect(list[0].body).toBe('first');
    expect(list[1].body).toBe('second');
  });

  it('appendContext to non-existent issue → null', () => {
    expect(repo.appendContext({ issueId: 'nonexistent', body: 'x', appendedSessionId: sid })).toBeNull();
  });

  it('hardDelete CASCADE 删 issue_appendices 行', () => {
    const i = repo.create({ title: 'T', description: 'D', sourceSessionId: sid });
    repo.appendContext({ issueId: i.id, body: 'ctx', appendedSessionId: sid });
    expect(repo.listAppendices(i.id).length).toBe(1);
    repo.hardDelete(i.id);
    expect(repo.listAppendices(i.id).length).toBe(0); // CASCADE 已删
  });
});

describe.skipIf(!bindingAvailable)('issue-repo / D17 logsRef merge', () => {
  let db: Database.Database;
  let repo: IssueRepo;
  let sid: string;
  beforeEach(() => { ({ db, repo, sid } = makeMemoryRepo()); });
  afterEach(() => db.close());

  it('date 以 args 为准覆盖', () => {
    const i = repo.create({
      title: 'T', description: 'D', sourceSessionId: sid,
      logsRef: { date: '2026-05-29' },
    });
    repo.appendContext({
      issueId: i.id, body: 'x', appendedSessionId: sid,
      logsRef: { date: '2026-05-30' },
    });
    expect(repo.get(i.id)?.logsRef?.date).toBe('2026-05-30');
  });

  it('tsRange min(start), max(end) 扩展时段', () => {
    const i = repo.create({
      title: 'T', description: 'D', sourceSessionId: sid,
      logsRef: { date: '2026-05-30', tsRange: { start: 500, end: 1500 } },
    });
    repo.appendContext({
      issueId: i.id, body: 'x', appendedSessionId: sid,
      logsRef: { date: '2026-05-30', tsRange: { start: 1000, end: 2000 } },
    });
    expect(repo.get(i.id)?.logsRef?.tsRange).toEqual({ start: 500, end: 2000 });
  });

  it('scopes union 去重', () => {
    const i = repo.create({
      title: 'T', description: 'D', sourceSessionId: sid,
      logsRef: { date: '2026-05-30', scopes: ['a', 'b'] },
    });
    repo.appendContext({
      issueId: i.id, body: 'x', appendedSessionId: sid,
      logsRef: { date: '2026-05-30', scopes: ['b', 'c'] },
    });
    expect(repo.get(i.id)?.logsRef?.scopes?.sort()).toEqual(['a', 'b', 'c']);
  });

  it('scopes post-merge > 32 → caller args 全保留 + existing 从尾截 (D17 normalize)', () => {
    // existing 25 项 + caller 10 项（caller 全为新值不与 existing 重叠）→ union 35 项 → 取 32 项
    const existingScopes = Array.from({ length: 25 }, (_, i) => `e${i}`);
    const callerScopes = Array.from({ length: 10 }, (_, i) => `c${i}`);
    const i = repo.create({
      title: 'T', description: 'D', sourceSessionId: sid,
      logsRef: { date: '2026-05-30', scopes: existingScopes },
    });
    repo.appendContext({
      issueId: i.id, body: 'x', appendedSessionId: sid,
      logsRef: { date: '2026-05-30', scopes: callerScopes },
    });
    const finalScopes = repo.get(i.id)?.logsRef?.scopes ?? [];
    expect(finalScopes.length).toBe(32);
    // caller 10 项全保留
    for (const c of callerScopes) expect(finalScopes).toContain(c);
    // existing 末 3 项被截掉（25-22=3）
    expect(finalScopes).not.toContain('e24');
    expect(finalScopes).not.toContain('e23');
    expect(finalScopes).not.toContain('e22');
    expect(finalScopes).toContain('e21'); // 末 4 项保留
  });

  it('note append "(appended <iso>) <new>" 到旧末尾', () => {
    const i = repo.create({
      title: 'T', description: 'D', sourceSessionId: sid,
      logsRef: { date: '2026-05-30', note: 'orig' },
    });
    repo.appendContext({
      issueId: i.id, body: 'x', appendedSessionId: sid,
      logsRef: { date: '2026-05-30', note: 'new' },
    });
    const note = repo.get(i.id)?.logsRef?.note;
    expect(note).toMatch(/^orig\n\(appended \d{4}-\d{2}-\d{2}T.*Z\) new$/);
  });

  it('note 总长 > 2000 char → 从头截，前缀 "..."', () => {
    const longExisting = 'a'.repeat(1990);
    const i = repo.create({
      title: 'T', description: 'D', sourceSessionId: sid,
      logsRef: { date: '2026-05-30', note: longExisting },
    });
    repo.appendContext({
      issueId: i.id, body: 'x', appendedSessionId: sid,
      logsRef: { date: '2026-05-30', note: 'bbbbb' },
    });
    const note = repo.get(i.id)!.logsRef!.note!;
    expect(note.length).toBe(2000);
    expect(note.startsWith('...')).toBe(true);
    expect(note.endsWith(' bbbbb')).toBe(true);
  });

  it('args.logsRef == null/undefined → skip merge update', () => {
    const ref = { date: '2026-05-30', note: 'orig' };
    const i = repo.create({ title: 'T', description: 'D', sourceSessionId: sid, logsRef: ref });
    repo.appendContext({ issueId: i.id, body: 'x', appendedSessionId: sid }); // 不传 logsRef
    expect(repo.get(i.id)?.logsRef).toEqual(ref); // 不变
  });
});

describe.skipIf(!bindingAvailable)('issue-repo / list filter + soft+undelete', () => {
  let db: Database.Database;
  let repo: IssueRepo;
  let sid: string;
  beforeEach(() => { ({ db, repo, sid } = makeMemoryRepo()); });
  afterEach(() => db.close());

  it('list 默认隐藏 soft-deleted', () => {
    const a = repo.create({ title: 'A', description: 'D', sourceSessionId: sid });
    repo.create({ title: 'B', description: 'D', sourceSessionId: sid });
    repo.softDelete(a.id);
    const items = repo.list();
    expect(items.length).toBe(1);
    expect(items[0].title).toBe('B');
  });

  it('onlyDeleted=true → 仅返软删', () => {
    const a = repo.create({ title: 'A', description: 'D', sourceSessionId: sid });
    repo.create({ title: 'B', description: 'D', sourceSessionId: sid });
    repo.softDelete(a.id);
    const items = repo.list({ onlyDeleted: true });
    expect(items.length).toBe(1);
    expect(items[0].title).toBe('A');
  });

  it('statuses 多选 filter', () => {
    const a = repo.create({ title: 'A', description: 'D', sourceSessionId: sid });
    const b = repo.create({ title: 'B', description: 'D', sourceSessionId: sid });
    repo.update(a.id, { status: 'in-progress' });
    repo.update(b.id, { status: 'resolved' });
    const items = repo.list({ statuses: ['in-progress', 'resolved'] });
    expect(items.length).toBe(2);
    const titles = items.map((i) => i.title).sort();
    expect(titles).toEqual(['A', 'B']);
  });

  it('kinds 多选 filter', () => {
    repo.create({ title: 'A', description: 'D', sourceSessionId: sid, kind: 'app-bug' });
    repo.create({ title: 'B', description: 'D', sourceSessionId: sid, kind: 'enhancement' });
    repo.create({ title: 'C', description: 'D', sourceSessionId: sid });
    const items = repo.list({ kinds: ['app-bug', 'enhancement'] });
    expect(items.length).toBe(2);
  });

  it('titleKeyword 大小写不敏感 substring', () => {
    repo.create({ title: 'Hello World', description: 'D', sourceSessionId: sid });
    repo.create({ title: 'Other', description: 'D', sourceSessionId: sid });
    expect(repo.list({ titleKeyword: 'WORLD' }).length).toBe(1);
    expect(repo.list({ titleKeyword: 'oth' }).length).toBe(1);
    expect(repo.list({ titleKeyword: 'xxx' }).length).toBe(0);
  });

  it('softDelete 写 deleted_at；undelete 清', () => {
    const a = repo.create({ title: 'A', description: 'D', sourceSessionId: sid });
    expect(repo.softDelete(a.id)).toBe(true);
    expect(repo.get(a.id)?.deletedAt).not.toBeNull();
    expect(repo.softDelete(a.id)).toBe(false); // 已删，no-op
    expect(repo.undelete(a.id)).toBe(true);
    expect(repo.get(a.id)?.deletedAt).toBeNull();
    expect(repo.undelete(a.id)).toBe(false); // 已 undelete，no-op
  });
});

describe.skipIf(!bindingAvailable)('issue-repo / listForGc 阈值边界', () => {
  let db: Database.Database;
  let repo: IssueRepo;
  let sid: string;
  beforeEach(() => { ({ db, repo, sid } = makeMemoryRepo()); });
  afterEach(() => db.close());

  it('resolved 超期 → resolvedExpired，未超期不上榜', () => {
    const a = repo.create({ title: 'A', description: 'D', sourceSessionId: sid });
    const b = repo.create({ title: 'B', description: 'D', sourceSessionId: sid });
    repo.update(a.id, { status: 'resolved' });
    repo.update(b.id, { status: 'resolved' });
    // 手工把 a 的 resolved_at 改到 100 天前
    const ago100d = Date.now() - 100 * 86_400_000;
    db.prepare(`UPDATE issues SET resolved_at = ? WHERE id = ?`).run(ago100d, a.id);
    const r = repo.listForGc({ resolvedRetentionDays: 90, softDeletedRetentionDays: 7 });
    expect(r.resolvedExpired).toContain(a.id);
    expect(r.resolvedExpired).not.toContain(b.id);
  });

  it('soft-deleted 超期 → softDeletedExpired，未超期不上榜', () => {
    const a = repo.create({ title: 'A', description: 'D', sourceSessionId: sid });
    const b = repo.create({ title: 'B', description: 'D', sourceSessionId: sid });
    repo.softDelete(a.id);
    repo.softDelete(b.id);
    const ago10d = Date.now() - 10 * 86_400_000;
    db.prepare(`UPDATE issues SET deleted_at = ? WHERE id = ?`).run(ago10d, a.id);
    const r = repo.listForGc({ resolvedRetentionDays: 90, softDeletedRetentionDays: 7 });
    expect(r.softDeletedExpired).toContain(a.id);
    expect(r.softDeletedExpired).not.toContain(b.id);
  });

  it('阈值 = 0 → 跳过该类 GC', () => {
    const a = repo.create({ title: 'A', description: 'D', sourceSessionId: sid });
    repo.update(a.id, { status: 'resolved' });
    db.prepare(`UPDATE issues SET resolved_at = ? WHERE id = ?`).run(Date.now() - 100 * 86_400_000, a.id);
    const r = repo.listForGc({ resolvedRetentionDays: 0, softDeletedRetentionDays: 7 });
    expect(r.resolvedExpired).toEqual([]);
  });

  it('nowMs override 可注入测试时钟', () => {
    const a = repo.create({ title: 'A', description: 'D', sourceSessionId: sid });
    repo.update(a.id, { status: 'resolved' });
    // 用 nowMs=resolved_at + 91d 触发 GC
    const r = repo.get(a.id)!;
    const futureNow = r.resolvedAt! + 91 * 86_400_000;
    const result = repo.listForGc({ resolvedRetentionDays: 90, softDeletedRetentionDays: 7, nowMs: futureNow });
    expect(result.resolvedExpired).toContain(a.id);
  });
});
