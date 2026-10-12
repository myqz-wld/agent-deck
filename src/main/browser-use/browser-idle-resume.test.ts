import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '@shared/types';

const mocks = vi.hoisted(() => ({
  rows: [] as SessionRecord[],
  claims: new Set<string>(),
  disposeOwner: vi.fn(async () => {}),
  clearOwner: vi.fn(),
}));

vi.mock('@main/store/session-repo', () => ({ sessionRepo: {
  findActiveExpiring: () => [],
  findDormantExpiring: (threshold: number) =>
    mocks.rows.filter((row) => row.lifecycle === 'dormant' && row.lastEventAt < threshold),
  batchAdvanceLifecycle: (ids: string[]) => mocks.rows.filter((row) => {
    if (!ids.includes(row.id)) return false;
    row.lifecycle = 'closed';
    return true;
  }),
  get: (id: string) => mocks.rows.find((row) => row.id === id),
} }));
vi.mock('@main/session/manager', () => ({ sessionManager: {
  hasSdkClaim: (id: string) => mocks.claims.has(id),
  bumpCloseEpoch: vi.fn(),
  runClosedSideEffects: vi.fn(async () => {}),
} }));
vi.mock('@main/event-bus', () => ({ eventBus: { emit: vi.fn() } }));
vi.mock('./engine/registry', () => ({ getBrowserEngine: () => ({
  peek: () => ({}),
  disposeOwner: mocks.disposeOwner,
}) }));
vi.mock('./browser-state-projection', () => ({ getBrowserStateProjectionRegistry: () => ({
  clearOwner: mocks.clearOwner,
}) }));

import { LifecycleScheduler } from '@main/session/lifecycle-scheduler';
import { DEFAULT_SETTINGS } from '@shared/types/settings/defaults';
import { createCodexAppServerProcessStarter } from '@main/adapters/codex-cli/app-server/client-process-host';
import { BrowserLeaseRegistryCore } from './browser-lease-registry-core';
import { BrowserRuntimeContextManager } from './browser-runtime-context';
import {
  refreshBrowserRuntimeSession,
  setBrowserRuntimeContextManagerForTests,
} from './browser-runtime-context-host';
import { disposeSessionBrowser } from './session-browser';

let root: string;
let manager: BrowserRuntimeContextManager;
let registry: BrowserLeaseRegistryCore;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
  mocks.rows = [];
  mocks.claims.clear();
  vi.clearAllMocks();
  root = mkdtempSync(join(tmpdir(), 'browser-idle-resume-'));
  registry = new BrowserLeaseRegistryCore();
  manager = new BrowserRuntimeContextManager({
    rootDir: join(root, 'contexts'),
    brokerEndpoint: join(root, 'broker.sock'),
    executablePath: process.execPath,
    cliPath: join(root, 'agent-deck-browser.cjs'),
    registry,
  });
  setBrowserRuntimeContextManagerForTests(manager);
});

afterEach(() => {
  manager.shutdown();
  setBrowserRuntimeContextManagerForTests(null);
  rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});

function prepareIdleSession(live = true) {
  const id = 'idle-session';
  mocks.rows = [{
    id, cliSessionId: 'native-thread', lifecycle: 'dormant', lastEventAt: Date.now(),
  } as SessionRecord];
  if (live) mocks.claims.add(id);
  const runtime = manager.prepare({
    applicationSessionId: id, adapterId: 'codex-cli', environment: { PATH: '/usr/bin' },
  });
  return { id, runtime, context: JSON.parse(readFileSync(runtime.contextPath, 'utf8')) };
}

function expireIdleSession() {
  vi.setSystemTime(Date.now() + DEFAULT_SETTINGS.closeAfterMs + 1);
  new LifecycleScheduler({
    activeWindowMs: DEFAULT_SETTINGS.activeWindowMs,
    closeAfterMs: DEFAULT_SETTINGS.closeAfterMs,
    historyRetentionDays: 0,
  }).scan();
}

function processStarter() {
  const spawnProcess = vi.fn(() => ({} as ChildProcessWithoutNullStreams));
  const start = createCodexAppServerProcessStarter({
    spawnProcess: spawnProcess as never,
    resolveBinary: () => '/bundled/codex',
    prependPathDirs: () => {},
  });
  return { start, spawnProcess };
}

describe('Browser lifecycle after the 24-hour idle close', () => {
  it.each(['application', 'native'])(
    'restores the retained provider PATH on the next turn with a %s SDK claim', (claim) => {
      const { id, runtime, context } = prepareIdleSession();
      if (claim === 'native') {
        mocks.claims.delete(id);
        mocks.claims.add('native-thread');
      }
      expireIdleSession();

      expect(mocks.rows[0].lifecycle).toBe('closed');
      expect(mocks.disposeOwner).toHaveBeenCalledWith({ kind: 'session', id });
      expect(mocks.clearOwner).toHaveBeenCalledWith(id);
      expect(() => registry.resolve(context.lease, context)).toThrow();
      rmSync(runtime.runtimeDir, { recursive: true, force: true });

      expect(refreshBrowserRuntimeSession(id)).toBe(true);
      const renewed = JSON.parse(readFileSync(runtime.contextPath, 'utf8'));
      expect(registry.resolve(renewed.lease, renewed)).toMatchObject({ applicationSessionId: id });
      expect(renewed.lease).not.toBe(context.lease);
      expect(() => registry.resolve(context.lease, context)).toThrow();
      const { start, spawnProcess } = processStarter();
      start({ env: runtime.environment });
      expect(spawnProcess).toHaveBeenCalledWith('/bundled/codex', ['app-server', '--stdio'], {
        env: runtime.environment, stdio: 'pipe',
      });
    },
  );

  it('allows Codex process reconnect before a new turn without restoring idle Browser access', () => {
    const { id, runtime } = prepareIdleSession();
    expireIdleSession();
    const { start, spawnProcess } = processStarter();

    expect(() => start({ env: runtime.environment })).not.toThrow();
    expect(spawnProcess).toHaveBeenCalledOnce();
    expect(registry.diagnostics().activeLeases).toBe(0);
    expect(refreshBrowserRuntimeSession(id)).toBe(true);
  });

  it('permanently removes unowned idle contexts', () => {
    const { id, runtime } = prepareIdleSession(false);
    expireIdleSession();

    expect(refreshBrowserRuntimeSession(id)).toBe(false);
    expect(() => readFileSync(runtime.contextPath)).toThrow();
  });

  it('does not block chat or restore Browser authority when remounting an idle layout fails', () => {
    const { id, runtime } = prepareIdleSession();
    expireIdleSession();
    rmSync(runtime.binDir, { recursive: true, force: true });
    symlinkSync(root, runtime.binDir, 'dir');

    expect(refreshBrowserRuntimeSession(id)).toBe(false);
    const { start, spawnProcess } = processStarter();
    expect(() => start({ env: runtime.environment })).not.toThrow();
    expect(spawnProcess).toHaveBeenCalledOnce();
    expect(registry.diagnostics().activeLeases).toBe(0);
  });

  it('keeps an explicit close permanent while a stale environment cannot break plain chat', async () => {
    const { id, runtime, context } = prepareIdleSession();
    expireIdleSession();
    await disposeSessionBrowser(id);

    expect(refreshBrowserRuntimeSession(id)).toBe(false);
    const { start, spawnProcess } = processStarter();
    expect(() => start({ env: runtime.environment })).not.toThrow();
    expect(spawnProcess).toHaveBeenCalledOnce();
    expect(() => registry.resolve(context.lease, context)).toThrow();
    expect(registry.diagnostics().activeLeases).toBe(0);
  });
});
