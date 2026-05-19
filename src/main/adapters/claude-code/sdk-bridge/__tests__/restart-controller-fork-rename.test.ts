/**
 * plan deep-review-batch-a1-b-followup-r3-20260519 §Phase R3 fix-1 测试 (R3 plan-review
 * claude MED-1 + codex Batch A HIGH-1 合并升级):
 *
 * restart-controller 在 inflight wait / createSession await 期间被并发 caller 触发
 * SDK fork rename (CHANGELOG_27 / REVIEW_6 CLI 隐式 fork) 后：
 * 1. 用 currentSid ref 替代 sessionId 入参防 stale ID 引用
 * 2. transfer recovering Map entry from OLD → NEW 防 OLD stale Promise 永驻 + NEW caller 绕过单飞
 *
 * **必须覆盖两个 restart 方法对称**:
 * - restartWithPermissionMode (Phase 2.9 commit b8a2961 已加 listener,R3 fix-1 加 transfer)
 * - restartWithClaudeCodeSandbox (Phase 2.9 完全没修,R3 fix-1 first land 同款 listener + transfer)
 *
 * **测试方式**: 直接 new RestartController + mock RestartCtx,不走 ClaudeSdkBridge
 * (depth-of-test 隔离: restart-controller 自身 race fix 行为)。
 * - mock ctx.createSession 在 await 期间手动 emit session-renamed event 模拟 fork
 * - 断言 recovering Map 在 fork 前后 key 正确转移
 * - 断言 finally 注销 listener (spy eventBus.off 看是否被 called with 'session-renamed')
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RestartController, type RestartCtx, type RestartCreateOpts } from '../restart-controller';
import { eventBus } from '@main/event-bus';
import { sessionRepo } from '@main/store/session-repo';
import type { SdkSessionHandle } from '../types';
import type { AgentEvent, SessionRecord } from '@shared/types';

// sessionRepo / sessionManager mock 让 RestartController 不撞依赖
const repoCache = new Map<string, SessionRecord>();

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: {
    get: vi.fn((sid: string) => repoCache.get(sid) ?? null),
    setPermissionMode: vi.fn(),
    setClaudeCodeSandbox: vi.fn(),
  },
}));

vi.mock('@main/session/manager', () => ({
  sessionManager: {
    renameSdkSession: vi.fn(),
  },
}));

const emits: AgentEvent[] = [];

function makeRec(sid: string): SessionRecord {
  return {
    id: sid,
    cwd: '/tmp/test',
    adapter: 'claude-code',
    title: null,
    lifecycle: 'active',
    permissionMode: 'default',
    claudeCodeSandbox: 'workspace-write',
    model: null,
    extraAllowWrite: null,
    archivedAt: null,
    createdAt: 0,
    updatedAt: 0,
    lastEventAt: 0,
    spawnDepth: 0,
    spawnedBy: null,
  } as unknown as SessionRecord;
}

function makeCtx(opts?: {
  closeSession?: (sid: string) => Promise<void>;
  createSession?: (opts: RestartCreateOpts) => Promise<SdkSessionHandle>;
}): { ctx: RestartCtx; recovering: Map<string, Promise<unknown>> } {
  const recovering = new Map<string, Promise<unknown>>();
  const ctx: RestartCtx = {
    recovering,
    emit: (e) => emits.push(e),
    closeSession: opts?.closeSession ?? (async () => undefined),
    createSession:
      opts?.createSession ??
      (async () =>
        ({ sessionId: 'no-fork-default', cwd: '/tmp/test' }) as unknown as SdkSessionHandle),
  };
  return { ctx, recovering };
}

beforeEach(() => {
  emits.length = 0;
  repoCache.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Phase R3 fix-1 — restart-controller race fix (recovering Map entry transfer + currentSid ref)', () => {
  it('restartWithPermissionMode: fork rename 期间 recovering Map entry 从 OLD → NEW transfer + finally delete(NEW) 配对', async () => {
    // 模拟 race: createSession 内部 emit session-renamed 把 OLD → NEW
    const OLD = 'old-sid';
    const NEW = 'new-real-id';
    repoCache.set(OLD, makeRec(OLD));

    const offSpy = vi.spyOn(eventBus, 'off');

    const { ctx, recovering } = makeCtx({
      createSession: async () => {
        // 在 createSession await 期间触发 SDK fork rename emit
        // 同步 emit (event-bus 同步执行 listener) → listener 立即把 OLD → NEW transfer
        eventBus.emit('session-renamed', { from: OLD, to: NEW });
        // 返 NEW real id 模拟 fork
        return { sessionId: NEW, cwd: '/tmp/test' } as unknown as SdkSessionHandle;
      },
    });
    const controller = new RestartController(ctx);

    // mid-flight 探测 recovering Map key (在 emit session-renamed 之后立即查)
    let mapKeysMidFlight: string[] | null = null;
    const originalCreate = ctx.createSession;
    ctx.createSession = async (opts: RestartCreateOpts) => {
      const result = await originalCreate(opts);
      // 此时 listener 已经 transfer 过 entry
      mapKeysMidFlight = Array.from(recovering.keys());
      return result;
    };

    const finalId = await controller.restartWithPermissionMode(OLD, 'plan', 'go');
    expect(finalId).toBe(NEW);

    // 关键 invariant 1: fork 后 recovering Map key 在 mid-flight 时已经从 OLD → NEW
    expect(mapKeysMidFlight).toEqual([NEW]);
    expect(mapKeysMidFlight).not.toContain(OLD);

    // 关键 invariant 2: finally cleanup 后 NEW entry 删除 (delete(currentSid=NEW))
    expect(recovering.has(OLD)).toBe(false);
    expect(recovering.has(NEW)).toBe(false);

    // 关键 invariant 3: listener 注销 (try/finally eventBus.off with 'session-renamed')
    const sessionRenamedOffCalls = offSpy.mock.calls.filter((c) => c[0] === 'session-renamed');
    expect(sessionRenamedOffCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('restartWithClaudeCodeSandbox: fork rename 期间同款 transfer Map entry + finally delete(NEW) (R3 fix-1 first land)', async () => {
    // restartWithClaudeCodeSandbox 之前 Phase 2.9 完全没修,R3 fix-1 first land 加同款 race fix
    const OLD = 'old-sid';
    const NEW = 'new-real-id';
    repoCache.set(OLD, makeRec(OLD));

    const offSpy = vi.spyOn(eventBus, 'off');

    const { ctx, recovering } = makeCtx({
      createSession: async () => {
        eventBus.emit('session-renamed', { from: OLD, to: NEW });
        return { sessionId: NEW, cwd: '/tmp/test' } as unknown as SdkSessionHandle;
      },
    });
    const controller = new RestartController(ctx);

    let mapKeysMidFlight: string[] | null = null;
    const originalCreate = ctx.createSession;
    ctx.createSession = async (opts: RestartCreateOpts) => {
      const result = await originalCreate(opts);
      mapKeysMidFlight = Array.from(recovering.keys());
      return result;
    };

    const finalId = await controller.restartWithClaudeCodeSandbox(OLD, 'off', 'go');
    expect(finalId).toBe(NEW);

    expect(mapKeysMidFlight).toEqual([NEW]);
    expect(recovering.has(OLD)).toBe(false);
    expect(recovering.has(NEW)).toBe(false);
    const sessionRenamedOffCalls = offSpy.mock.calls.filter((c) => c[0] === 'session-renamed');
    expect(sessionRenamedOffCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('restartWithPermissionMode: 无 fork 场景 (newRealId === sessionId) Map key 与入参一致 + cleanup', async () => {
    const SID = 'no-fork-sid';
    repoCache.set(SID, makeRec(SID));

    const offSpy = vi.spyOn(eventBus, 'off');

    const { ctx, recovering } = makeCtx({
      createSession: async () =>
        ({ sessionId: SID, cwd: '/tmp/test' }) as unknown as SdkSessionHandle,
    });
    const controller = new RestartController(ctx);

    let mapKeysMidFlight: string[] | null = null;
    const originalCreate = ctx.createSession;
    ctx.createSession = async (opts: RestartCreateOpts) => {
      const result = await originalCreate(opts);
      mapKeysMidFlight = Array.from(recovering.keys());
      return result;
    };

    const finalId = await controller.restartWithPermissionMode(SID, 'plan', 'go');
    expect(finalId).toBe(SID);

    // 无 fork: Map key 一直是 SID
    expect(mapKeysMidFlight).toEqual([SID]);
    expect(recovering.has(SID)).toBe(false); // finally cleanup
    const sessionRenamedOffCalls = offSpy.mock.calls.filter((c) => c[0] === 'session-renamed');
    expect(sessionRenamedOffCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('restartWithPermissionMode: listener 仅响应 from === currentSid (其他 session rename 不干扰)', async () => {
    // 模拟其他 session 的 rename event 触发 listener,但 from !== currentSid 应不动 Map
    const OLD = 'my-sid';
    const OTHER_FROM = 'other-sid';
    const OTHER_TO = 'other-new-sid';
    repoCache.set(OLD, makeRec(OLD));

    const { ctx, recovering } = makeCtx({
      createSession: async () => {
        // emit 不相关的 rename event
        eventBus.emit('session-renamed', { from: OTHER_FROM, to: OTHER_TO });
        return { sessionId: OLD, cwd: '/tmp/test' } as unknown as SdkSessionHandle;
      },
    });
    const controller = new RestartController(ctx);

    let mapKeysMidFlight: string[] | null = null;
    const originalCreate = ctx.createSession;
    ctx.createSession = async (opts: RestartCreateOpts) => {
      const result = await originalCreate(opts);
      mapKeysMidFlight = Array.from(recovering.keys());
      return result;
    };

    const finalId = await controller.restartWithPermissionMode(OLD, 'plan', 'go');
    expect(finalId).toBe(OLD);

    // 不相关 rename 不动 Map key
    expect(mapKeysMidFlight).toEqual([OLD]);
    expect(recovering.has(OTHER_FROM)).toBe(false);
    expect(recovering.has(OTHER_TO)).toBe(false);
    expect(recovering.has(OLD)).toBe(false);
  });

  it('restartWithClaudeCodeSandbox: 失败回滚 + cleanup listener (sandbox rollback 不破坏 R3 race fix)', async () => {
    const SID = 'rollback-sid';
    const rec = makeRec(SID);
    repoCache.set(SID, rec);

    const setSandboxSpy = sessionRepo.setClaudeCodeSandbox as unknown as ReturnType<typeof vi.fn>;
    const offSpy = vi.spyOn(eventBus, 'off');

    const { ctx, recovering } = makeCtx({
      createSession: async () => {
        throw new Error('SDK createSession failed');
      },
    });
    const controller = new RestartController(ctx);

    let caught: Error | null = null;
    try {
      await controller.restartWithClaudeCodeSandbox(SID, 'off', 'go');
    } catch (err) {
      caught = err as Error;
    }

    expect(caught?.message).toContain('SDK createSession failed');
    // 失败也要 cleanup
    expect(recovering.has(SID)).toBe(false);
    // 回滚 setClaudeCodeSandbox 被调过 2 次 (先写新值,catch 回滚原值)
    expect(setSandboxSpy).toHaveBeenCalledTimes(2);
    expect(setSandboxSpy).toHaveBeenNthCalledWith(1, SID, 'off');
    expect(setSandboxSpy).toHaveBeenNthCalledWith(2, SID, 'workspace-write');
    // listener cleanup
    const sessionRenamedOffCalls = offSpy.mock.calls.filter((c) => c[0] === 'session-renamed');
    expect(sessionRenamedOffCalls.length).toBeGreaterThanOrEqual(1);
  });
});
