/**
 * GenericPtyBridge idle detection (F3) + file-watcher integration (F4) 单测
 * （CHANGELOG_105 拆分自 pty-bridge.test.ts）。
 *
 * 完全 mock node-pty / sessionRepo / file-watcher —— **不 import 真的 node-pty / 真的 chokidar**
 * （CLAUDE.md「打包配置已踩的坑」native binding 风险：vitest 跑真测可能触发 prebuild 重新拷贝 / 权限漂移）。
 *
 * 守门点（idle detection / file-watcher 范围）：
 * - idle detection：idleQuietMs / promptSuffixRegex / debounce reset / dedup / closeSession 取消
 * - file-watcher：closeSession await close / shutdownAll 并行 await close / onExit 触发 close
 *
 * createSession / sendMessage / interrupt / closeSession / onExit 主体路径覆盖
 * 在同目录 pty-bridge.lifecycle.test.ts。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ─── mock 依赖（必须在 import bridge 前） ────────────────────────────────────

class FakePty {
  private onDataCb: ((data: string) => void) | null = null;
  private onExitCb: ((info: { exitCode: number; signal?: number }) => void) | null = null;
  pid = 9999;
  cols = 100;
  rows = 30;
  process = 'fake';
  handleFlowControl = false;
  // tracked
  writes: string[] = [];
  killed: string[] = [];

  onData(cb: (data: string) => void) {
    this.onDataCb = cb;
    return { dispose: () => {} };
  }
  onExit(cb: (info: { exitCode: number; signal?: number }) => void) {
    this.onExitCb = cb;
    return { dispose: () => {} };
  }
  write(data: string) {
    this.writes.push(data);
  }
  kill(signal?: string) {
    this.killed.push(signal ?? 'default');
  }
  resize() {}
  pause() {}
  resume() {}
  clear() {}

  // 测试辅助
  emitData(data: string) {
    this.onDataCb?.(data);
  }
  emitExit(exitCode = 0, signal?: number) {
    this.onExitCb?.({ exitCode, signal });
  }
}

const ptyInstances: FakePty[] = [];
let nextSpawnError: Error | null = null;

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => {
    if (nextSpawnError) {
      const err = nextSpawnError;
      nextSpawnError = null;
      throw err;
    }
    const inst = new FakePty();
    ptyInstances.push(inst);
    return inst;
  }),
}));

const repoCalls: Array<{ method: string; args: unknown[] }> = [];

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: {
    setGenericPtyConfig: vi.fn((...args: unknown[]) => {
      repoCalls.push({ method: 'setGenericPtyConfig', args });
    }),
  },
}));

// F4：mock file-watcher（不引真 chokidar）。每个 PtyFileWatcher 实例 start/close 都 noop。
const fileWatcherCloseCalls: string[] = [];
vi.mock('../file-watcher', () => ({
  PtyFileWatcher: class {
    sessionId: string;
    constructor(opts: { sessionId: string }) {
      this.sessionId = opts.sessionId;
    }
    async start() {}
    async close() {
      fileWatcherCloseCalls.push(this.sessionId);
    }
    __debugIsClosed() {
      return false;
    }
  },
}));

import { GenericPtyBridge } from '../pty-bridge';
import type { AgentEvent, GenericPtyConfig } from '@shared/types';

// ─── 测试夹具 ──────────────────────────────────────────────────────────────

const validConfig: GenericPtyConfig = {
  command: '/bin/echo',
  args: ['hi'],
  env: {},
  cwd: '',
  idleQuietMs: 3000,
  promptSuffixRegex: '',
};

let events: AgentEvent[] = [];
let bridge: GenericPtyBridge;

function newBridge(opts?: {
  adapterId?: 'generic-pty' | 'aider';
  fallbackConfig?: GenericPtyConfig | null;
}) {
  return new GenericPtyBridge({
    adapterId: opts?.adapterId ?? 'generic-pty',
    fallbackConfig: opts?.fallbackConfig ?? null,
    emit: (e) => events.push(e),
  });
}

beforeEach(() => {
  events = [];
  ptyInstances.length = 0;
  repoCalls.length = 0;
  fileWatcherCloseCalls.length = 0;
  nextSpawnError = null;
  bridge = newBridge();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GenericPtyBridge idle detection (F3)', () => {
  it('emits waiting-for-user after idleQuietMs without new chunks', async () => {
    vi.useFakeTimers();
    await bridge.createSession({
      cwd: '/tmp',
      // idle 1s + 不配 promptSuffixRegex → 纯静默触发
      genericPtyConfig: { ...validConfig, idleQuietMs: 1000, promptSuffixRegex: '' },
    });
    ptyInstances[0].emitData('hello');
    events.length = 0; // 清掉 emit message 事件，只留接下来 idle
    vi.advanceTimersByTime(1001);
    const idleEvent = events.find((e) => e.kind === 'waiting-for-user');
    expect(idleEvent).toBeDefined();
    expect((idleEvent?.payload as { source: string }).source).toBe('pty-idle');
  });

  it('does not emit waiting-for-user when promptSuffixRegex set but tail does not match', async () => {
    vi.useFakeTimers();
    await bridge.createSession({
      cwd: '/tmp',
      genericPtyConfig: {
        ...validConfig,
        idleQuietMs: 1000,
        promptSuffixRegex: '\\>\\s*$',
      },
    });
    ptyInstances[0].emitData('thinking...'); // tail 末尾不是 `> `
    events.length = 0;
    vi.advanceTimersByTime(1001);
    expect(events.find((e) => e.kind === 'waiting-for-user')).toBeUndefined();
  });

  it('emits waiting-for-user when promptSuffixRegex matches tail', async () => {
    vi.useFakeTimers();
    await bridge.createSession({
      cwd: '/tmp',
      genericPtyConfig: {
        ...validConfig,
        idleQuietMs: 1000,
        promptSuffixRegex: '\\>\\s*$',
      },
    });
    ptyInstances[0].emitData('done\n> '); // tail 末尾 `> ` 命中
    events.length = 0;
    vi.advanceTimersByTime(1001);
    expect(events.find((e) => e.kind === 'waiting-for-user')).toBeDefined();
  });

  it('resets timer on each new onData (debounce)', async () => {
    vi.useFakeTimers();
    await bridge.createSession({
      cwd: '/tmp',
      genericPtyConfig: { ...validConfig, idleQuietMs: 1000, promptSuffixRegex: '' },
    });
    ptyInstances[0].emitData('first');
    vi.advanceTimersByTime(800); // 还没到 idle
    ptyInstances[0].emitData('second'); // reset
    events.length = 0;
    vi.advanceTimersByTime(800); // 总 1600 ms 但 second 后只 800 ms
    expect(events.find((e) => e.kind === 'waiting-for-user')).toBeUndefined();
    vi.advanceTimersByTime(300); // second 后总 1100 ms → 触发
    expect(events.find((e) => e.kind === 'waiting-for-user')).toBeDefined();
  });

  it('dedups consecutive idle (only one waiting-for-user per quiet period)', async () => {
    vi.useFakeTimers();
    await bridge.createSession({
      cwd: '/tmp',
      genericPtyConfig: { ...validConfig, idleQuietMs: 500, promptSuffixRegex: '' },
    });
    ptyInstances[0].emitData('x');
    vi.advanceTimersByTime(501); // first idle
    vi.advanceTimersByTime(501); // 应该不再 emit（detector 已 fire 一次，timer null）
    const idleEvents = events.filter((e) => e.kind === 'waiting-for-user');
    expect(idleEvents.length).toBe(1);
  });

  it('cancels idle timer on closeSession (no leaked emit)', async () => {
    vi.useFakeTimers();
    const { sessionId } = await bridge.createSession({
      cwd: '/tmp',
      genericPtyConfig: { ...validConfig, idleQuietMs: 500, promptSuffixRegex: '' },
    });
    ptyInstances[0].emitData('x');
    await bridge.closeSession(sessionId);
    events.length = 0;
    vi.advanceTimersByTime(2000);
    // close 后 dispose detector → 不 emit waiting-for-user
    expect(events.find((e) => e.kind === 'waiting-for-user')).toBeUndefined();
  });
});

// ─── F4：file-watcher integration ────────────────────────────────────────────

describe('GenericPtyBridge file-watcher integration (F4)', () => {
  it('closeSession awaits fileWatcher.close (release fs handle)', async () => {
    const { sessionId } = await bridge.createSession({
      cwd: '/tmp',
      genericPtyConfig: validConfig,
    });
    expect(fileWatcherCloseCalls).toEqual([]);
    await bridge.closeSession(sessionId);
    // close 调到了 PtyFileWatcher.close 至少一次
    expect(fileWatcherCloseCalls).toContain(sessionId);
  });

  it('shutdownAll awaits all fileWatcher.close in parallel', async () => {
    const { sessionId: s1 } = await bridge.createSession({
      cwd: '/tmp',
      genericPtyConfig: validConfig,
    });
    const { sessionId: s2 } = await bridge.createSession({
      cwd: '/tmp',
      genericPtyConfig: validConfig,
    });
    await bridge.shutdownAll();
    expect(fileWatcherCloseCalls).toContain(s1);
    expect(fileWatcherCloseCalls).toContain(s2);
  });

  it('onExit fires fileWatcher.close (fire-and-forget, sessions cleared)', async () => {
    const { sessionId } = await bridge.createSession({
      cwd: '/tmp',
      genericPtyConfig: validConfig,
    });
    ptyInstances[0].emitExit(0);
    // sessions Map 清空（onExit 同步触发）
    expect(bridge.__debugSessionCount()).toBe(0);
    // fileWatcher.close 是异步 fire-and-forget；用 setImmediate 让微任务跑完
    await new Promise((r) => setImmediate(r));
    expect(fileWatcherCloseCalls).toContain(sessionId);
  });
});
