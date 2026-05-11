/**
 * file-watcher.ts 单测（R4·F4）。
 *
 * 完全 mock chokidar（通过 watchFactory 注入 fake watch）—— 不 import 真的
 * chokidar，避免在 vitest node env 下启动 fsevents / 文件系统副作用。
 *
 * 守门：
 * - start：调 watch with cwd + ignored 列表（含默认 + extra）+ ignoreInitial:true + awaitWriteFinish
 * - skipHomedirWatch=true 时 cwd=~ noop（不 watch）
 * - add / change / unlink → emit file-changed AgentEvent (kind='fs-event' + metadata.fsEvent)
 * - close 调 fake watcher.close() + 多次 close 安全
 * - close 后 emit noop（不漏 race）
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { PtyFileWatcher, DEFAULT_IGNORED_PATTERNS, type PtyFileWatcherOptions } from '../file-watcher';
import type { AgentEvent } from '@shared/types';

// ─── fake chokidar.watch ────────────────────────────────────────────────────

interface FakeWatcherCalls {
  cwd: string;
  options: Record<string, unknown>;
}

class FakeFSWatcher {
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  closed = false;
  closeCalls = 0;

  on(event: string, cb: (...args: unknown[]) => void): this {
    const arr = this.listeners.get(event) ?? [];
    arr.push(cb);
    this.listeners.set(event, arr);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    const arr = this.listeners.get(event);
    if (!arr) return;
    for (const cb of arr) cb(...args);
  }

  async close(): Promise<void> {
    this.closeCalls++;
    this.closed = true;
  }
}

let factoryCalls: FakeWatcherCalls[] = [];
let lastWatcher: FakeFSWatcher | null = null;
let nextWatchError: Error | null = null;

function fakeWatch(cwd: string, options: Record<string, unknown>): FakeFSWatcher {
  factoryCalls.push({ cwd, options });
  if (nextWatchError) {
    const err = nextWatchError;
    nextWatchError = null;
    throw err;
  }
  lastWatcher = new FakeFSWatcher();
  return lastWatcher;
}

let events: AgentEvent[] = [];

beforeEach(() => {
  factoryCalls = [];
  lastWatcher = null;
  events = [];
  nextWatchError = null;
});

function newWatcher(opts: Partial<PtyFileWatcherOptions> = {}) {
  return new PtyFileWatcher({
    cwd: '/tmp/work',
    sessionId: 'sess-abc',
    adapterId: 'generic-pty',
    emit: (e) => events.push(e),
    skipHomedirWatch: true,
    watchFactory: fakeWatch as unknown as typeof import('chokidar').watch,
    ...opts,
  });
}

// ─── start ──────────────────────────────────────────────────────────────────

describe('PtyFileWatcher.start', () => {
  it('calls chokidar.watch with cwd + default ignored + chokidar options', async () => {
    const w = newWatcher();
    await w.start();
    expect(factoryCalls.length).toBe(1);
    expect(factoryCalls[0].cwd).toBe(path.resolve('/tmp/work'));
    expect(factoryCalls[0].options.ignored).toEqual(DEFAULT_IGNORED_PATTERNS);
    expect(factoryCalls[0].options.ignoreInitial).toBe(true);
    expect(factoryCalls[0].options.persistent).toBe(true);
    expect(factoryCalls[0].options.followSymlinks).toBe(false);
    expect(factoryCalls[0].options.awaitWriteFinish).toEqual({
      stabilityThreshold: 100,
      pollInterval: 50,
    });
  });

  it('appends extraIgnored on top of defaults', async () => {
    const w = newWatcher({ extraIgnored: ['**/.venv/**'] });
    await w.start();
    expect(factoryCalls[0].options.ignored).toEqual([...DEFAULT_IGNORED_PATTERNS, '**/.venv/**']);
  });

  it('skips watch when cwd = homedir and skipHomedirWatch=true (default)', async () => {
    const w = newWatcher({ cwd: homedir(), skipHomedirWatch: true });
    await w.start();
    expect(factoryCalls.length).toBe(0); // 未调 chokidar.watch
  });

  it('still watches homedir when skipHomedirWatch=false', async () => {
    const w = newWatcher({ cwd: homedir(), skipHomedirWatch: false });
    await w.start();
    expect(factoryCalls.length).toBe(1);
    expect(factoryCalls[0].cwd).toBe(path.resolve(homedir()));
  });

  it('is idempotent (double start does not re-create watcher)', async () => {
    const w = newWatcher();
    await w.start();
    await w.start();
    expect(factoryCalls.length).toBe(1);
  });

  it('does not throw when chokidar.watch throws (warn + nullify)', async () => {
    nextWatchError = new Error('fs init failed');
    const w = newWatcher();
    await expect(w.start()).resolves.toBeUndefined();
    expect(lastWatcher).toBeNull(); // factory threw before assignment
  });
});

// ─── fs events → AgentEvent emit ─────────────────────────────────────────────

describe('PtyFileWatcher fs events', () => {
  it('emits file-changed (fsEvent=add) on chokidar add', async () => {
    const w = newWatcher();
    await w.start();
    lastWatcher!.emit('add', '/tmp/work/foo.txt');
    expect(events.length).toBe(1);
    expect(events[0].kind).toBe('file-changed');
    expect(events[0].agentId).toBe('generic-pty');
    expect(events[0].sessionId).toBe('sess-abc');
    const p = events[0].payload as {
      cwd: string;
      filePath: string;
      kind: string;
      before: null;
      after: null;
      metadata: { source: string; fsEvent: string };
    };
    expect(p.cwd).toBe('/tmp/work');
    expect(p.filePath).toBe('/tmp/work/foo.txt');
    expect(p.kind).toBe('fs-event');
    expect(p.before).toBeNull();
    expect(p.after).toBeNull();
    expect(p.metadata.source).toBe('pty-fs-watch');
    expect(p.metadata.fsEvent).toBe('add');
  });

  it('emits fsEvent=change on chokidar change', async () => {
    const w = newWatcher();
    await w.start();
    lastWatcher!.emit('change', '/tmp/work/foo.txt');
    expect((events[0].payload as { metadata: { fsEvent: string } }).metadata.fsEvent).toBe('change');
  });

  it('emits fsEvent=unlink on chokidar unlink', async () => {
    const w = newWatcher();
    await w.start();
    lastWatcher!.emit('unlink', '/tmp/work/foo.txt');
    expect((events[0].payload as { metadata: { fsEvent: string } }).metadata.fsEvent).toBe('unlink');
  });

  it('warns but does not crash on chokidar error', async () => {
    const w = newWatcher();
    await w.start();
    expect(() => lastWatcher!.emit('error', new Error('boom'))).not.toThrow();
  });
});

// ─── close ──────────────────────────────────────────────────────────────────

describe('PtyFileWatcher.close', () => {
  it('awaits underlying watcher.close()', async () => {
    const w = newWatcher();
    await w.start();
    await w.close();
    expect(lastWatcher!.closeCalls).toBe(1);
    expect(w.__debugIsClosed()).toBe(true);
  });

  it('is idempotent (double close)', async () => {
    const w = newWatcher();
    await w.start();
    await w.close();
    await w.close();
    expect(lastWatcher!.closeCalls).toBe(1);
  });

  it('emits no events after close (race protection)', async () => {
    const w = newWatcher();
    await w.start();
    await w.close();
    lastWatcher!.emit('add', '/late/file.txt');
    expect(events.length).toBe(0);
  });

  it('close before start is safe (noop)', async () => {
    const w = newWatcher();
    await w.close();
    expect(w.__debugIsClosed()).toBe(true);
    // 即使后续 start 也不会真启动
    await w.start();
    expect(factoryCalls.length).toBe(0);
  });
});
