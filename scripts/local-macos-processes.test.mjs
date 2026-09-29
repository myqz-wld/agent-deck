import { describe, expect, it, vi } from 'vitest';
import {
  assertInstalledAppStopped,
  installedAppProcesses,
  parseProcessTable,
  stopInstalledApp,
} from './local-macos-processes.mjs';

const app = '/Applications/Agent Deck.app';
const main = { pid: 101, parentPid: 1, startedAt: 'Mon Sep 28 09:00:00 2026', executable: `${app}/Contents/MacOS/Agent Deck` };
const helper = { ...main, pid: 102, parentPid: 101, executable: `${app}/Contents/Frameworks/Agent Deck Helper.app/Contents/MacOS/Agent Deck Helper` };
const other = { ...helper, pid: 201, executable: '/Applications/Other.app/Contents/MacOS/Agent Deck Helper' };

function harness(initial) {
  let rows = initial;
  let clock = 0;
  const signal = vi.fn((pid) => { rows = rows.filter((row) => row.pid !== pid); });
  const quit = vi.fn();
  return {
    set: (next) => { rows = next; },
    options: { read: () => rows, signal, quit, now: () => clock,
      sleep: async (ms) => { clock += ms; }, graceMs: 500, terminateMs: 500 },
  };
}

describe('installed macOS process identity', () => {
  it('parses the full executable path and normalizes process start time', () => {
    expect(parseProcessTable(` 101 1 Mon Sep  7 09:00:00 2026 ${main.executable}\n`)).toEqual([
      { ...main, startedAt: 'Mon Sep 7 09:00:00 2026' },
    ]);
    expect(() => parseProcessTable('unparseable output')).toThrow('无法解析');
  });

  it('excludes similarly named apps and other copies, but includes orphaned bundle runtimes', () => {
    const copy = { ...main, pid: 301, executable: '/tmp/Agent Deck.app/Contents/MacOS/Agent Deck' };
    const sibling = { ...main, pid: 401, executable: `${app}.backup/Contents/MacOS/Agent Deck` };
    const orphan = { ...helper, parentPid: 1 };
    expect(installedAppProcesses(app, [main, orphan, copy, sibling, other])).toEqual([main, orphan]);
  });

  it('requires exit by default and propagates process inspection errors', () => {
    expect(() => assertInstalledAppStopped(app, () => [main])).toThrow('--stop-running');
    expect(() => assertInstalledAppStopped(app, () => [other])).not.toThrow();
    expect(() => assertInstalledAppStopped(app, () => { throw new Error('ps failed'); })).toThrow('ps failed');
  });
});

describe('verified macOS app shutdown', () => {
  it('does nothing when the installed app is already stopped', async () => {
    const h = harness([other]);
    await stopInstalledApp(app, h.options);
    expect(h.options.quit).not.toHaveBeenCalled();
    expect(h.options.signal).not.toHaveBeenCalled();
  });

  it('allows graceful exit without sending signals', async () => {
    const h = harness([main, helper, other]);
    h.options.quit.mockImplementation(() => h.set([other]));
    await stopInstalledApp(app, h.options);
    expect(h.options.quit).toHaveBeenCalledOnce();
    expect(h.options.signal).not.toHaveBeenCalled();
  });

  it('signals only verified bundle PIDs after graceful exit fails', async () => {
    const h = harness([main, helper, other]);
    h.options.quit.mockImplementation(() => { throw new Error('Apple Event timeout'); });
    await stopInstalledApp(app, h.options);
    expect(h.options.signal.mock.calls).toEqual([[101], [102]]);
  });

  it('rejects multiple main processes without requesting quit or sending signals', async () => {
    const h = harness([main, { ...main, pid: 103 }]);
    await expect(stopInstalledApp(app, h.options)).rejects.toThrow('多个');
    expect(h.options.quit).not.toHaveBeenCalled();
    expect(h.options.signal).not.toHaveBeenCalled();
  });

  it('aborts if a PID is reused by a new instance at the same executable path', async () => {
    const h = harness([main]);
    h.options.quit.mockImplementation(() => h.set([{ ...main, startedAt: 'Mon Sep 28 09:01:00 2026' }]));
    await expect(stopInstalledApp(app, h.options)).rejects.toThrow('身份已变化');
    expect(h.options.signal).not.toHaveBeenCalled();
  });

  it('does not signal a PID reused by an unrelated executable', async () => {
    const h = harness([main]);
    h.options.quit.mockImplementation(() => h.set([{ ...other, pid: main.pid }]));
    await stopInstalledApp(app, h.options);
    expect(h.options.signal).not.toHaveBeenCalled();
  });

  it('revalidates between signals and refuses a newly spawned helper', async () => {
    const h = harness([main, helper]);
    h.options.signal.mockImplementation(() => h.set([helper, { ...helper, pid: 104 }]));
    await expect(stopInstalledApp(app, h.options)).rejects.toThrow('身份已变化');
    expect(h.options.signal.mock.calls).toEqual([[101]]);
  });

  it('fails closed after the bounded SIGTERM wait without escalating to SIGKILL', async () => {
    const h = harness([main]);
    h.options.signal.mockImplementation(() => {});
    await expect(stopInstalledApp(app, h.options)).rejects.toThrow('未在期限内退出');
    expect(h.options.signal.mock.calls).toEqual([[101]]);
  });

  it('accepts exit between revalidation and signal delivery', async () => {
    const h = harness([main]);
    h.options.signal.mockImplementation(() => {
      h.set([]);
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
    await stopInstalledApp(app, h.options);
  });
});
