import { createRequire } from 'node:module';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { browserOperationSuccess } from '@main/browser-use/operation-contract';

import { ServerCoreBrowserRuntime } from './browser-runtime';

interface CliApi {
  invokeBroker(context: Record<string, unknown>, request: unknown): Promise<unknown>;
}

const cli = createRequire(import.meta.url)(
  resolve(process.cwd(), 'resources/bin/agent-deck-browser.cjs'),
) as CliApi;
const roots: string[] = [];
const runtimes: ServerCoreBrowserRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(enabled = true) {
  const root = await realpath(await mkdtemp(
    join(await realpath('/tmp'), 'adbc-'),
  ));
  roots.push(root);
  const execute = vi.fn(async (_binding, request) =>
    browserOperationSuccess(request.operation, { tabs: [] }));
  const runtime = new ServerCoreBrowserRuntime({
    privateRoot: root,
    executablePath: process.execPath,
    cliPath: resolve(process.cwd(), 'resources/bin/agent-deck-browser.cjs'),
    execute,
    skillEnabled: () => enabled,
  });
  runtimes.push(runtime);
  await runtime.start();
  return { execute, root, runtime };
}

describe('Server Core Browser runtime', () => {
  it('creates an identity-free command context and exact provider sandbox projection', async () => {
    const { execute, runtime } = await setup();
    const prepared = runtime.prepare({
      applicationSessionId: 'remote-session-a',
      adapterId: 'codex-cli',
      environment: { PATH: '/usr/bin:/bin' },
    });
    expect(prepared).not.toBeNull();
    const context = JSON.parse(await import('node:fs/promises').then((fs) =>
      fs.readFile(prepared!.contextPath, 'utf8')));

    const result = await cli.invokeBroker(context, {
      protocolVersion: 1, operation: 'tabs', args: {},
    });

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ applicationSessionId: 'remote-session-a' }),
      expect.objectContaining({ operation: 'tabs' }),
    );
    expect(JSON.stringify(result)).not.toContain('remote-session-a');
    expect(prepared!.environment.PATH?.split(':')[0]).toBe(prepared!.binDir);
    expect(runtime.codexSocketConfig(prepared!.environment)).toMatchObject({
      features: { network_proxy: { enabled: true, unix_sockets: { [context.endpoint]: 'allow' } } },
    });
    expect(runtime.allowClaudeSocket({ sandbox: { network: {} } })).toMatchObject({
      sandbox: { network: { allowUnixSockets: [context.endpoint] } },
    });
  });

  it('gates contexts on the existing provider Skills switch and revokes on rename/close', async () => {
    const disabled = await setup(false);
    expect(disabled.runtime.prepare({
      applicationSessionId: 'disabled-session',
      adapterId: 'grok-build',
      environment: {},
    })).toBeNull();

    const enabled = await setup(true);
    const prepared = enabled.runtime.prepare({
      applicationSessionId: 'session-a', adapterId: 'claude-code', environment: {},
    })!;
    expect(enabled.runtime.diagnostics().leases).toBe(1);
    expect(enabled.runtime.renameSession('session-a', 'session-b')).toBe(1);
    expect(enabled.runtime.revokeSession('session-a')).toBe(0);
    expect(enabled.runtime.revokeSession('session-b')).toBe(1);
    expect(enabled.runtime.diagnostics().leases).toBe(0);
    expect(prepared.environment).not.toHaveProperty('AGENT_DECK_BROWSER_CONTEXT_FILE');
  });
});
