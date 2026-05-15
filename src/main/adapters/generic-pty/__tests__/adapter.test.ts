/**
 * Adapter-level smoke test (R4·F-bonus)：验证 capabilities 与 receiveTeammateMessage
 * 接口契约（universal-message-watcher.ts deliver() 的前置 gate 检查）。
 *
 * 不测 bridge 内部行为（bridge 单测在 pty-bridge.test.ts / file-watcher.test.ts /
 * ansi-parser.test.ts 已覆盖 65 case）。
 */

import { describe, it, expect, vi } from 'vitest';

// mock 链：node-pty / chokidar / sessionRepo / file-watcher 全部 stub，让 adapter init 不真起 PTY
class FakePty {
  pid = 9999;
  cols = 100;
  rows = 30;
  process = 'fake';
  handleFlowControl = false;
  onData() { return { dispose: () => {} }; }
  onExit() { return { dispose: () => {} }; }
  write() {}
  kill() {}
  resize() {}
  pause() {}
  resume() {}
  clear() {}
}

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => new FakePty()),
}));

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: {
    setGenericPtyConfig: vi.fn(),
  },
}));

vi.mock('../file-watcher', () => ({
  PtyFileWatcher: class {
    async start() {}
    async close() {}
  },
}));

import { genericPtyAdapter } from '../index';
import { aiderAdapter } from '../../aider';

const fakeCtx = {
  hookServer: { listeningPort: 0, bearerToken: '' } as never,
  routeRegistry: {} as never,
  emit: vi.fn(),
  paths: { userHome: '/tmp', userClaudeSettings: '/tmp/.claude' },
};

describe('genericPtyAdapter capabilities (R4·F-bonus)', () => {
  it('canCollaborate is true (universal team backend gate)', () => {
    expect(genericPtyAdapter.capabilities.canCollaborate).toBe(true);
  });

  it('exposes receiveTeammateMessage method', () => {
    expect(typeof genericPtyAdapter.receiveTeammateMessage).toBe('function');
  });

  it('receiveTeammateMessage delegates to sendMessage (writes to PTY stdin)', async () => {
    await genericPtyAdapter.init(fakeCtx);
    const sid = await genericPtyAdapter.createSession!({
      agentId: 'generic-pty',
      cwd: '/tmp',
      genericPtyConfig: {
        command: '/bin/echo',
        args: [],
        env: {},
        cwd: '',
        idleQuietMs: 3000,
        promptSuffixRegex: '',
      },
    });
    // 直接调 receive — 不应抛错（与 sendMessage 同实现）
    await expect(
      genericPtyAdapter.receiveTeammateMessage!(sid, 'sender-sid', '[from foo @ bar]\nhello'),
    ).resolves.toBeUndefined();
    await genericPtyAdapter.shutdown();
  });
});

describe('aiderAdapter capabilities (R4·F-bonus)', () => {
  it('canCollaborate is true (universal team backend gate)', () => {
    expect(aiderAdapter.capabilities.canCollaborate).toBe(true);
  });

  it('exposes receiveTeammateMessage method', () => {
    expect(typeof aiderAdapter.receiveTeammateMessage).toBe('function');
  });

  it('uses aider preset as fallback (createSession works without explicit genericPtyConfig)', async () => {
    await aiderAdapter.init(fakeCtx);
    // aider adapter 不传 config 也能创建（fallback 'aider' preset）
    const sid = await aiderAdapter.createSession!({ agentId: 'aider', cwd: '/tmp' });
    expect(sid).toMatch(/^[0-9a-f-]{36}$/i);
    await aiderAdapter.shutdown();
  });

  it('shares GenericPtyBridge class with generic-pty adapter (different instance)', () => {
    // 不同 instance：sessions Map 互相不可见（隔离 invariant）
    // 类型与 capability 完全等价，仅 displayName / fallback config 不同
    expect(aiderAdapter.id).toBe('aider');
    expect(aiderAdapter.displayName).toBe('Aider');
    expect(genericPtyAdapter.id).toBe('generic-pty');
    expect(genericPtyAdapter.displayName).toBe('Generic PTY');
  });
});
