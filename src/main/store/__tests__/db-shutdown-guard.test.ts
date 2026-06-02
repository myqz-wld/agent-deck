/**
 * db.ts shutdown guard 单测（issue shutdown-race-ingest-db-guard）。
 *
 * 验证 `isDbClosed()` 的核心不变量:**区分 init-never vs closed**。
 * - init-never(从未 initDb,dbInstance=null 但 dbClosed=false)→ isDbClosed()===false →
 *   caller 不 drop → getDb() 照常 loud throw,不掩盖「启动顺序漏 initDb」真 bug
 * - closed(显式 closeDb 跑过)→ isDbClosed()===true → 退出期 caller drop 事件
 *
 * **模块单例顺序约束**:db.ts 是 module-level 单例(dbInstance / dbClosed)。vitest 默认 per-file
 * 隔离 → 本文件起始时 db.ts 处 pristine 态(dbInstance=null / dbClosed=false)。本文件内 it 按
 * 书写顺序跑,init-never 断言必须最先(依赖 pristine 态),故置于首个 it。
 *
 * **binding 守门**:init-never / closeDb-sets-flag 两个核心断言不碰真 SQLite(binding-free);
 * 完整生命周期 it 需 initDb 建真 db → bindingAvailable 守门(用错 runtime ABI 时 skip)。
 */
import { afterAll, describe, expect, it } from 'vitest';
import { getDb, initDb, closeDb, isDbClosed } from '../db';
import { bindingAvailable } from './_binding-probe';

describe('db.ts shutdown guard / isDbClosed 区分 init-never vs closed', () => {
  afterAll(() => {
    // 收尾:确保不把 closed 态泄漏给后续(per-file 隔离已兜底,这里显式更稳)。
    closeDb();
  });

  it('init-never: isDbClosed()=false 且 getDb() 仍 loud throw（不掩盖漏 initDb 启动 bug）', () => {
    // 必须最先跑:依赖 db.ts pristine 态(dbInstance=null / dbClosed=false)。
    expect(isDbClosed()).toBe(false);
    expect(() => getDb()).toThrow('Database not initialized');
  });

  it('closeDb() 置 isDbClosed()=true（即便从未 initDb，纯置 flag 不崩；getDb 仍 throw）', () => {
    closeDb();
    expect(isDbClosed()).toBe(true);
    // closed != inited:dbInstance 仍 null → getDb 仍 throw（caller 应靠 isDbClosed 早返,不靠 getDb）。
    expect(() => getDb()).toThrow('Database not initialized');
  });

  it.skipIf(!bindingAvailable)(
    'initDb 复位 isDbClosed()=false → getDb 命中 → closeDb 再置 true（完整生命周期）',
    () => {
      // 上一个 it 已把 dbClosed 置 true;initDb 应复位回 false（区分「关闭后重开」语义）。
      const db = initDb();
      expect(isDbClosed()).toBe(false);
      expect(getDb()).toBe(db);

      closeDb();
      expect(isDbClosed()).toBe(true);
      expect(() => getDb()).toThrow('Database not initialized');
    },
  );
});
