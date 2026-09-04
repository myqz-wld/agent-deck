import { readFileSync, rmSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { BrowserLeaseRegistryCore, BrowserLeaseResolutionError } from './browser-lease-registry-core';
import { BrowserRuntimeContextManager } from './browser-runtime-context';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'agent-deck-browser-runtime-'));
  tempDirs.push(root);
  const registry = new BrowserLeaseRegistryCore();
  const manager = new BrowserRuntimeContextManager({
    rootDir: join(root, 'contexts'),
    brokerEndpoint: join(root, 'broker.sock'),
    executablePath: "/Applications/Agent Deck's Test.app/Electron",
    cliPath: join(root, 'resources', 'agent-deck-browser.cjs'),
    registry,
  });
  return { manager, registry, root };
}

describe('session-scoped Browser CLI runtime context', () => {
  it('creates a private shim/context and prepends only the shim directory to provider PATH', async () => {
    const { manager, registry } = await setup();
    const prepared = manager.prepare({
      applicationSessionId: 'session-secret-id',
      adapterId: 'claude-code',
      environment: { PATH: '/usr/bin:/bin', KEEP: 'yes' },
    });

    expect(prepared.environment.KEEP).toBe('yes');
    expect(prepared.environment.PATH).toBe(`${prepared.binDir}${delimiter}/usr/bin:/bin`);
    expect(prepared.environment.AGENT_DECK_BROWSER_RUNTIME_KEY).toBe(prepared.runtimeKey);
    expect(prepared.environment.AGENT_DECK_BROWSER_BIN_DIR).toBe(prepared.binDir);
    expect(statSync(prepared.runtimeDir).mode & 0o777).toBe(0o700);
    expect(statSync(prepared.contextPath).mode & 0o777).toBe(0o600);
    expect(statSync(prepared.commandPath).mode & 0o777).toBe(0o700);

    const context = JSON.parse(readFileSync(prepared.contextPath, 'utf8'));
    expect(Object.keys(context).sort()).toEqual([
      'adapterId', 'endpoint', 'lease', 'protocolVersion', 'runtimeGeneration', 'sourceIdentity',
    ]);
    expect(JSON.stringify(context)).not.toContain('session-secret-id');
    const shim = readFileSync(prepared.commandPath, 'utf8');
    expect(shim).not.toContain(context.lease);
    expect(shim).not.toContain('session-secret-id');
    expect(registry.resolve(context.lease, {
      adapterId: context.adapterId,
      runtimeGeneration: context.runtimeGeneration,
      sourceIdentity: context.sourceIdentity,
    })).toMatchObject({ applicationSessionId: 'session-secret-id' });
  });

  it('rotates on runtime replacement and stale generation cleanup cannot revoke the replacement', async () => {
    const { manager, registry } = await setup();
    const first = manager.prepare({
      applicationSessionId: 'session-a', adapterId: 'codex-cli', environment: { PATH: '/bin' },
    });
    const firstContext = JSON.parse(readFileSync(first.contextPath, 'utf8'));
    const second = manager.refresh(first.runtimeKey);
    const secondContext = JSON.parse(readFileSync(second.contextPath, 'utf8'));

    expect(second.runtimeGeneration).toBe(first.runtimeGeneration + 1);
    expect(secondContext.lease).not.toBe(firstContext.lease);
    expect(() => registry.resolve(firstContext.lease, {
      adapterId: 'codex-cli', runtimeGeneration: 1, sourceIdentity: firstContext.sourceIdentity,
    })).toThrow(BrowserLeaseResolutionError);
    expect(manager.revokeRuntime(first.runtimeKey, first.runtimeGeneration)).toBe(false);
    expect(registry.resolve(secondContext.lease, {
      adapterId: 'codex-cli',
      runtimeGeneration: second.runtimeGeneration,
      sourceIdentity: secondContext.sourceIdentity,
    })).toMatchObject({ applicationSessionId: 'session-a' });
  });

  it('remounts the same private PATH after temp cleanup and renews an expired session lease', async () => {
    let now = 1_000;
    const root = await mkdtemp(join(tmpdir(), 'agent-deck-browser-runtime-remount-'));
    tempDirs.push(root);
    const registry = new BrowserLeaseRegistryCore({ now: () => now });
    const manager = new BrowserRuntimeContextManager({
      rootDir: join(root, 'contexts'),
      brokerEndpoint: join(root, 'broker.sock'),
      executablePath: process.execPath,
      cliPath: join(root, 'resources', 'agent-deck-browser.cjs'),
      registry,
    });
    const first = manager.prepare({
      applicationSessionId: 'session-remount',
      adapterId: 'codex-cli',
      environment: { PATH: '/usr/bin' },
    });
    const firstContext = JSON.parse(readFileSync(first.contextPath, 'utf8'));
    rmSync(join(root, 'contexts'), { recursive: true, force: true });
    now += 24 * 60 * 60_000 + 1;

    const renewed = manager.refreshSession('session-remount');
    const renewedContext = JSON.parse(readFileSync(first.contextPath, 'utf8'));

    expect(renewed).toMatchObject({
      runtimeDir: first.runtimeDir,
      binDir: first.binDir,
      commandPath: first.commandPath,
      runtimeGeneration: 2,
    });
    expect(statSync(first.commandPath).isFile()).toBe(true);
    expect(() => registry.resolve(firstContext.lease, {
      adapterId: firstContext.adapterId,
      runtimeGeneration: firstContext.runtimeGeneration,
      sourceIdentity: firstContext.sourceIdentity,
    })).toThrow(BrowserLeaseResolutionError);
    expect(registry.resolve(renewedContext.lease, {
      adapterId: renewedContext.adapterId,
      runtimeGeneration: renewedContext.runtimeGeneration,
      sourceIdentity: renewedContext.sourceIdentity,
    })).toMatchObject({ applicationSessionId: 'session-remount' });
  });

  it('renames and revokes the application owner without changing the command context', async () => {
    const { manager, registry } = await setup();
    const prepared = manager.prepare({
      applicationSessionId: 'temporary', adapterId: 'grok-build', environment: {},
    });
    const context = JSON.parse(readFileSync(prepared.contextPath, 'utf8'));

    expect(manager.renameSession('temporary', 'canonical')).toBe(1);
    expect(registry.resolve(context.lease, {
      adapterId: 'grok-build',
      runtimeGeneration: context.runtimeGeneration,
      sourceIdentity: context.sourceIdentity,
    })).toMatchObject({ applicationSessionId: 'canonical' });
    expect(manager.revokeSession('canonical')).toBe(1);
    expect(() => statSync(prepared.runtimeDir)).toThrow();
    expect(() => registry.resolve(context.lease, {
      adapterId: 'grok-build',
      runtimeGeneration: context.runtimeGeneration,
      sourceIdentity: context.sourceIdentity,
    })).toThrow(BrowserLeaseResolutionError);
  });

  it('generates the Windows command shim and preserves the existing Path casing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-deck-browser-runtime-win-'));
    tempDirs.push(root);
    const manager = new BrowserRuntimeContextManager({
      rootDir: join(root, 'contexts'),
      brokerEndpoint: '\\\\.\\pipe\\agent-deck-browser',
      executablePath: 'C:\\Program Files\\Agent Deck\\Agent Deck.exe',
      cliPath: 'C:\\Program Files\\Agent Deck\\resources\\agent-deck-browser.cjs',
      registry: new BrowserLeaseRegistryCore(),
      platform: 'win32',
    });
    const prepared = manager.prepare({
      applicationSessionId: 'session-win',
      adapterId: 'codex-cli',
      environment: { Path: 'C:\\Windows\\System32', PATH: 'stale' },
    });

    expect(prepared.commandPath).toMatch(/agent-deck-browser\.cmd$/);
    expect(prepared.environment.Path).toBe(
      `${prepared.binDir};C:\\Windows\\System32`,
    );
    expect(prepared.environment.PATH).toBeUndefined();
    const command = readFileSync(prepared.commandPath, 'utf8');
    expect(command).toContain('ELECTRON_RUN_AS_NODE=1');
    expect(command).not.toContain('session-win');
    manager.shutdown();
  });
});
