import { describe, expect, it, vi } from 'vitest';
import { installMacApplication } from './local-macos-installation.mjs';

const paths = { sourceApp: '/build/Agent Deck.app', installedApp: '/apps/Agent Deck.app',
  stagingApp: '/apps/.installing.app', previousApp: '/apps/.previous.app', stopRunning: true };

function harness() {
  const files = new Map([[paths.sourceApp, 'new'], [paths.installedApp, 'old']]);
  const events = [];
  let paused = false;
  const restore = vi.fn(async () => { events.push('restore'); paused = false; });
  const operations = {
    exists: (path) => files.has(path),
    remove: vi.fn((path) => { files.delete(path); }),
    move: vi.fn((from, to) => { if (!files.has(from)) throw Error('missing');
      files.set(to, files.get(from)); files.delete(from); }),
    assertStopped: vi.fn(),
    prepare: vi.fn((from, to) => { events.push('prepare'); files.set(to, files.get(from)); }),
    pauseServices: vi.fn(async () => { events.push('pause'); paused = true; return restore; }),
    stop: vi.fn(async () => {
      events.push('stop');
      if (!paused) throw Error('KeepAlive respawned with a new PID');
    }),
    validate: vi.fn(() => { events.push('validate'); }),
  };
  return { files, events, restore, operations };
}

describe('macOS application installation transaction', () => {
  it('pauses auto-restarting services before app shutdown, installs, restores, and removes duplicate copies', async () => {
    const h = harness();
    await installMacApplication(paths, h.operations);
    expect(h.events).toEqual(['prepare', 'pause', 'stop', 'validate', 'restore']);
    expect([...h.files]).toEqual([[paths.installedApp, 'new']]);
    expect(h.restore).toHaveBeenCalledOnce();
  });

  it('does not stop any service without --stop-running', async () => {
    const h = harness();
    await installMacApplication({ ...paths, stopRunning: false }, h.operations);
    expect(h.operations.pauseServices).not.toHaveBeenCalled();
    expect(h.operations.stop).not.toHaveBeenCalled();
  });

  it('cleans a staged copy on signing or shutdown failure without deleting the installed app', async () => {
    for (const failing of ['prepare', 'pauseServices', 'stop']) {
      const h = harness();
      h.operations[failing].mockImplementation(() => {
        h.files.set(paths.stagingApp, 'partial'); throw Error(failing + ' failed');
      });
      await expect(installMacApplication(paths, h.operations)).rejects.toThrow(failing + ' failed');
      expect(h.files.get(paths.installedApp)).toBe('old');
      expect(h.files.has(paths.stagingApp)).toBe(false);
      expect(h.files.get(paths.sourceApp)).toBe('new');
      expect(h.restore).toHaveBeenCalledTimes(failing === 'stop' ? 1 : 0);
    }
  });

  it('restores the old app and paused services when promotion or installed validation fails', async () => {
    for (const failing of ['move', 'validate']) {
      const h = harness();
      if (failing === 'validate') h.operations.validate.mockImplementation(() => { throw Error('bad signature'); });
      else {
        const move = h.operations.move.getMockImplementation();
        h.operations.move.mockImplementation((from, to) => {
          if (from === paths.stagingApp) throw Error('promotion failed');
          move(from, to);
        });
      }
      await expect(installMacApplication(paths, h.operations)).rejects.toThrow();
      expect(h.files.get(paths.installedApp)).toBe('old');
      expect(h.files.has(paths.previousApp)).toBe(false);
      expect(h.files.has(paths.stagingApp)).toBe(false);
      expect(h.restore).toHaveBeenCalledOnce();
    }
  });

  it('preserves a recovery backup instead of discarding it on another attempt', async () => {
    const h = harness(); h.files.set(paths.previousApp, 'recovery');
    await expect(installMacApplication(paths, h.operations)).rejects.toThrow('安装备份');
    expect(h.files.get(paths.previousApp)).toBe('recovery');
    expect(h.operations.pauseServices).not.toHaveBeenCalled();
  });

  it('retains rollback evidence and reports a service restore failure after a successful replacement', async () => {
    const h = harness(); h.restore.mockRejectedValue(Error('restore failed'));
    await expect(installMacApplication(paths, h.operations)).rejects.toThrow('restore failed');
    expect(h.files.get(paths.installedApp)).toBe('new');
    expect(h.files.get(paths.previousApp)).toBe('old');
    expect(h.files.has(paths.stagingApp)).toBe(false);
  });

  it('keeps the prior app backup when rollback itself fails', async () => {
    const h = harness(); const move = h.operations.move.getMockImplementation();
    h.operations.validate.mockImplementation(() => { throw Error('validation failed'); });
    h.operations.move.mockImplementation((from, to) => {
      if (from === paths.previousApp) throw Error('rollback blocked');
      move(from, to);
    });
    await expect(installMacApplication(paths, h.operations)).rejects.toThrow('安装备份恢复失败');
    expect(h.files.get(paths.previousApp)).toBe('old');
    expect(h.files.has(paths.stagingApp)).toBe(false);
  });
});
