/**
 * GenericPtyBridge lifecycle 单测（R4·F2 — CHANGELOG_105 拆分自 pty-bridge.test.ts）。
 *
 * 完全 mock node-pty 与 sessionRepo —— **不 import 真的 node-pty**（CLAUDE.md「打包配置已踩
 * 的坑」node-pty native binding 风险：vitest 跑真测可能触发 prebuild 重新拷贝 / 权限漂移）。
 *
 * 守门点（lifecycle 范围）：
 * - createSession lifecycle：spawn → emit session-start + 首条 user message → 写 stdin
 * - 无 prompt：不 emit user message / 不 写 stdin
 * - missing config（无 fallback）throw / empty command throw / prompt > 100KB throw
 * - fallback config：用户没传 → 走 fallbackConfig
 * - sendMessage：emit user message + 写 stdin；session 不存在 throw；> 100KB throw
 * - interrupt：写 \x03；session 不存在 noop（不抛错）
 * - closeSession：SIGTERM + 10s grace 后 SIGKILL；双 close 安全；onExit 清 sessions
 * - shutdownAll：所有 session SIGKILL + 清 Map
 *
 * idle detection (F3) 与 file-watcher integration (F4) 在同目录 pty-bridge.idle-fwatch.test.ts。
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

const aiderFallbackConfig: GenericPtyConfig = {
  command: 'aider',
  args: ['--no-stream'],
  env: {},
  cwd: '',
  idleQuietMs: 3000,
  promptSuffixRegex: '\\>\\s*$',
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

// ─── createSession ─────────────────────────────────────────────────────────

describe('GenericPtyBridge.createSession', () => {
  it('emits session-start + first user message + writes prompt to stdin', async () => {
    const { sessionId } = await bridge.createSession({
      cwd: '/tmp/work',
      prompt: 'hello',
      genericPtyConfig: validConfig,
    });
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(ptyInstances.length).toBe(1);
    const startEvent = events.find((e) => e.kind === 'session-start');
    expect(startEvent).toBeDefined();
    expect(startEvent?.agentId).toBe('generic-pty');
    expect((startEvent?.payload as { cwd: string }).cwd).toBe('/tmp/work');
    const userMsg = events.find(
      (e) => e.kind === 'message' && (e.payload as { role: string }).role === 'user',
    );
    expect((userMsg?.payload as { text: string }).text).toBe('hello');
    // stdin 写入了带 \n 的 prompt
    expect(ptyInstances[0].writes).toEqual(['hello\n']);
    // sessionRepo.setGenericPtyConfig 被调
    expect(repoCalls.length).toBe(1);
    expect(repoCalls[0].method).toBe('setGenericPtyConfig');
    expect(repoCalls[0].args[0]).toBe(sessionId);
  });

  it('skips first user message + stdin write when no prompt provided', async () => {
    await bridge.createSession({ cwd: '/tmp', genericPtyConfig: validConfig });
    expect(events.find((e) => e.kind === 'session-start')).toBeDefined();
    expect(events.find((e) => e.kind === 'message')).toBeUndefined();
    expect(ptyInstances[0].writes.length).toBe(0);
  });

  it('throws when no config and no fallback (generic-pty default)', async () => {
    await expect(
      bridge.createSession({ cwd: '/tmp', prompt: 'x' }),
    ).rejects.toThrow(/missing genericPtyConfig/);
    expect(ptyInstances.length).toBe(0);
  });

  it('uses fallbackConfig when no input config (aider preset path)', async () => {
    const aiderBridge = newBridge({
      adapterId: 'aider',
      fallbackConfig: aiderFallbackConfig,
    });
    const { sessionId } = await aiderBridge.createSession({
      cwd: '/tmp',
      prompt: 'p',
    });
    expect(sessionId).toBeDefined();
    // setGenericPtyConfig 被调用，args[1] 是 fallback config（验证通过 fallback path）
    expect(repoCalls[0].args[1]).toEqual(aiderFallbackConfig);
    // emit 的 agentId 是 aider
    expect(events.find((e) => e.kind === 'session-start')?.agentId).toBe('aider');
  });

  it('throws when config.command is empty', async () => {
    await expect(
      bridge.createSession({
        cwd: '/tmp',
        genericPtyConfig: { ...validConfig, command: '' },
      }),
    ).rejects.toThrow(/command must be non-empty/);
  });

  it('throws when prompt > MAX_PROMPT_LENGTH (REVIEW_24 HIGH-2: char count not byte)', async () => {
    const bigPrompt = 'a'.repeat(102_401);
    await expect(
      bridge.createSession({
        cwd: '/tmp',
        prompt: bigPrompt,
        genericPtyConfig: validConfig,
      }),
    ).rejects.toThrow(/prompt > 102400 chars/);
  });

  it('falls back cwd from config.cwd → input.cwd → homedir', async () => {
    // config.cwd 优先
    await bridge.createSession({
      cwd: '/from-input',
      genericPtyConfig: { ...validConfig, cwd: '/from-config' },
    });
    expect(
      (events.find((e) => e.kind === 'session-start')?.payload as { cwd: string }).cwd,
    ).toBe('/from-config');
  });

  it('rethrows wrapped error when ptySpawn throws', async () => {
    nextSpawnError = new Error('posix_spawnp failed');
    await expect(
      bridge.createSession({ cwd: '/tmp', genericPtyConfig: validConfig }),
    ).rejects.toThrow(/spawn failed: posix_spawnp failed/);
    expect(events.length).toBe(0); // 没 emit 任何 event（spawn 失败前就 throw）
  });
});

// ─── sendMessage ─────────────────────────────────────────────────────────────

describe('GenericPtyBridge.sendMessage', () => {
  it('emits user message + writes to stdin with trailing newline', async () => {
    const { sessionId } = await bridge.createSession({
      cwd: '/tmp',
      genericPtyConfig: validConfig,
    });
    events.length = 0;
    ptyInstances[0].writes.length = 0;
    await bridge.sendMessage(sessionId, 'follow-up');
    const userMsg = events.find(
      (e) => e.kind === 'message' && (e.payload as { role: string }).role === 'user',
    );
    expect((userMsg?.payload as { text: string }).text).toBe('follow-up');
    expect(ptyInstances[0].writes).toEqual(['follow-up\n']);
  });

  it('preserves user-supplied trailing newline', async () => {
    const { sessionId } = await bridge.createSession({
      cwd: '/tmp',
      genericPtyConfig: validConfig,
    });
    ptyInstances[0].writes.length = 0;
    await bridge.sendMessage(sessionId, 'with-newline\n');
    expect(ptyInstances[0].writes).toEqual(['with-newline\n']); // 没重复加 \n
  });

  it('throws when session not found', async () => {
    await expect(bridge.sendMessage('non-existent', 'x')).rejects.toThrow(
      /session non-existent not found/,
    );
  });

  it('throws when message > MAX_PROMPT_LENGTH (REVIEW_24 HIGH-2: char count not byte)', async () => {
    const { sessionId } = await bridge.createSession({
      cwd: '/tmp',
      genericPtyConfig: validConfig,
    });
    const big = 'a'.repeat(102_401);
    await expect(bridge.sendMessage(sessionId, big)).rejects.toThrow(
      /message > 102400 chars/,
    );
  });

  it('throws "session is closing" when sendMessage called after closeSession (REVIEW_24 MED-Claude4)', async () => {
    const { sessionId } = await bridge.createSession({
      cwd: '/tmp',
      genericPtyConfig: validConfig,
    });
    await bridge.closeSession(sessionId);
    // close 后 state 还在 Map（要等 onExit 异步清），但 intentionallyClosed=true
    // → sendMessage 应立即 throw 让 watcher 走 retry，避免 PTY 已 SIGTERM 写 stdin EIO
    await expect(bridge.sendMessage(sessionId, 'late')).rejects.toThrow(/is closing/);
  });
});

// ─── interrupt ───────────────────────────────────────────────────────────────

describe('GenericPtyBridge.interrupt', () => {
  it('writes Ctrl+C (\\x03) to PTY stdin', async () => {
    const { sessionId } = await bridge.createSession({
      cwd: '/tmp',
      genericPtyConfig: validConfig,
    });
    ptyInstances[0].writes.length = 0;
    await bridge.interrupt(sessionId);
    expect(ptyInstances[0].writes).toEqual(['\x03']);
  });

  it('is a no-op when session not found (no throw)', async () => {
    // 不抛错，与 codex-cli / claude-code interrupt 同款
    await expect(bridge.interrupt('non-existent')).resolves.toBeUndefined();
  });
});

// ─── closeSession + onExit ───────────────────────────────────────────────────

describe('GenericPtyBridge.closeSession + onExit lifecycle', () => {
  it('SIGTERMs PTY and schedules SIGKILL grace timer', async () => {
    vi.useFakeTimers();
    const { sessionId } = await bridge.createSession({
      cwd: '/tmp',
      genericPtyConfig: validConfig,
    });
    await bridge.closeSession(sessionId);
    expect(ptyInstances[0].killed).toEqual(['SIGTERM']);
    // SIGKILL 还没触发
    expect(bridge.__debugSessionCount()).toBe(1);
    // 跑 10s grace
    vi.advanceTimersByTime(10_001);
    expect(ptyInstances[0].killed).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('SIGTERM precedes fileWatcher.close (REVIEW_24 codex MED 1: kernel grace 不被 watcher 阻塞)', async () => {
    const { sessionId } = await bridge.createSession({
      cwd: '/tmp',
      genericPtyConfig: validConfig,
    });
    // closeSession 应同步 issue SIGTERM；watcher close 是 fire-and-forget
    await bridge.closeSession(sessionId);
    // SIGTERM 立即可见（不等 watcher close 异步完成）
    expect(ptyInstances[0].killed).toEqual(['SIGTERM']);
  });

  it('double close is safe (second call no-op)', async () => {
    const { sessionId } = await bridge.createSession({
      cwd: '/tmp',
      genericPtyConfig: validConfig,
    });
    await bridge.closeSession(sessionId);
    await bridge.closeSession(sessionId);
    // 只 SIGTERM 一次
    expect(ptyInstances[0].killed).toEqual(['SIGTERM']);
  });

  it('onExit fires session-end event + clears session from map', async () => {
    await bridge.createSession({
      cwd: '/tmp',
      genericPtyConfig: validConfig,
    });
    expect(bridge.__debugSessionCount()).toBe(1);
    ptyInstances[0].emitExit(0);
    const endEvent = events.find((e) => e.kind === 'session-end');
    expect(endEvent).toBeDefined();
    expect((endEvent?.payload as { reason: string }).reason).toBe('exit=0');
    expect(bridge.__debugSessionCount()).toBe(0);
  });

  it('onExit reason reflects user-initiated close', async () => {
    const { sessionId } = await bridge.createSession({
      cwd: '/tmp',
      genericPtyConfig: validConfig,
    });
    await bridge.closeSession(sessionId);
    ptyInstances[0].emitExit(143, 15); // SIGTERM exit
    const endEvent = events.find((e) => e.kind === 'session-end');
    expect((endEvent?.payload as { reason: string }).reason).toBe('user-closed');
  });
});

// ─── onData → emit assistant message ─────────────────────────────────────────

describe('GenericPtyBridge.onData → emit message', () => {
  it('forwards stdout chunks as assistant messages with ANSI escape stripped (F3)', async () => {
    await bridge.createSession({ cwd: '/tmp', genericPtyConfig: validConfig });
    events.length = 0;
    ptyInstances[0].emitData('chunk-1');
    ptyInstances[0].emitData('\x1b[31mred\x1b[0m');
    ptyInstances[0].emitData('\x1b]0;title\x07ok'); // OSC 序列
    const assistantMsgs = events.filter(
      (e) => e.kind === 'message' && (e.payload as { role: string }).role === 'assistant',
    );
    expect(assistantMsgs.length).toBe(3);
    expect((assistantMsgs[0].payload as { text: string }).text).toBe('chunk-1');
    // F3：strip ANSI 后纯文本
    expect((assistantMsgs[1].payload as { text: string }).text).toBe('red');
    expect((assistantMsgs[2].payload as { text: string }).text).toBe('ok');
  });
});

// ─── shutdownAll ─────────────────────────────────────────────────────────────

describe('GenericPtyBridge.shutdownAll', () => {
  it('SIGKILLs all live sessions + clears map', async () => {
    const { sessionId: s1 } = await bridge.createSession({
      cwd: '/tmp',
      genericPtyConfig: validConfig,
    });
    const { sessionId: s2 } = await bridge.createSession({
      cwd: '/tmp',
      genericPtyConfig: validConfig,
    });
    expect(bridge.__debugSessionCount()).toBe(2);
    await bridge.shutdownAll();
    expect(bridge.__debugSessionCount()).toBe(0);
    // 两个 PTY 都被 SIGKILL
    expect(ptyInstances[0].killed).toContain('SIGKILL');
    expect(ptyInstances[1].killed).toContain('SIGKILL');
    void s1;
    void s2;
  });
});

// ─── F3：idle detection → emit waiting-for-user ──────────────────────────────

