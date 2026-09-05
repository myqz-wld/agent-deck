import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import type { TaskRepo } from '../task-repo';
import { bindingAvailable, makeMemoryRepo, insertSession, insertTeam } from './task-repo.fixture';

describe.skipIf(!bindingAvailable)('task-repo / handoff ownership transfer', () => {
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

describe.skipIf(!bindingAvailable)('task-repo v024 / handoff preserves team ownership', () => {
  let db: Database.Database;
  let repo: TaskRepo;
  let sid: string;
  beforeEach(() => {
    ({ db, repo, sid } = makeMemoryRepo());
  });
  afterEach(() => db.close());



  it("'preserve-team' → UPDATE owner 不动 team_id（team-bound 保留）", () => {
    insertSession(db, 'sess-new');
    insertTeam(db, 'team-A');
    const tTeam = repo.create({ subject: 'T-team', ownerSessionId: sid, teamId: 'team-A' });
    const tPersonal = repo.create({ subject: 'T-personal', ownerSessionId: sid });

    const changed = repo.reassignOwner(sid, 'sess-new');

    expect(changed).toBe(2);
    const aTeam = repo.get(tTeam.id);
    const aPersonal = repo.get(tPersonal.id);
    expect(aTeam?.ownerSessionId).toBe('sess-new');
    expect(aTeam?.teamId).toBe('team-A'); // 关键：team_id 保留
    expect(aPersonal?.ownerSessionId).toBe('sess-new');
    expect(aPersonal?.teamId).toBeNull(); // 还是 null
  });
});
