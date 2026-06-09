/**
 * session-store 纯逻辑单测（deep-review H2 回归兜底）。
 *
 * 覆盖本批 fix：
 * - setPendingRequestsAll **merge**（非整表替换）：启动快照 IPC 在途期间 live event 新增的 pending 不被抹掉（防 SDK 死锁）。
 * - renameSession **merge** by-session Map（非 toId 存在则丢 fromId）：fromId 历史 events/summaries/pending 保留。
 * - pushEvent cancel 分支 delete-on-empty（与 resolve* / setPendingRequests 对齐）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent, PermissionRequest, SessionRecord } from '@shared/types';
import { APPEND_AGGREGATED_OUTPUT } from '@shared/agent-event-merge';
import { useSessionStore } from '../session-store';

function makePerm(requestId: string): PermissionRequest {
  return {
    type: 'permission-request',
    requestId,
    toolName: 'Bash',
    toolInput: {},
    input: {},
  } as unknown as PermissionRequest;
}

function makeEvent(sessionId: string, kind: AgentEvent['kind'], payload: unknown, ts = 1000): AgentEvent {
  return { sessionId, kind, payload, ts, source: 'sdk' } as unknown as AgentEvent;
}

function makeSession(id: string): SessionRecord {
  return {
    id,
    adapter: 'claude-code',
    cwd: '/x',
    title: id,
    lifecycle: 'active',
    activity: 'idle',
    createdAt: 1,
    updatedAt: 1,
  } as unknown as SessionRecord;
}

beforeEach(() => {
  useSessionStore.setState({
    sessions: new Map(),
    selectedSessionId: null,
    recentEventsBySession: new Map(),
    summariesBySession: new Map(),
    latestSummaryBySession: new Map(),
    pendingPermissionsBySession: new Map(),
    pendingAskQuestionsBySession: new Map(),
    pendingExitPlanModesBySession: new Map(),
  });
});

describe('setPendingRequestsAll — merge 非整表替换（deep-review H2 MED）', () => {
  it('启动快照 merge 进现有 pending（live event 先到的 request 不被抹掉）', () => {
    const { pushEvent, setPendingRequestsAll } = useSessionStore.getState();
    // t1: live waiting-for-user event 先到，加 r-live 到 sid-1
    pushEvent(makeEvent('sid-1', 'waiting-for-user', makePerm('r-live')));
    expect(useSessionStore.getState().pendingPermissionsBySession.get('sid-1')).toHaveLength(1);
    // t2: 慢启动快照 resolve，快照不含 sid-1 的 r-live（只含 sid-2 的 r-snap）
    setPendingRequestsAll({
      'sid-2': { permissions: [makePerm('r-snap')], askQuestions: [], exitPlanModes: [] },
    });
    const m = useSessionStore.getState().pendingPermissionsBySession;
    expect(m.get('sid-1')?.map((r) => r.requestId)).toEqual(['r-live']); // live 保留，没被抹掉
    expect(m.get('sid-2')?.map((r) => r.requestId)).toEqual(['r-snap']); // 快照补全
  });

  it('同 sid union by requestId（快照补 live 没有的，不重复）', () => {
    const { pushEvent, setPendingRequestsAll } = useSessionStore.getState();
    pushEvent(makeEvent('sid-1', 'waiting-for-user', makePerm('r-live')));
    setPendingRequestsAll({
      'sid-1': { permissions: [makePerm('r-live'), makePerm('r-snap')], askQuestions: [], exitPlanModes: [] },
    });
    const list = useSessionStore.getState().pendingPermissionsBySession.get('sid-1');
    expect(list?.map((r) => r.requestId).sort()).toEqual(['r-live', 'r-snap']); // 不重复 r-live
  });
});

describe('renameSession — merge by-session Map（deep-review H2 MED）', () => {
  it('toId 已有少量 events 时，fromId 历史 events 不被丢弃（按 ts DESC 合并）', () => {
    useSessionStore.setState({
      sessions: new Map([['OLD', makeSession('OLD')]]),
      recentEventsBySession: new Map([
        ['OLD', [makeEvent('OLD', 'message', { text: 'old-2' }, 2), makeEvent('OLD', 'message', { text: 'old-1' }, 1)]],
        ['NEW', [makeEvent('NEW', 'message', { text: 'new-1' }, 3)]],
      ]),
    });
    useSessionStore.getState().renameSession('OLD', 'NEW');
    const events = useSessionStore.getState().recentEventsBySession.get('NEW');
    // OLD 两条 + NEW 一条全保留，按 ts DESC 排序（newest-first）——deep-review H2 R2 LOW：
    // 不是「旧在前」（那对 DESC 数组倒序），而是按 ts 排序保 newest-first。
    expect(events?.map((e) => (e.payload as { text: string }).text)).toEqual(['new-1', 'old-2', 'old-1']);
    expect(useSessionStore.getState().recentEventsBySession.has('OLD')).toBe(false);
  });

  it('fromId 满 RECENT_LIMIT 时 toId 最新事件不被 slice 截掉（deep-review H2 R2 LOW）', () => {
    // fromId 200 条旧事件（ts 1..200）+ toId 1 条最新事件（ts 9999）
    const oldEvents = Array.from({ length: 200 }, (_, i) =>
      makeEvent('OLD', 'message', { text: `old-${i}` }, i + 1),
    );
    useSessionStore.setState({
      sessions: new Map([['OLD', makeSession('OLD')]]),
      recentEventsBySession: new Map([
        ['OLD', oldEvents],
        ['NEW', [makeEvent('NEW', 'message', { text: 'newest' }, 9999)]],
      ]),
    });
    useSessionStore.getState().renameSession('OLD', 'NEW');
    const events = useSessionStore.getState().recentEventsBySession.get('NEW');
    // sort by ts DESC 后 slice → 最新的 'newest'(ts 9999) 在首位不被截掉（旧实现 concat 旧在前 +
    // slice 会把 toId 最新事件全丢）。
    expect(events?.[0]).toMatchObject({ payload: { text: 'newest' } });
    expect(events).toHaveLength(200); // RECENT_LIMIT
  });

  it('toId 不存在时直接迁移 fromId（常规 fork 路径）', () => {
    useSessionStore.setState({
      sessions: new Map([['OLD', makeSession('OLD')]]),
      pendingPermissionsBySession: new Map([['OLD', [makePerm('r1')]]]),
    });
    useSessionStore.getState().renameSession('OLD', 'NEW');
    const m = useSessionStore.getState().pendingPermissionsBySession;
    expect(m.get('NEW')?.map((r) => r.requestId)).toEqual(['r1']);
    expect(m.has('OLD')).toBe(false);
  });

  it('pending union by requestId（fromId + toId 合并去重）', () => {
    useSessionStore.setState({
      sessions: new Map([['OLD', makeSession('OLD')]]),
      pendingPermissionsBySession: new Map([
        ['OLD', [makePerm('r-old')]],
        ['NEW', [makePerm('r-new')]],
      ]),
    });
    useSessionStore.getState().renameSession('OLD', 'NEW');
    const list = useSessionStore.getState().pendingPermissionsBySession.get('NEW');
    expect(list?.map((r) => r.requestId).sort()).toEqual(['r-new', 'r-old']);
  });
});

describe('pushEvent cancel 分支 delete-on-empty（deep-review H2 LOW）', () => {
  it('cancel 掉最后一条 pending 后 delete key（不留空数组）', () => {
    const { pushEvent } = useSessionStore.getState();
    pushEvent(makeEvent('sid-1', 'waiting-for-user', makePerm('r1')));
    expect(useSessionStore.getState().pendingPermissionsBySession.has('sid-1')).toBe(true);
    // cancel r1
    pushEvent(makeEvent('sid-1', 'waiting-for-user', { type: 'permission-cancelled', requestId: 'r1' }));
    // key 被删除（不是留 []）—— 与 resolvePermission/setPendingRequests 对齐
    expect(useSessionStore.getState().pendingPermissionsBySession.has('sid-1')).toBe(false);
  });

  it('cancel 一条但还剩其他 pending 时保留 key', () => {
    const { pushEvent } = useSessionStore.getState();
    pushEvent(makeEvent('sid-1', 'waiting-for-user', makePerm('r1')));
    pushEvent(makeEvent('sid-1', 'waiting-for-user', makePerm('r2')));
    pushEvent(makeEvent('sid-1', 'waiting-for-user', { type: 'permission-cancelled', requestId: 'r1' }));
    expect(useSessionStore.getState().pendingPermissionsBySession.get('sid-1')?.map((r) => r.requestId)).toEqual(['r2']);
  });
});

describe('tool-use-start merge — preserve command identity during output deltas', () => {
  it('pushEvent keeps the original Bash command while appending app-server output deltas', () => {
    const { pushEvent } = useSessionStore.getState();
    pushEvent(
      makeEvent(
        'sid-1',
        'tool-use-start',
        { toolUseId: 'cmd-1', toolName: 'Bash', toolInput: { command: 'rg foo src' } },
        1,
      ),
    );
    pushEvent(
      makeEvent(
        'sid-1',
        'tool-use-start',
        {
          toolUseId: 'cmd-1',
          toolName: 'Bash',
          aggregatedOutput: 'src/a.ts\n',
          [APPEND_AGGREGATED_OUTPUT]: true,
          status: 'inProgress',
        },
        2,
      ),
    );
    pushEvent(
      makeEvent(
        'sid-1',
        'tool-use-start',
        {
          toolUseId: 'cmd-1',
          toolName: 'Bash',
          aggregatedOutput: 'src/b.ts\n',
          [APPEND_AGGREGATED_OUTPUT]: true,
          status: 'inProgress',
        },
        3,
      ),
    );

    const events = useSessionStore.getState().recentEventsBySession.get('sid-1');
    expect(events).toHaveLength(1);
    expect(events?.[0].payload).toEqual({
      toolUseId: 'cmd-1',
      toolName: 'Bash',
      toolInput: { command: 'rg foo src' },
      aggregatedOutput: 'src/a.ts\nsrc/b.ts\n',
      status: 'inProgress',
    });
  });

  it('setRecentEvents merges duplicate history rows so latest progress still has the original command', () => {
    useSessionStore.getState().setRecentEvents('sid-1', [
      makeEvent(
        'sid-1',
        'tool-use-start',
        {
          toolUseId: 'cmd-1',
          toolName: 'Bash',
          aggregatedOutput: 'src/b.ts\n',
          [APPEND_AGGREGATED_OUTPUT]: true,
          status: 'inProgress',
        },
        3,
      ),
      makeEvent(
        'sid-1',
        'tool-use-start',
        {
          toolUseId: 'cmd-1',
          toolName: 'Bash',
          aggregatedOutput: 'src/a.ts\n',
          [APPEND_AGGREGATED_OUTPUT]: true,
          status: 'inProgress',
        },
        2,
      ),
      makeEvent(
        'sid-1',
        'tool-use-start',
        { toolUseId: 'cmd-1', toolName: 'Bash', toolInput: { command: 'rg foo src' } },
        1,
      ),
    ]);

    const events = useSessionStore.getState().recentEventsBySession.get('sid-1');
    expect(events).toHaveLength(1);
    expect(events?.[0].ts).toBe(3);
    expect(events?.[0].payload).toEqual({
      toolUseId: 'cmd-1',
      toolName: 'Bash',
      toolInput: { command: 'rg foo src' },
      aggregatedOutput: 'src/b.ts\n',
      status: 'inProgress',
    });
  });
});
