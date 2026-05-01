/**
 * SessionManager.delete + 删除窗口黑名单单测（REVIEW_4 H1）。
 *
 * 拆分自 manager.test.ts (CHANGELOG_52 Step 1)。本文件保留原 delete describe 内的 3 个 it，
 * 含 setSessionCloseFn 注入 + closeCalls 跟踪。
 *
 * 共享 mock setup 见 manager-test-setup.ts；vi.mock 调用必须在本文件顶部（hoist 约束）。
 *
 * 关键 invariant：sessionManager.delete 后 60s 黑名单内**任意 source** 尾包都丢弃，
 * 防止 SDK 流终止 / hook 通道迟到事件复活幽灵 record。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '@shared/types';
import {
  makeEvent,
  makeEventBusMock,
  makeEventRepoMock,
  makeFileChangeRepoMock,
  makeSessionRepoMock,
  mockEmits,
  mockEvents,
  mockSessions,
  resetMocks,
} from './manager-test-setup';

vi.mock('@main/store/session-repo', () => ({ sessionRepo: makeSessionRepoMock() }));
vi.mock('@main/store/event-repo', () => ({ eventRepo: makeEventRepoMock() }));
vi.mock('@main/store/file-change-repo', () => ({ fileChangeRepo: makeFileChangeRepoMock() }));
vi.mock('@main/event-bus', () => ({ eventBus: makeEventBusMock() }));

import { sessionManager, setSessionCloseFn } from '@main/session/manager';

beforeEach(async () => {
  await resetMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SessionManager.delete + H1 删除后尾包不复活幽灵（REVIEW_4 H1）', () => {
  let closeCalls: string[] = [];

  beforeEach(() => {
    closeCalls = [];
    setSessionCloseFn(async (_agentId, sid) => {
      closeCalls.push(sid);
    });
  });

  afterEach(() => {
    setSessionCloseFn(null);
  });

  it('delete() await close 完成 + 删 DB 行 + 广播 session-removed', async () => {
    const ev = makeEvent({
      sessionId: 'sess-del-1',
      source: 'sdk',
      kind: 'session-start',
      payload: { cwd: '/tmp' },
    });
    sessionManager.ingest(ev);
    expect(mockSessions.has('sess-del-1')).toBe(true);

    await sessionManager.delete('sess-del-1');

    expect(closeCalls).toContain('sess-del-1');
    expect(mockSessions.has('sess-del-1')).toBe(false);
    expect(mockEmits.some((e) => e.name === 'session-removed' && e.payload === 'sess-del-1')).toBe(
      true,
    );
  });

  it('删除窗口内（60s）尾包 finished:interrupted 被丢弃，不创建幽灵 record', async () => {
    const ev = makeEvent({
      sessionId: 'sess-ghost',
      source: 'sdk',
      kind: 'session-start',
      payload: { cwd: '/tmp' },
    });
    sessionManager.ingest(ev);
    await sessionManager.delete('sess-ghost');
    expect(mockSessions.has('sess-ghost')).toBe(false);

    // 在 tail ingest 之前 snapshot：之前 ingest 创建 record + delete 都会 emit，
    // 黑名单要保证「**这一次** ingest 之后不再出现新增 upserted/agent-event」。
    const eventsBefore = mockEvents.length;
    const upsertBefore = mockEmits.filter(
      (e) =>
        e.name === 'session-upserted' && (e.payload as SessionRecord)?.id === 'sess-ghost',
    ).length;
    const agentEventBefore = mockEmits.filter((e) => e.name === 'agent-event').length;

    // 模拟 SDK 流终止时的尾包：closeSession abort 后 catch 路径如果**没有** intentionallyClosed
    // 屏蔽，会走到这里——manager 黑名单兜底必须丢弃。
    const tailFinished = makeEvent({
      sessionId: 'sess-ghost',
      source: 'sdk',
      kind: 'finished',
      payload: { ok: false, subtype: 'interrupted' },
    });
    sessionManager.ingest(tailFinished);

    // 关键断言：DB 行没复活、events 表没新增、广播总数没增加（黑名单在 ingest 入口拦下）
    expect(mockSessions.has('sess-ghost')).toBe(false);
    expect(mockEvents.length).toBe(eventsBefore);
    expect(
      mockEmits.filter(
        (e) =>
          e.name === 'session-upserted' && (e.payload as SessionRecord)?.id === 'sess-ghost',
      ).length,
    ).toBe(upsertBefore);
    expect(mockEmits.filter((e) => e.name === 'agent-event').length).toBe(agentEventBefore);
  });

  it('删除窗口内任意 source 尾包都丢弃（防 hook 通道也复活）', async () => {
    const ev = makeEvent({
      sessionId: 'sess-ghost-hook',
      source: 'hook',
      kind: 'session-start',
      payload: { cwd: '/tmp' },
    });
    sessionManager.ingest(ev);
    await sessionManager.delete('sess-ghost-hook');

    const eventsBefore = mockEvents.length;
    const lateHook = makeEvent({
      sessionId: 'sess-ghost-hook',
      source: 'hook',
      kind: 'message',
      payload: { text: 'late hook tail' },
    });
    sessionManager.ingest(lateHook);

    expect(mockSessions.has('sess-ghost-hook')).toBe(false);
    expect(mockEvents.length).toBe(eventsBefore);
  });
});
