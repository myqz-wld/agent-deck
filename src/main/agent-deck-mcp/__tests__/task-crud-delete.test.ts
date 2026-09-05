import { describe, expect, it } from 'vitest';
import {
  mockTaskRepo,
  mockTeamRepo,
  mockEventBus,
  makeCtx,
  makeTaskRecord,
  setupCallerInTeam,
  taskDeleteHandler,
} from './task-crud.fixture';

describe('task_delete — v024 D3 write permission + cascade predicate (HIGH-2)', () => {
  it('personal task + caller == owner + cascade=false → delete 返 [taskId] + emit deleted', async () => {
    mockTaskRepo.get.mockReturnValue(
      makeTaskRecord({ id: 't1', ownerSessionId: 'sess-caller', teamId: null }),
    );
    mockTaskRepo.delete.mockReturnValue(['t1']);

    await taskDeleteHandler({ taskId: 't1' }, makeCtx('sess-caller'));

    expect(mockTaskRepo.delete).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ cascade: false }),
    );
    expect(mockEventBus.emit).toHaveBeenCalledWith(
      'task-changed',
      expect.objectContaining({ kind: 'deleted', taskId: 't1' }),
    );
  });

  it('cascade=true 传 predicate (id, child) 接收完整 task — HIGH-2 修法', async () => {
    setupCallerInTeam('sess-caller', 'team-A');
    mockTaskRepo.get.mockReturnValue(
      makeTaskRecord({ id: 't1', ownerSessionId: 'sess-caller', teamId: 'team-A' }),
    );
    mockTaskRepo.delete.mockReturnValue(['t1', 't2']);

    await taskDeleteHandler({ taskId: 't1', force: true }, makeCtx('sess-caller'));

    const callArgs = mockTaskRepo.delete.mock.calls[0][1];
    expect(callArgs.cascade).toBe(true);
    expect(typeof callArgs.predicate).toBe('function');

    // v024 HIGH-2: predicate 接收 (id, child: Pick<TaskRecord, 'ownerSessionId' | 'teamId'>)
    // team-A child + caller 在 team-A → 允许
    expect(callArgs.predicate('child-1', { ownerSessionId: 'sess-mate', teamId: 'team-A' })).toBe(true);
    // personal child + caller == owner → 允许（personal owner 特例）
    expect(callArgs.predicate('child-2', { ownerSessionId: 'sess-caller', teamId: null })).toBe(true);
    // team-B child + caller 不在 team-B → 不允许
    expect(callArgs.predicate('child-3', { ownerSessionId: 'sess-stranger', teamId: 'team-B' })).toBe(false);
    // personal child + caller != owner → 不允许
    expect(callArgs.predicate('child-4', { ownerSessionId: 'sess-stranger', teamId: null })).toBe(false);
  });

  it('F-D 回归：cascade emit ownerSessionId 用 child 自己 owner 不用 root', async () => {
    setupCallerInTeam('sess-caller', 'team-A');
    // chain: t1(caller team-A) → t2(mate team-A) → t3(mate team-A)
    const root = makeTaskRecord({
      id: 't1',
      ownerSessionId: 'sess-caller',
      teamId: 'team-A',
      blocks: ['t2'],
    });
    const child1 = makeTaskRecord({
      id: 't2',
      ownerSessionId: 'sess-mate',
      teamId: 'team-A',
      blocks: ['t3'],
    });
    const child2 = makeTaskRecord({
      id: 't3',
      ownerSessionId: 'sess-mate',
      teamId: 'team-A',
      blocks: [],
    });
    mockTaskRepo.get.mockImplementation((id: string) => {
      if (id === 't1') return root;
      if (id === 't2') return child1;
      if (id === 't3') return child2;
      return null;
    });
    mockTaskRepo.delete.mockReturnValue(['t1', 't2', 't3']);

    await taskDeleteHandler({ taskId: 't1', force: true }, makeCtx('sess-caller'));

    expect(mockEventBus.emit).toHaveBeenCalledTimes(3);
    const calls = mockEventBus.emit.mock.calls;
    expect(calls[0][1]).toMatchObject({ taskId: 't1', ownerSessionId: 'sess-caller' });
    expect(calls[1][1]).toMatchObject({ taskId: 't2', ownerSessionId: 'sess-mate' });
    expect(calls[2][1]).toMatchObject({ taskId: 't3', ownerSessionId: 'sess-mate' });
  });

  it('cross-team owner → permission denied + 不调 repo.delete', async () => {
    mockTaskRepo.get.mockReturnValue(
      makeTaskRecord({ id: 't1', ownerSessionId: 'sess-stranger', teamId: 'team-B' }),
    );
    // caller 不在 team-B
    mockTeamRepo.findActiveMembershipsBySession.mockReturnValue([]);

    const result = await taskDeleteHandler({ taskId: 't1' }, makeCtx('sess-caller'));

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).hint).toMatch(
      /active member session.*owner session.*task_list/,
    );
    expect(mockTaskRepo.delete).not.toHaveBeenCalled();
  });

  // REVIEW_87 LOW (reviewer-codex + reviewer-claude): handler pre-walk 复用 repo predicate —
  // 越权 child skip 且不展开其下游（与 repo.delete BFS continue 语义对齐）。
  it('LOW: cascade pre-walk 越权 child（跨 team）skip 且不展开下游 grandchild', async () => {
    // caller 在 team-A；chain: t1(caller,team-A) → t2(越权,team-B) → t3(team-B grandchild)
    setupCallerInTeam('sess-caller', 'team-A');
    const root = makeTaskRecord({
      id: 't1',
      ownerSessionId: 'sess-caller',
      teamId: 'team-A',
      blocks: ['t2'],
    });
    const child = makeTaskRecord({
      id: 't2',
      ownerSessionId: 'sess-stranger',
      teamId: 'team-B', // caller 不在 team-B → 越权 child
      blocks: ['t3'],
    });
    const grandchild = makeTaskRecord({ id: 't3', ownerSessionId: 'sess-stranger', teamId: 'team-B' });
    const getCalls: string[] = [];
    mockTaskRepo.get.mockImplementation((id: string) => {
      getCalls.push(id);
      if (id === 't1') return root;
      if (id === 't2') return child;
      if (id === 't3') return grandchild;
      return null;
    });
    mockTaskRepo.delete.mockReturnValue(['t1']); // repo 实际只删 root（越权 child skip）

    await taskDeleteHandler({ taskId: 't1', force: true }, makeCtx('sess-caller'));

    // 关键：pre-walk 读了 t2（判定越权）但**没读 t3**（越权 child skip 不展开下游）。
    // 修前 pre-walk 不跑 predicate → 会 queue.push(t2.blocks) 读 t3（越权子图展开）。
    expect(getCalls).toContain('t2');
    expect(getCalls).not.toContain('t3');
  });
});
