/** Session-store revisions, merge, composer lifecycle, and bounded summary regressions. */
import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent, PermissionRequest, SessionRecord, SummaryRecord } from '@shared/types';
import { APPEND_AGGREGATED_OUTPUT } from '@shared/agent-event-merge';
import {
  attachmentInputs,
  imageAttachmentSidecarStats,
  resetImageAttachmentSidecarForTests,
  storeAttachmentPayload,
} from '@renderer/hooks/image-attachments/payload-sidecar';
import type { UploadedAttachmentEntry } from '@renderer/hooks/image-attachments/types';
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
  resetImageAttachmentSidecarForTests();
  useSessionStore.setState({
    sessions: new Map(),
    selectedSessionId: null,
    recentEventsBySession: new Map(),
    summariesBySession: new Map(),
    latestSummaryBySession: new Map(),
    pendingPermissionsBySession: new Map(),
    pendingAskQuestionsBySession: new Map(),
    pendingExitPlanModesBySession: new Map(),
    pendingDiffReviewsBySession: new Map(),
    sessionRevision: 0,
    eventRevisionsBySession: new Map(),
    summaryRevisionsBySession: new Map(),
    pendingRevisionsBySession: new Map(),
    composerBySession: new Map(),
    composerAliases: new Map(),
    composerRequestSequence: 0,
  });
});

describe('pending snapshot replacement and live revisions', () => {
  it('uses a stable full snapshot as the authority and does not advance the live revision', () => {
    const { pushEvent, setPendingRequestsAll } = useSessionStore.getState();
    pushEvent(makeEvent('sid-1', 'waiting-for-user', makePerm('r-live')));
    const revisionBeforeSnapshot = useSessionStore
      .getState()
      .pendingRevisionsBySession.get('sid-1');

    setPendingRequestsAll({
      'sid-2': { permissions: [makePerm('r-snap')], askQuestions: [], exitPlanModes: [] },
    });
    const state = useSessionStore.getState();
    expect(state.pendingPermissionsBySession.has('sid-1')).toBe(false);
    expect(state.pendingPermissionsBySession.get('sid-2')?.map((r) => r.requestId)).toEqual([
      'r-snap',
    ]);
    expect(state.pendingRevisionsBySession.get('sid-1')).toBe(revisionBeforeSnapshot);
  });

  it('advances event and pending revisions for a waiting event, then again on resolution', () => {
    const { pushEvent } = useSessionStore.getState();
    pushEvent(makeEvent('sid-1', 'waiting-for-user', makePerm('r-live')));
    expect(useSessionStore.getState().eventRevisionsBySession.get('sid-1')).toBe(1);
    expect(useSessionStore.getState().pendingRevisionsBySession.get('sid-1')).toBe(1);

    useSessionStore.getState().resolvePermission('sid-1', 'r-live');
    expect(useSessionStore.getState().pendingRevisionsBySession.get('sid-1')).toBe(2);
  });
});

describe('latest summary snapshot', () => {
  it('advances the summary revision only for a live summary push', () => {
    useSessionStore.getState().pushSummary({
      id: 1,
      sessionId: 'sid-live',
      content: 'fresh',
      trigger: 'time',
      ts: 2,
    } as SummaryRecord);
    expect(useSessionStore.getState().summaryRevisionsBySession.get('sid-live')).toBe(1);

    useSessionStore.getState().setSummaries('sid-live', []);
    expect(useSessionStore.getState().summaryRevisionsBySession.get('sid-live')).toBe(1);
  });

  it('does not create an orphan when a session disappears before the IPC response', () => {
    useSessionStore.getState().setSessions([makeSession('sid-live')]);
    useSessionStore.getState().setLatestSummaries({
      'sid-gone': {
        id: 1,
        sessionId: 'sid-gone',
        content: 'stale',
        trigger: 'time',
        ts: 1,
      } as SummaryRecord,
    });
    expect(useSessionStore.getState().latestSummaryBySession.has('sid-gone')).toBe(false);
  });

  it('bounds and deduplicates snapshots and live summaries by stable id', () => {
    const summaries = Array.from({ length: 60 }, (_, index) => ({
      id: index,
      sessionId: 'sid-live',
      content: `summary-${index}`,
      trigger: 'time',
      ts: index,
    })) as SummaryRecord[];
    useSessionStore.getState().setSummaries('sid-live', [
      ...summaries,
      { ...summaries[40]!, content: 'duplicate-old', ts: 1 },
    ]);
    let stored = useSessionStore.getState().summariesBySession.get('sid-live')!;
    expect(stored).toHaveLength(50);
    expect(new Set(stored.map((summary) => summary.id)).size).toBe(50);
    expect(stored[0]?.id).toBe(59);

    useSessionStore.getState().pushSummary({
      ...summaries[59]!,
      content: 'live replacement',
      ts: 100,
    });
    stored = useSessionStore.getState().summariesBySession.get('sid-live')!;
    expect(stored).toHaveLength(50);
    expect(stored.filter((summary) => summary.id === 59)).toHaveLength(1);
    expect(stored[0]?.content).toBe('live replacement');
  });
});

describe('renameSession merges by-session state', () => {
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
    // Both buckets remain complete and newest-first.
    expect(events?.map((e) => (e.payload as { text: string }).text)).toEqual(['new-1', 'old-2', 'old-1']);
    expect(useSessionStore.getState().recentEventsBySession.has('OLD')).toBe(false);
  });

  it('keeps the target newest event when the source already fills RECENT_LIMIT', () => {
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
    // Sort before truncation so the target's newest event remains visible.
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

  it('deduplicates summaries by id and rewrites their logical session on rename', () => {
    const old = {
      id: 1,
      sessionId: 'OLD',
      content: 'old',
      trigger: 'time',
      ts: 1,
    } as SummaryRecord;
    useSessionStore.setState({
      sessions: new Map([['OLD', makeSession('OLD')]]),
      summariesBySession: new Map([
        ['OLD', [old]],
        ['NEW', [{ ...old, sessionId: 'NEW', content: 'newer', ts: 2 }]],
      ]),
    });
    useSessionStore.getState().renameSession('OLD', 'NEW');
    expect(useSessionStore.getState().summariesBySession.get('NEW')).toEqual([
      expect.objectContaining({ id: 1, sessionId: 'NEW', content: 'newer' }),
    ]);
  });
});

function attachment(id: string): UploadedAttachmentEntry {
  return {
    id,
    thumbnailDataUrl: 'data:image/gif;base64,small',
    mime: 'image/png',
    bytes: 3,
  };
}

describe('logical composer lifecycle', () => {
  it('merges temp into real exactly once and keeps both attachment payloads addressable', () => {
    const state = useSessionStore.getState();
    state.ensureComposerSession('TEMP');
    state.ensureComposerSession('REAL');
    state.updateComposer('TEMP', (current) => ({
      ...current,
      text: 'temporary draft',
      attachments: [attachment('temp-image')],
    }));
    state.updateComposer('REAL', (current) => ({
      ...current,
      text: 'newer real draft',
      attachments: [attachment('real-image')],
    }));
    storeAttachmentPayload('TEMP', 'temp-image', {
      base64: 'dGVtcA==',
      mime: 'image/png',
      bytes: 4,
    });
    storeAttachmentPayload('REAL', 'real-image', {
      base64: 'cmVhbA==',
      mime: 'image/png',
      bytes: 4,
    });

    state.renameSession('TEMP', 'REAL');
    state.renameSession('TEMP', 'REAL');
    const composer = useSessionStore.getState().composerBySession.get('REAL')!;
    expect(composer.text).toBe('newer real draft');
    expect(composer.attachments.map((item) => item.id)).toEqual([
      'real-image',
      'temp-image',
    ]);
    expect(attachmentInputs('REAL', composer.attachments)).toHaveLength(2);
    expect(imageAttachmentSidecarStats().payloads).toBe(2);
  });

  it('routes an in-flight completion through a temp-to-real alias', () => {
    const state = useSessionStore.getState();
    state.ensureComposerSession('TEMP');
    const generation = state.beginComposerRequest('TEMP', 'session-mode');
    expect(generation).not.toBeNull();
    state.renameSession('TEMP', 'REAL');
    expect(state.completeComposerRequest(
      'TEMP',
      'session-mode',
      generation!,
      (current) => ({ ...current, sessionModeError: 'origin result' }),
    )).toBe(true);
    expect(useSessionStore.getState().composerBySession.get('REAL')).toMatchObject({
      sessionModeError: 'origin result',
      requests: { 'session-mode': { busy: false } },
    });
  });

  it('preserves a newer draft when an older optimistic send fails', () => {
    const state = useSessionStore.getState();
    state.ensureComposerSession('A');
    state.updateComposer('A', (current) => ({ ...current, text: 'older draft' }));
    const generation = state.beginComposerRequest('A', 'send', (current) => ({
      ...current,
      text: '',
    }))!;
    state.updateComposer('A', (current) => ({ ...current, text: 'newer draft' }));
    state.restoreFailedComposerSend('A', generation, 'older draft', [], 'send failed');
    expect(useSessionStore.getState().composerBySession.get('A')).toMatchObject({
      text: 'newer draft',
      sendError: 'send failed',
      requests: { send: { busy: false } },
    });
  });

  it('ignores a stale send failure after a newer send generation starts', () => {
    const state = useSessionStore.getState();
    state.ensureComposerSession('A');
    const olderGeneration = state.beginComposerRequest('A', 'send')!;
    state.completeComposerRequest('A', 'send', olderGeneration);
    const newerGeneration = state.beginComposerRequest('A', 'send')!;

    expect(state.restoreFailedComposerSend(
      'A',
      olderGeneration,
      'stale text',
      [attachment('stale-image')],
      'stale failure',
    )).toBe(false);
    expect(useSessionStore.getState().composerBySession.get('A')).toMatchObject({
      text: '',
      attachments: [],
      sendError: null,
      requests: { send: { generation: newerGeneration, busy: true } },
    });
  });

  it('releases composer descriptors and payloads on remove and snapshot prune', () => {
    const state = useSessionStore.getState();
    state.ensureComposerSession('REMOVE');
    storeAttachmentPayload('REMOVE', 'remove-image', {
      base64: 'cmVtb3Zl',
      mime: 'image/png',
      bytes: 6,
    });
    state.removeSession('REMOVE');
    expect(imageAttachmentSidecarStats().payloads).toBe(0);

    state.ensureComposerSession('PRUNE');
    storeAttachmentPayload('PRUNE', 'prune-image', {
      base64: 'cHJ1bmU=',
      mime: 'image/png',
      bytes: 5,
    });
    state.setSessions([makeSession('KEEP')]);
    expect(useSessionStore.getState().composerBySession.has('PRUNE')).toBe(false);
    expect(imageAttachmentSidecarStats().payloads).toBe(0);
  });
});

describe('pushEvent cancellation deletes empty request buckets', () => {
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
