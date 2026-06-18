import type { SessionRecord } from '@shared/types';
import { describe, expect, it, vi } from 'vitest';
import {
  ExternalProcessTracker,
  extractExternalProcessPid,
  resolveCodexAncestorPid,
} from '../external-process-tracker';

function makeSession(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'sid',
    agentId: 'codex-cli',
    cwd: '/tmp',
    title: 'sid',
    source: 'cli',
    lifecycle: 'active',
    activity: 'idle',
    startedAt: 1,
    lastEventAt: 1,
    endedAt: null,
    archivedAt: null,
    ...over,
  };
}

function intervalStub(): NodeJS.Timeout {
  return { unref: vi.fn() } as unknown as NodeJS.Timeout;
}

describe('ExternalProcessTracker', () => {
  it('closes live external cli sessions when the tracked pid exits', () => {
    const sessions = new Map([['sid', makeSession()]]);
    const closeSession = vi.fn((sid: string) => {
      const rec = sessions.get(sid);
      if (rec) sessions.set(sid, { ...rec, lifecycle: 'closed' });
    });
    const tracker = new ExternalProcessTracker({
      getSession: (sid) => sessions.get(sid) ?? null,
      closeSession,
      isProcessAlive: () => false,
      resolveTrackedPid: (pid) => (pid === 123 ? 999 : null),
      setIntervalFn: () => intervalStub(),
      clearIntervalFn: vi.fn(),
    });

    tracker.register('sid', 123);
    tracker.scanNow();

    expect(closeSession).toHaveBeenCalledWith('sid');
    expect(sessions.get('sid')?.lifecycle).toBe('closed');
  });

  it('does not track a hook runner pid when no codex ancestor can be resolved', () => {
    const sessions = new Map([['sid', makeSession()]]);
    const closeSession = vi.fn();
    const tracker = new ExternalProcessTracker({
      getSession: (sid) => sessions.get(sid) ?? null,
      closeSession,
      isProcessAlive: () => false,
      resolveTrackedPid: () => null,
      setIntervalFn: () => intervalStub(),
      clearIntervalFn: vi.fn(),
    });

    tracker.register('sid', 123);
    tracker.scanNow();

    expect(closeSession).not.toHaveBeenCalled();
    expect(sessions.get('sid')?.lifecycle).toBe('active');
  });

  it('does not close sdk-owned or still-running processes', () => {
    const sessions = new Map([
      ['sdk-sid', makeSession({ id: 'sdk-sid', source: 'sdk' })],
      ['cli-sid', makeSession({ id: 'cli-sid' })],
    ]);
    const closeSession = vi.fn();
    const tracker = new ExternalProcessTracker({
      getSession: (sid) => sessions.get(sid) ?? null,
      closeSession,
      isProcessAlive: (pid) => pid === 456,
      resolveTrackedPid: (pid) => pid,
      setIntervalFn: () => intervalStub(),
      clearIntervalFn: vi.fn(),
    });

    tracker.register('sdk-sid', 123);
    tracker.register('cli-sid', 456);
    tracker.scanNow();

    expect(closeSession).not.toHaveBeenCalled();
  });

  it('extracts only valid external process pids from hook payloads', () => {
    expect(extractExternalProcessPid({ externalProcessPid: 123 })).toBe(123);
    expect(extractExternalProcessPid({ externalProcessPid: process.pid })).toBeNull();
    expect(extractExternalProcessPid({ externalProcessPid: '123' })).toBeNull();
    expect(extractExternalProcessPid(null)).toBeNull();
  });

  it('resolves a codex ancestor instead of the per-hook shell process', () => {
    const resolved = resolveCodexAncestorPid(10, (pid) => {
      if (pid === 10) {
        return { ppid: 11, comm: '/bin/sh', args: 'curl /hook/codex/stop # agent-deck-hook' };
      }
      if (pid === 11) return { ppid: 12, comm: 'hook-runner', args: 'hook runner' };
      if (pid === 12) return { ppid: 1, comm: 'codex', args: 'codex' };
      return null;
    });

    expect(resolved).toBe(12);
  });
});
