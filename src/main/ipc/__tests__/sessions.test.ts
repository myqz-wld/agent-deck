/**
 * sessions.ts hand-off dedup / archive / compact-preview tests.
 *
 * 关键验证：
 * - H7: dedupHandOff 必须按 sourceSid 单飞 — 同 sid 并发只起一次 work；不同 sid
 *   彼此独立；resolve / reject 后 entry 自动清，下次同 sid 仍可正常起。
 *
 * Helper cases import sessions-hand-off-helper directly; compact-preview cases register only the
 * target sessions IPC handler against the test Electron shim.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ipcMain } from 'electron';
import log from 'electron-log/main';
import { IpcInvoke } from '@shared/ipc-channels';

// Step 3.3.4 console.warn → logger.warn migrate 后, sessions-hand-off-helper.ts 用
// log.scope('ipc-sessions-handoff').warn. 测试改 spy 同 name cached vi.fn() object
// (vitest-setup.ts mock 让 log.scope() 返 cached vi.fn() object 同 name 同一个 obj).
const handoffLogger = log.scope('ipc-sessions-handoff');

import {
  dedupHandOff,
  handOffInflight,
  archiveSourceSessionWithEmit,
} from '../sessions-hand-off-helper';
import type { SessionRecord } from '@shared/types';
import { SessionRowMissingError } from '@main/store/session-repo';
import { sessionRepo } from '@main/store/session-repo';
import { eventRepo } from '@main/store/event-repo';
import { settingsStore } from '@main/store/settings-store';
import { adapterRegistry } from '@main/adapters/registry';
import { registerSessionsIpc } from '../sessions';
import { DEFAULT_HAND_OFF_CONTINUATION_INSTRUCTION } from '@main/session/hand-off/context-prompt';
import type { AgentEvent } from '@shared/types';

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'sid-1',
    agentId: 'claude-code',
    cwd: '/Users/test/project',
    title: 'fake',
    source: 'sdk',
    lifecycle: 'active',
    activity: 'idle',
    startedAt: 0,
    lastEventAt: 0,
    endedAt: null,
    archivedAt: null,
    spawnedBy: null,
    spawnDepth: 0,
    ...overrides,
  } as SessionRecord;
}

describe('dedupHandOff — REVIEW_33 H7 inflight Map 单飞', () => {
  beforeEach(() => {
    handOffInflight.clear();
  });

  it('同 sid 并发：只起一次 work，两个 caller 拿同 newSid', async () => {
    let workCallCount = 0;
    const work = vi.fn(async () => {
      workCallCount++;
      // 模拟真实 createSession：异步几个 tick
      await new Promise((r) => setTimeout(r, 10));
      return 'new-sid-1';
    });

    // 并发触发两次（模拟双击 race / 双 IPC 同时入 handler）
    const [a, b] = await Promise.all([
      dedupHandOff('source-sid-1', work),
      dedupHandOff('source-sid-1', work),
    ]);

    expect(a).toBe('new-sid-1');
    expect(b).toBe('new-sid-1');
    expect(workCallCount).toBe(1); // 只起一次！
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('同 sid 三连击：仍只起一次 work', async () => {
    let workCallCount = 0;
    const work = async () => {
      workCallCount++;
      await new Promise((r) => setTimeout(r, 10));
      return 'new-sid-2';
    };

    const [a, b, c] = await Promise.all([
      dedupHandOff('source-sid-2', work),
      dedupHandOff('source-sid-2', work),
      dedupHandOff('source-sid-2', work),
    ]);

    expect(a).toBe('new-sid-2');
    expect(b).toBe('new-sid-2');
    expect(c).toBe('new-sid-2');
    expect(workCallCount).toBe(1);
  });

  it('不同 sid 并发：彼此独立，各起各的 work', async () => {
    let workACalls = 0;
    let workBCalls = 0;
    const workA = async () => {
      workACalls++;
      await new Promise((r) => setTimeout(r, 5));
      return 'new-A';
    };
    const workB = async () => {
      workBCalls++;
      await new Promise((r) => setTimeout(r, 5));
      return 'new-B';
    };

    const [a, b] = await Promise.all([
      dedupHandOff('sid-A', workA),
      dedupHandOff('sid-B', workB),
    ]);

    expect(a).toBe('new-A');
    expect(b).toBe('new-B');
    expect(workACalls).toBe(1);
    expect(workBCalls).toBe(1);
  });

  it('resolve 后 entry 自动清：下次同 sid 可以正常起新 hand-off', async () => {
    const work1 = async () => 'first-call';
    const work2 = async () => 'second-call';

    const r1 = await dedupHandOff('sid-1', work1);
    expect(r1).toBe('first-call');
    expect(handOffInflight.has('sid-1')).toBe(false); // resolve 后清

    // 下一次调用走新 work（不复用上次的 'first-call'）
    const r2 = await dedupHandOff('sid-1', work2);
    expect(r2).toBe('second-call');
  });

  it('reject 后 entry 自动清：下次同 sid 可以正常重试', async () => {
    const errorWork = async () => {
      throw new Error('createSession failed');
    };
    const successWork = async () => 'success';

    await expect(dedupHandOff('sid-fail', errorWork)).rejects.toThrow('createSession failed');
    expect(handOffInflight.has('sid-fail')).toBe(false); // reject 后也要清！

    // 重试走新 work，成功
    const r = await dedupHandOff('sid-fail', successWork);
    expect(r).toBe('success');
  });

  it('reject 时并发 caller 都拿到 same error', async () => {
    let workCallCount = 0;
    const work = async () => {
      workCallCount++;
      await new Promise((r) => setTimeout(r, 10));
      throw new Error('shared failure');
    };

    const [a, b] = await Promise.allSettled([
      dedupHandOff('sid-rej', work),
      dedupHandOff('sid-rej', work),
    ]);

    expect(a.status).toBe('rejected');
    expect(b.status).toBe('rejected');
    expect((a as PromiseRejectedResult).reason.message).toBe('shared failure');
    expect((b as PromiseRejectedResult).reason.message).toBe('shared failure');
    expect(workCallCount).toBe(1); // 仍只起一次
  });

  it('strict equal 保护：第一个 Promise resolve 时不误删第二个 Promise 的 entry', async () => {
    // edge case：dedupHandOff 内 finally 用 strict equal 守门防止误删别人的 entry
    let resolveFirst: ((v: string) => void) | null = null;
    const firstWork = () => new Promise<string>((res) => { resolveFirst = res; });

    // 第一次调用，注册 entry
    const p1 = dedupHandOff('shared-sid', firstWork);
    expect(handOffInflight.has('shared-sid')).toBe(true);

    // 模拟手动 mutate（罕见 race 假设：第二次 set 覆盖了第一个的 entry，虽然实际
    // dedupHandOff 不会进 work 第二次，但单测验证 finally 守门正确）
    const replacementPromise = Promise.resolve('replacement');
    handOffInflight.set('shared-sid', replacementPromise);

    // resolve 第一个 Promise → finally 应当**不删** entry（因为 entry 不再是 p1）
    resolveFirst!('first-resolved');
    await p1;
    expect(handOffInflight.get('shared-sid')).toBe(replacementPromise); // 第二个 entry 仍在

    handOffInflight.delete('shared-sid'); // cleanup
  });
});

describe('archiveSourceSessionWithEmit — archive-failure-ux-upthrow-20260515 plan', () => {
  /** 构造 fake row(测试不在乎字段细节,只在乎 truthy/null) */
  function fakeRow() {
    return { id: 'fake', archivedAt: null } as unknown;
  }

  it('archive ok → emitArchiveFailed 不被调用(happy path 不误打扰)', async () => {
    const archiveFn = vi.fn(async (_sid: string) => undefined);
    const getFn = vi.fn(() => fakeRow());
    const emitFn = vi.fn();

    await archiveSourceSessionWithEmit('source-sid', {
      archive: archiveFn,
      getSession: getFn,
      emitArchiveFailed: emitFn,
    });

    expect(getFn).toHaveBeenCalledTimes(1);
    expect(getFn).toHaveBeenCalledWith('source-sid');
    expect(archiveFn).toHaveBeenCalledTimes(1);
    expect(archiveFn).toHaveBeenCalledWith('source-sid');
    expect(emitFn).not.toHaveBeenCalled();
  });

  it('archive 抛 generic Error (非 SessionRowMissingError) → emit archive-throw + reason 含 Error message + 不抛 (by design)', async () => {
    const archiveFn = vi.fn(async (_sid: string) => {
      throw new Error('FK constraint violation');
    });
    const getFn = vi.fn(() => fakeRow());
    const emitFn = vi.fn();
    (handoffLogger.warn as ReturnType<typeof vi.fn>).mockClear();

    await expect(
      archiveSourceSessionWithEmit('source-sid', {
        archive: archiveFn,
        getSession: getFn,
        emitArchiveFailed: emitFn,
      }),
    ).resolves.toBeUndefined();

    expect(emitFn).toHaveBeenCalledTimes(1);
    // archive-toctou-fix-20260515 plan: instanceof SessionRowMissingError === false (generic Error)
    // → 'archive-throw' 路径,UI 显示「重试归档」按钮。
    expect(emitFn).toHaveBeenCalledWith({
      sessionId: 'source-sid',
      toolName: 'SessionHandOffSpawn',
      reason: expect.stringContaining('FK constraint violation'),
      reasonKind: 'archive-throw',
    });
    expect(handoffLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[ipc sessions hand-off] archive source session source-sid failed:'),
      expect.any(Error),
    );

    
  });

  it('archive 抛 SessionRowMissingError → race window → emit row-missing (archive-toctou-fix-20260515 R1 reviewer-codex MED-1)', async () => {
    const archiveFn = vi.fn(async (_sid: string) => {
      // 模拟 race window: createSession 期间 source row 被删,setArchived UPDATE no-op throw
      throw new SessionRowMissingError('source-sid');
    });
    const getFn = vi.fn(() => fakeRow());
    const emitFn = vi.fn();
    (handoffLogger.warn as ReturnType<typeof vi.fn>).mockClear();

    await archiveSourceSessionWithEmit('source-sid', {
      archive: archiveFn,
      getSession: getFn,
      emitArchiveFailed: emitFn,
    });

    expect(emitFn).toHaveBeenCalledTimes(1);
    // 关键: instanceof SessionRowMissingError === true → reasonKind='row-missing' (UI 仅告知不显
    // 「重试归档」— row 真不存在重试无效)。修前 catch-all 把 setter no-op 误归 'archive-throw'。
    expect(emitFn).toHaveBeenCalledWith({
      sessionId: 'source-sid',
      toolName: 'SessionHandOffSpawn',
      reason: expect.stringContaining('race window: probe OK 后 setArchived no-op'),
      reasonKind: 'row-missing',
    });
    expect(handoffLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('setArchived no-op (race window)'),
      expect.any(SessionRowMissingError),
    );

    
  });

  it('archive 抛非 Error(e.g. string)→ emit reason 也能 stringify 不挂', async () => {
    const archiveFn = vi.fn(async (_sid: string) => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw 'opaque error string';
    });
    const getFn = vi.fn(() => fakeRow());
    const emitFn = vi.fn();
    (handoffLogger.warn as ReturnType<typeof vi.fn>).mockClear();

    await archiveSourceSessionWithEmit('source-sid', {
      archive: archiveFn,
      getSession: getFn,
      emitArchiveFailed: emitFn,
    });

    expect(emitFn).toHaveBeenCalledTimes(1);
    expect(emitFn).toHaveBeenCalledWith({
      sessionId: 'source-sid',
      toolName: 'SessionHandOffSpawn',
      reason: expect.stringContaining('opaque error string'),
      reasonKind: 'archive-throw',
    });

    
  });

  // R2 reviewer-codex MED-1 修法新增 case: 验证 createSession 异步窗口期间 row 被删的场景
  it('R2 MED-1: getSession 返回 null (row missing)→ emit row-missing + 不调 archive', async () => {
    const archiveFn = vi.fn(async (_sid: string) => undefined);
    const getFn = vi.fn(() => null);
    const emitFn = vi.fn();
    (handoffLogger.warn as ReturnType<typeof vi.fn>).mockClear();

    await archiveSourceSessionWithEmit('ghost-sid', {
      archive: archiveFn,
      getSession: getFn,
      emitArchiveFailed: emitFn,
    });

    // 关键: getSession 探针 null → archive 不调用 (避免 silent no-op resolve 漏 emit)
    expect(getFn).toHaveBeenCalledTimes(1);
    expect(archiveFn).not.toHaveBeenCalled();
    expect(emitFn).toHaveBeenCalledTimes(1);
    expect(emitFn).toHaveBeenCalledWith({
      sessionId: 'ghost-sid',
      toolName: 'SessionHandOffSpawn',
      reason: expect.stringContaining('cannot archive caller ghost-sid: not in sessions table'),
      reasonKind: 'row-missing',
    });
    expect(handoffLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[ipc sessions hand-off]'),
    );

    
  });

  // archive-toctou-fix-20260515 plan: getSession 抛错独立分支 → 'probe-throw' 不再误归 row-missing
  it('archive-toctou-fix-20260515: getSession 抛错 (DB 异常)→ 走 probe-throw 路径 emit (修前误归 row-missing)', async () => {
    const archiveFn = vi.fn(async (_sid: string) => undefined);
    const getFn = vi.fn(() => {
      throw new Error('simulated SQLite locked');
    });
    const emitFn = vi.fn();
    (handoffLogger.warn as ReturnType<typeof vi.fn>).mockClear();

    await archiveSourceSessionWithEmit('source-sid', {
      archive: archiveFn,
      getSession: getFn,
      emitArchiveFailed: emitFn,
    });

    // 关键: probe 抛错独立分支 'probe-throw' 让 UI 显示「重试归档」按钮(状态未知 row 可能仍存在)。
    // 修前老语义: catch 兜底 row=null → 走 row-missing 路径误导(UI 不显示重试入口)
    expect(archiveFn).not.toHaveBeenCalled();
    expect(emitFn).toHaveBeenCalledWith({
      sessionId: 'source-sid',
      toolName: 'SessionHandOffSpawn',
      reason: expect.stringContaining('probe getSession threw for source-sid'),
      reasonKind: 'probe-throw',
    });
    expect(handoffLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('probe getSession threw for source-sid'),
    );

    
  });
});

describe('SessionHandOffSummarize — compact hand-off capsule', () => {
  const sessionGet = vi.spyOn(sessionRepo, 'get');
  const maxEventId = vi.spyOn(eventRepo, 'maxEventId');
  const listEvents = vi.spyOn(eventRepo, 'listForSession');
  const listRecentMessages = vi.spyOn(eventRepo, 'listRecentMessages');
  const getSetting = vi.spyOn(settingsStore, 'get');
  const getAdapter = vi.spyOn(adapterRegistry, 'get');
  const summariseEvents = vi.fn();
  const sessionsLogger = log.scope('ipc-sessions');

  const ipcHandle = vi.mocked(ipcMain.handle);
  ipcHandle.mockClear();
  registerSessionsIpc();
  const summarizeHandler = ipcHandle.mock.calls.find(
    ([channel]) => channel === IpcInvoke.SessionHandOffSummarize,
  )?.[1];

  function message(id: number, role: 'user' | 'assistant', text: string): AgentEvent & { id: number } {
    return {
      id,
      sessionId: 'sid-1',
      agentId: 'claude-code',
      kind: 'message',
      payload: { role, text },
      ts: id,
      source: 'sdk',
    };
  }

  beforeEach(() => {
    sessionGet.mockReset().mockReturnValue(makeSession({ model: 'sonnet', thinking: 'high' }));
    maxEventId.mockReset().mockReturnValue(42);
    listEvents.mockReset().mockReturnValue([]);
    listRecentMessages.mockReset().mockReturnValue([
      message(2, 'assistant', '助手最近回答'),
      message(1, 'user', '用户原始问题'),
    ]);
    getSetting.mockReset().mockImplementation(((key: string) =>
      key === 'handOffProvider' ? 'claude' : key === 'resumeRecentMessagesCount' ? 30 : undefined) as typeof settingsStore.get);
    summariseEvents.mockReset().mockResolvedValue('结构化压缩检查点');
    getAdapter.mockReset().mockReturnValue({
      createSession: vi.fn(),
      summariseEvents,
    } as never);
    (sessionsLogger.warn as ReturnType<typeof vi.fn>).mockClear();
  });

  it('返回 summary + user raw + current instruction 的完整胶囊，并用预捕获高水位查 raw', async () => {
    expect(summarizeHandler).toBeTypeOf('function');
    const preview = await summarizeHandler!({} as never, 'sid-1') as Record<string, unknown>;

    expect(preview).toMatchObject({
      contextQuality: 'full',
      summaryIncluded: true,
      includedMessageCount: 2,
      omittedMessageCount: 0,
      sourceMaxEventId: 42,
    });
    expect(preview.summary).toContain('结构化压缩检查点');
    expect(preview.summary).toContain('[User] "用户原始问题"');
    expect(preview.summary).toContain('===== Current continuation instruction =====');
    expect(preview.summary).toContain(DEFAULT_HAND_OFF_CONTINUATION_INSTRUCTION);
    expect(listRecentMessages).toHaveBeenCalledWith('sid-1', 30, 42);
    expect(maxEventId.mock.invocationCallOrder[0]).toBeLessThan(listEvents.mock.invocationCallOrder[0]);
    expect(maxEventId.mock.invocationCallOrder[0]).toBeLessThan(summariseEvents.mock.invocationCallOrder[0]);
  });

  it('summary provider throw 时保留 raw-only degraded 胶囊', async () => {
    summariseEvents.mockRejectedValueOnce(new Error('provider timeout'));

    const preview = await summarizeHandler!({} as never, 'sid-1') as Record<string, unknown>;

    expect(preview).toMatchObject({
      contextQuality: 'degraded',
      summaryIncluded: false,
      includedMessageCount: 2,
    });
    expect(preview.summary).toContain('[User] "用户原始问题"');
    expect(sessionsLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('summary provider failed'),
      expect.any(Error),
    );
  });

  it('空历史使用 0 高水位，仍能检测总结期间出现的首个新事件', async () => {
    maxEventId.mockReturnValueOnce(null);
    listRecentMessages.mockReturnValueOnce([]);

    const preview = await summarizeHandler!({} as never, 'sid-1') as Record<string, unknown>;

    expect(preview.sourceMaxEventId).toBe(0);
    expect(listRecentMessages).toHaveBeenCalledWith('sid-1', 30, 0);
  });

  it('总结为空且无合格 raw 时仍报真正空会话', async () => {
    summariseEvents.mockResolvedValueOnce('   ');
    listRecentMessages.mockReturnValueOnce([]);

    await expect(summarizeHandler!({} as never, 'sid-1')).rejects.toThrow(
      'empty session or no eligible raw messages',
    );
  });
});
