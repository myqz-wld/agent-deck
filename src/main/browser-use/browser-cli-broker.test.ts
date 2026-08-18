import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BrowserEngine, setBrowserEngine } from './engine/registry';
import { fakeWindowFactory } from './engine/__tests__/_fakes';
import { BrowserLeaseRegistryCore } from './browser-lease-registry-core';
import {
  startBrowserCliBroker,
  type BrowserCliBrokerHandle,
} from './browser-cli-broker';
import { BrowserRuntimeContextManager } from './browser-runtime-context';
import { browserOperationSuccess } from './operation-contract';
import {
  BrowserStateProjectionRegistry,
  getBrowserStateProjectionRegistry,
  setBrowserStateProjectionRegistry,
} from './browser-state-projection';

interface CliApi {
  invokeBroker(context: Record<string, unknown>, request: unknown): Promise<any>;
}

const require = createRequire(import.meta.url);
const cli = require(resolve(process.cwd(), 'resources/bin/agent-deck-browser.cjs')) as CliApi;
const handles: BrowserCliBrokerHandle[] = [];
const tempDirs: string[] = [];

const IDENTITY = {
  applicationSessionId: 'session-a',
  adapterId: 'codex-cli',
  runtimeGeneration: 1,
  sourceIdentity: 'runtime-a',
} as const;

beforeEach(() => {
  setBrowserEngine(new BrowserEngine(fakeWindowFactory()));
  setBrowserStateProjectionRegistry(new BrowserStateProjectionRegistry());
});

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.shutdown()));
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  setBrowserEngine(null);
  setBrowserStateProjectionRegistry(null);
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'agent-deck-browser-broker-'));
  tempDirs.push(root);
  const registry = new BrowserLeaseRegistryCore();
  const persistScreenshot = vi.fn(async () => join(root, 'artifact.png'));
  const handle = await startBrowserCliBroker({
    pipePath: process.platform === 'win32'
      ? `\\\\.\\pipe\\agent-deck-browser-test-${process.pid}-${Date.now()}`
      : join(root, 'broker.sock'),
    registry,
    persistScreenshot,
  });
  handles.push(handle);
  const issued = registry.issue(IDENTITY, 60_000);
  const context = {
    protocolVersion: 1,
    endpoint: handle.endpoint,
    lease: issued.lease,
    adapterId: IDENTITY.adapterId,
    runtimeGeneration: IDENTITY.runtimeGeneration,
    sourceIdentity: IDENTITY.sourceIdentity,
  };
  return { context, handle, issued, persistScreenshot, registry };
}

describe('Browser CLI private broker', () => {
  it('authenticates ambient lease/proof and executes for the resolved application session', async () => {
    const { context } = await setup();
    const opened = await cli.invokeBroker(context, {
      protocolVersion: 1, operation: 'open', args: { url: 'localhost:4123' },
    });
    const tabs = await cli.invokeBroker(context, {
      protocolVersion: 1, operation: 'tabs', args: {},
    });

    expect(opened).toMatchObject({ ok: true, operation: 'open', data: { tabId: 1 } });
    expect(tabs).toMatchObject({ ok: true, operation: 'tabs', data: { tabs: [{ id: 1 }] } });
    expect(JSON.stringify({ opened, tabs })).not.toMatch(/session-a|runtime-a|lease/);
    expect(getBrowserStateProjectionRegistry().get({
      kind: 'local', sessionId: 'session-a',
    })).toMatchObject({ tabs: [{ id: 1, active: true }] });
  });

  it('allows a trusted Core executor to receive resolved identity out of band', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-deck-browser-broker-core-'));
    tempDirs.push(root);
    const registry = new BrowserLeaseRegistryCore();
    const execute = vi.fn(async (binding, request) =>
      browserOperationSuccess(request.operation, { tabs: [], adapter: binding.adapterId }));
    const handle = await startBrowserCliBroker({
      pipePath: process.platform === 'win32'
        ? `\\\\.\\pipe\\agent-deck-browser-core-${process.pid}-${Date.now()}`
        : join(root, 'broker.sock'),
      registry,
      execute,
    });
    handles.push(handle);
    const issued = registry.issue(IDENTITY, 60_000);
    const result = await cli.invokeBroker({
      protocolVersion: 1,
      endpoint: handle.endpoint,
      lease: issued.lease,
      adapterId: IDENTITY.adapterId,
      runtimeGeneration: IDENTITY.runtimeGeneration,
      sourceIdentity: IDENTITY.sourceIdentity,
    }, { protocolVersion: 1, operation: 'tabs', args: {} });

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ applicationSessionId: 'session-a' }),
      expect.objectContaining({ operation: 'tabs' }),
    );
    expect(result).toMatchObject({ ok: true, data: { tabs: [], adapter: 'codex-cli' } });
    expect(JSON.stringify(result)).not.toContain('session-a');
  });

  it('rejects proof mismatch, revocation, replay, and request identity spoofing', async () => {
    const { context, issued, registry } = await setup();
    const wrongRuntime = await cli.invokeBroker({ ...context, sourceIdentity: 'runtime-b' }, {
      protocolVersion: 1, operation: 'tabs', args: {},
    });
    expect(wrongRuntime).toMatchObject({
      ok: false,
      error: { code: 'browser_context_unavailable' },
    });

    const spoofed = await cli.invokeBroker(context, {
      protocolVersion: 1, operation: 'tabs', args: {}, sessionId: 'session-b',
    });
    expect(spoofed).toMatchObject({ ok: false, error: { code: 'invalid_request' } });

    registry.revoke(issued.lease);
    const revoked = await cli.invokeBroker(context, {
      protocolVersion: 1, operation: 'tabs', args: {},
    });
    expect(revoked).toMatchObject({
      ok: false,
      error: { code: 'browser_context_unavailable' },
    });
    expect(JSON.stringify(revoked)).not.toContain(issued.lease);
  });

  it('persists screenshot bytes in the resolved owner scope and returns metadata only', async () => {
    const { context, persistScreenshot } = await setup();
    await cli.invokeBroker(context, {
      protocolVersion: 1, operation: 'open', args: {},
    });
    const screenshot = await cli.invokeBroker(context, {
      protocolVersion: 1, operation: 'screenshot', args: { maxWidth: 800 },
    });

    expect(persistScreenshot).toHaveBeenCalledWith(
      expect.stringMatching(/^cli-[a-f0-9]{24}$/),
      1,
      expect.any(Buffer),
    );
    expect(screenshot).toMatchObject({
      ok: true,
      operation: 'screenshot',
      artifacts: [{ name: 'browser-screenshot.png', mimeType: 'image/png' }],
    });
    expect(JSON.stringify(screenshot)).not.toContain('Buffer');
  });

  it('executes the real session shim without any model-supplied session identity', async () => {
    const { handle, registry } = await setup();
    const root = tempDirs.at(-1);
    if (!root) throw new Error('missing test root');
    const manager = new BrowserRuntimeContextManager({
      rootDir: join(root, 'runtime-contexts'),
      brokerEndpoint: handle.endpoint,
      executablePath: process.execPath,
      cliPath: resolve(process.cwd(), 'resources/bin/agent-deck-browser.cjs'),
      registry,
    });
    const prepared = manager.prepare({
      applicationSessionId: 'shim-owned-session',
      adapterId: 'claude-code',
      environment: Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] =>
          typeof entry[1] === 'string'),
      ),
    });
    const child = spawn(prepared.commandPath, ['open', '--url', 'about:blank'], {
      cwd: root,
      env: prepared.environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    const exit = await new Promise<number | null>((resolveExit, reject) => {
      child.once('error', reject);
      child.once('exit', resolveExit);
    });

    expect(exit, stderr).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      ok: true,
      operation: 'open',
      data: { tabId: 1, url: 'about:blank' },
    });
    expect(stdout).not.toContain('shim-owned-session');

    if (process.platform !== 'win32') {
      for (const [shell, shellArgs] of [
        ['/bin/zsh', ['-lc', 'agent-deck-browser tabs']],
        ['/bin/sh', ['-c', 'agent-deck-browser tabs']],
      ] as const) {
        if (!await import('node:fs/promises').then((fs) => fs.access(shell).then(() => true, () => false))) {
          continue;
        }
        const shellChild = spawn(shell, [...shellArgs], {
          cwd: root,
          env: prepared.environment,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let shellStdout = '';
        let shellStderr = '';
        shellChild.stdout.setEncoding('utf8');
        shellChild.stderr.setEncoding('utf8');
        shellChild.stdout.on('data', (chunk: string) => { shellStdout += chunk; });
        shellChild.stderr.on('data', (chunk: string) => { shellStderr += chunk; });
        const shellExit = await new Promise<number | null>((resolveExit, reject) => {
          shellChild.once('error', reject);
          shellChild.once('exit', resolveExit);
        });
        expect(shellExit, `${shell}: ${shellStderr}`).toBe(0);
        const jsonLine = shellStdout.trim().split('\n').at(-1) ?? '';
        expect(JSON.parse(jsonLine)).toMatchObject({ ok: true, operation: 'tabs' });
      }
    }
    manager.shutdown();
  });
});
