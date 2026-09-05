import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import type { TaskRepo } from '../task-repo';
import { bindingAvailable, makeMemoryRepo, insertSession, insertTeam } from './task-repo.fixture';

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
