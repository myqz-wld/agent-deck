/**
 * sdk-bridge.recoverAndSend 单测（CHANGELOG_26 / B 方案）。
 *
 * 覆盖：sendMessage 检测 sessions Map 没有该 sessionId 时的「断连自愈」路径。
 * 重点验证两 Agent 对抗指出的硬约束：
 *   - 单飞（同 sessionId 并发只调一次 createSession）
 *   - 占位 message emit（30s fallback 期间不让 UI 哑巴 busy）
 *   - record 不存在 → 抛与原行为一致的 'not found'
 *   - 失败时补 error message emit
 *
 * Mock 策略：
 *   - sessionRepo / sessionManager / sdk-loader / sdk-runtime / sdk-injection 全 mock
 *   - 子类化 ClaudeSdkBridge 覆盖 createSession 不真起 SDK CLI 子进程，
 *     避免本机 vitest 跑测试时 spawn 真 claude binary
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@shared/types';

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: {
    get: vi.fn(),
  },
}));

vi.mock('@main/session/manager', () => ({
  sessionManager: {
    claimAsSdk: vi.fn(),
    releaseSdkClaim: vi.fn(),
    expectSdkSession: vi.fn(() => () => undefined),
    renameSdkSession: vi.fn(),
  },
}));

vi.mock('@main/adapters/claude-code/sdk-loader', () => ({
  loadSdk: vi.fn(),
}));

vi.mock('@main/adapters/claude-code/sdk-runtime', () => ({
  getSdkRuntimeOptions: () => ({ executable: 'node', env: {} }),
  getPathToClaudeCodeExecutable: () => '/fake/cli',
}));

vi.mock('@main/adapters/claude-code/sdk-injection', () => ({
  getAgentDeckPluginPath: () => '/fake/plugin',
  getAgentDeckSystemPromptAppend: () => '',
}));

import { ClaudeSdkBridge } from '@main/adapters/claude-code/sdk-bridge';
import { sessionRepo } from '@main/store/session-repo';

interface CreateSessionCall {
  cwd: string;
  prompt?: string;
  resume?: string;
  permissionMode?: string;
}

class TestBridge extends ClaudeSdkBridge {
  /** 替身：每次调记录参数；resolved 控制是否立刻完成 */
  public createCalls: CreateSessionCall[] = [];
  /** 测试时控制 createSession 是否阻塞 / 抛错；undefined = 立刻 resolve */
  public createBehavior: 'resolve' | 'block' | 'reject' = 'resolve';
  public unblock?: () => void;
  public rejectWith?: Error;

  override async createSession(opts: {
    cwd: string;
    prompt?: string;
    model?: string;
    permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
    resume?: string;
  }): Promise<{ sessionId: string; abort: () => void }> {
    this.createCalls.push({
      cwd: opts.cwd,
      prompt: opts.prompt,
      resume: opts.resume,
      permissionMode: opts.permissionMode,
    });
    if (this.createBehavior === 'block') {
      await new Promise<void>((res) => {
        this.unblock = res;
      });
    } else if (this.createBehavior === 'reject') {
      throw this.rejectWith ?? new Error('mock create reject');
    }
    return { sessionId: opts.resume ?? 'new-sid', abort: () => undefined };
  }
}

const emits: AgentEvent[] = [];

function makeBridge(): TestBridge {
  return new TestBridge({
    emit: (e) => {
      emits.push(e);
    },
  });
}

beforeEach(() => {
  emits.length = 0;
  vi.mocked(sessionRepo.get).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sdk-bridge.sendMessage 断连自愈（B 方案）', () => {
  it('record 在 → 走 createSession({resume,prompt,cwd,permissionMode}) + emit 占位 message', async () => {
    const bridge = makeBridge();
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'sess-1',
      agentId: 'claude-code',
      cwd: '/tmp/work',
      title: 'work',
      source: 'sdk',
      lifecycle: 'dormant',
      activity: 'idle',
      startedAt: 1,
      lastEventAt: 2,
      endedAt: null,
      archivedAt: null,
      permissionMode: 'plan',
    });

    await bridge.sendMessage('sess-1', 'hi');

    // 占位 message（非 error）emit 一条
    const placeholders = emits.filter(
      (e) =>
        e.kind === 'message' &&
        typeof (e.payload as { text?: string }).text === 'string' &&
        (e.payload as { text: string }).text.includes('正在自动恢复'),
    );
    expect(placeholders).toHaveLength(1);
    expect(placeholders[0].sessionId).toBe('sess-1');
    expect((placeholders[0].payload as { error?: boolean }).error).toBeFalsy();

    // createSession 被调一次，参数完整复用 record
    expect(bridge.createCalls).toHaveLength(1);
    expect(bridge.createCalls[0]).toEqual({
      cwd: '/tmp/work',
      prompt: 'hi',
      resume: 'sess-1',
      permissionMode: 'plan',
    });
  });

  it('record 不在 → 抛与原行为一致的 not found 错，createSession 不被调', async () => {
    const bridge = makeBridge();
    vi.mocked(sessionRepo.get).mockReturnValue(null);

    await expect(bridge.sendMessage('sess-ghost', 'hi')).rejects.toThrow(/not found/);
    expect(bridge.createCalls).toHaveLength(0);
    // 也不应该 emit 占位 message（没记录 = 真不可恢复，不要污染活动流）
    const placeholders = emits.filter((e) =>
      ((e.payload as { text?: string }).text ?? '').includes('正在自动恢复'),
    );
    expect(placeholders).toHaveLength(0);
  });

  it('单飞：同 sessionId 并发 sendMessage 只触发一次 createSession', async () => {
    const bridge = makeBridge();
    bridge.createBehavior = 'block';
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'sess-2',
      agentId: 'claude-code',
      cwd: '/tmp/x',
      title: 'x',
      source: 'sdk',
      lifecycle: 'dormant',
      activity: 'idle',
      startedAt: 1,
      lastEventAt: 2,
      endedAt: null,
      archivedAt: null,
      permissionMode: null,
    });

    // 第一波（不 await）+ 让 inflight Promise 注册到 recovering Map
    const p1 = bridge.sendMessage('sess-2', 'first').catch(() => undefined);
    // microtask flush，确保 p1 已经把 inflight 写入 recovering Map
    await Promise.resolve();
    await Promise.resolve();
    // 第二波同 sessionId
    const p2 = bridge.sendMessage('sess-2', 'second').catch(() => undefined);
    await Promise.resolve();
    await Promise.resolve();

    // createSession 此刻只被调过一次（第二条等同一 inflight）
    expect(bridge.createCalls).toHaveLength(1);
    expect(bridge.createCalls[0].prompt).toBe('first');

    // 解锁 inflight，让两条 promise 都退出
    bridge.unblock?.();
    bridge.createBehavior = 'reject'; // 第二条递归 sendMessage 时再次走 recovery → 抛错让它早退
    bridge.rejectWith = new Error('second wave fast-fail');
    await p1;
    await p2;
  });

  it('createSession 失败 → 补 emit 一条 error message 后 throw', async () => {
    const bridge = makeBridge();
    bridge.createBehavior = 'reject';
    bridge.rejectWith = new Error('CLI auth expired');
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'sess-3',
      agentId: 'claude-code',
      cwd: '/tmp/y',
      title: 'y',
      source: 'sdk',
      lifecycle: 'dormant',
      activity: 'idle',
      startedAt: 1,
      lastEventAt: 2,
      endedAt: null,
      archivedAt: null,
      permissionMode: null,
    });

    await expect(bridge.sendMessage('sess-3', 'hi')).rejects.toThrow(/CLI auth expired/);

    // emit 序列：占位 message + error message
    const errorMsgs = emits.filter(
      (e) =>
        e.kind === 'message' &&
        ((e.payload as { error?: boolean }).error === true) &&
        ((e.payload as { text?: string }).text ?? '').includes('自动恢复失败'),
    );
    expect(errorMsgs).toHaveLength(1);
    expect(errorMsgs[0].sessionId).toBe('sess-3');
  });
});
