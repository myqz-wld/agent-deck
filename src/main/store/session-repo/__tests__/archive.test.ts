/**
 * setArchived + SessionRowMissingError 单测(archive-toctou-fix-20260515 plan,R1 双方共识修法 A)。
 *
 * scope: SQL 单点 setter throw 行为(.changes !== 1 → SessionRowMissingError),verify SSOT
 * 让 caller 链(sessionManager.archive / unarchive / IPC handler / mcp baton-cleanup helper /
 * UI session-hand-off-finalize)通过 throw 自然感知 race window 内 row 被外部删的边界。
 *
 * 不依赖真 SQLite — 通过 vi.mock 把 `@main/store/db` 的 getDb 替换成 fake stmt,这样测试
 * 不撞 better-sqlite3 ABI 环境守门(`pnpm exec vitest` 在 Electron 33 / Node 20 ABI 间不一致),
 * 与 task-repo.test.ts 顶部 binding 自检 skip 守门策略不同 — 本 test 走纯 mock 不需要 SQLite binding。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setArchived, SessionRowMissingError } from '../archive';

// fake stmt.run() 返回 { changes }; vi.fn() 让单测可逐 it 调整 mockReturnValue
const runMock = vi.fn();
const fakeDb = {
  prepare: vi.fn(() => ({ run: runMock })),
};

vi.mock('../../db', () => ({
  getDb: () => fakeDb,
}));

describe('setArchived (archive-toctou-fix-20260515 plan)', () => {
  beforeEach(() => {
    runMock.mockReset();
    fakeDb.prepare.mockClear();
  });

  it('正常归档(.changes === 1)→ 不 throw + UPDATE 调用 1 次', () => {
    runMock.mockReturnValueOnce({ changes: 1 });
    const ts = 1234567890;

    expect(() => setArchived('sid-OK', ts)).not.toThrow();

    expect(fakeDb.prepare).toHaveBeenCalledTimes(1);
    expect(fakeDb.prepare).toHaveBeenCalledWith(
      'UPDATE sessions SET archived_at = ? WHERE id = ?',
    );
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(runMock).toHaveBeenCalledWith(ts, 'sid-OK');
  });

  it('正常取消归档(ts=null + .changes === 1)→ 不 throw', () => {
    runMock.mockReturnValueOnce({ changes: 1 });

    expect(() => setArchived('sid-OK', null)).not.toThrow();

    expect(runMock).toHaveBeenCalledWith(null, 'sid-OK');
  });

  it('row missing(.changes === 0)→ throw SessionRowMissingError + name 字段对', () => {
    runMock.mockReturnValue({ changes: 0 }); // 永久 mock(本 it 内多次调用 setArchived,避免 mockOnce 第二次返 undefined)

    expect(() => setArchived('ghost-sid', Date.now())).toThrowError(SessionRowMissingError);

    // 详细断言: instanceof 判别 + name 字段(caller 通过 instanceof OR err.name 判别)
    try {
      setArchived('ghost-sid', Date.now());
      throw new Error('expected SessionRowMissingError but got no throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SessionRowMissingError);
      expect((err as SessionRowMissingError).name).toBe('SessionRowMissingError');
      expect((err as Error).message).toContain('setArchived no-op: session ghost-sid not found');
      expect((err as Error).message).toContain('probe 后 row 被外部删');
    }
  });

  it('row missing 在取消归档路径(ts=null + .changes === 0)→ 同款 throw SessionRowMissingError', () => {
    // 关键: archive + unarchive 共享同一 setter 同款 throw 语义,unarchive race window 也走
    // SessionRowMissingError 路径(IPC SessionUnarchive 端 catch + 静默 / recoverer 端 throw 冒泡)。
    runMock.mockReturnValueOnce({ changes: 0 });

    expect(() => setArchived('ghost-sid', null)).toThrowError(SessionRowMissingError);
  });

  it('防御性: .changes > 1 (理论上不可能,但单点拦截)→ 也 throw (严格 === 1 检查)', () => {
    // sessions.id PRIMARY KEY 保证 .changes <= 1,但 setter 严格 `!== 1` 检查不漏边角
    // (SQL 字段级 trigger / 同 id 多 row 的退化场景 — 极防御但零成本)
    runMock.mockReturnValueOnce({ changes: 2 });

    expect(() => setArchived('weird-sid', 0)).toThrowError(SessionRowMissingError);
  });
});

describe('SessionRowMissingError class', () => {
  it('is instanceof Error + name 字段固定 + message 含 sid', () => {
    const err = new SessionRowMissingError('test-sid');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SessionRowMissingError);
    expect(err.name).toBe('SessionRowMissingError');
    expect(err.message).toContain('test-sid');
  });

  it('caller 链通过 instanceof 判别(典型 caller 链验证模式)', () => {
    // 模拟 baton-cleanup / K3 helper / IPC SessionArchive handler 的 catch 块判别模式
    function classifyError(err: unknown): 'row-missing' | 'archive-throw' {
      return err instanceof SessionRowMissingError ? 'row-missing' : 'archive-throw';
    }

    expect(classifyError(new SessionRowMissingError('x'))).toBe('row-missing');
    expect(classifyError(new Error('FK constraint violation'))).toBe('archive-throw');
    expect(classifyError(new TypeError('unrelated'))).toBe('archive-throw');
    expect(classifyError('string error')).toBe('archive-throw');
  });
});
