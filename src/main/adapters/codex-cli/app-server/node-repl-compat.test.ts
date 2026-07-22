import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAppServerClient } from './client';

interface ProxyApi {
  patchLegacySandboxState: (request: Record<string, unknown>) => Record<string, unknown>;
  permissionProfileToLegacySandboxPolicy: (
    profile: Record<string, unknown>,
    sandboxCwd: string,
  ) => Record<string, unknown>;
}

interface RpcMessage {
  id?: number | string;
  result?: {
    content?: Array<{ text?: string }>;
    [key: string]: unknown;
  };
  error?: { code?: number; message?: string };
}

const require = createRequire(import.meta.url);
const proxyPath = resolve(process.cwd(), 'resources/bin/node-repl-sandbox-meta-proxy.cjs');
const fixturePath = resolve(
  process.cwd(),
  'src/main/adapters/codex-cli/app-server/__fixtures__/legacy-node-repl-mcp.cjs',
);
const proxyApi = require(proxyPath) as ProxyApi;
const children = new Set<ChildProcessWithoutNullStreams>();

afterEach(() => {
  for (const child of children) child.kill('SIGKILL');
  children.clear();
});

describe('node_repl sandbox metadata compatibility', () => {
  it('maps the standard permission profiles to the exact legacy MCP wire shape', () => {
    const cwd = pathToFileURL('/repo').href;
    expect(proxyApi.permissionProfileToLegacySandboxPolicy(
      managedProfile([{ path: specialPath('root'), access: 'read' }], 'restricted'),
      cwd,
    )).toEqual({ type: 'read-only' });

    expect(proxyApi.permissionProfileToLegacySandboxPolicy(
      managedProfile([
        { path: specialPath('root'), access: 'read' },
        { path: specialPath('project_roots'), access: 'write' },
        { path: specialPath('slash_tmp'), access: 'write' },
        { path: specialPath('tmpdir'), access: 'write' },
        { path: { type: 'path', path: '/extra' }, access: 'write' },
        { path: specialPath('project_roots', '.git'), access: 'read' },
        { path: specialPath('project_roots', '.agents'), access: 'read' },
        { path: specialPath('project_roots', '.codex'), access: 'read' },
      ], 'enabled'),
      cwd,
    )).toEqual({
      type: 'workspace-write',
      writable_roots: ['/extra'],
      network_access: true,
      exclude_tmpdir_env_var: false,
      exclude_slash_tmp: false,
    });

    expect(proxyApi.permissionProfileToLegacySandboxPolicy({ type: 'disabled' }, cwd))
      .toEqual({ type: 'danger-full-access' });
    expect(proxyApi.permissionProfileToLegacySandboxPolicy(
      { type: 'external', network: 'restricted' },
      cwd,
    )).toEqual({ type: 'external-sandbox', network_access: 'restricted' });
  });

  it('fails closed when a permission profile cannot be represented by legacy sandboxPolicy', () => {
    expect(() => proxyApi.permissionProfileToLegacySandboxPolicy(
      managedProfile([
        { path: specialPath('root'), access: 'read' },
        { path: { type: 'path', path: '/outside' }, access: 'write' },
      ]),
      pathToFileURL('/repo').href,
    )).toThrow(/outside the workspace root/);
    expect(() => proxyApi.permissionProfileToLegacySandboxPolicy(
      { type: 'future-profile' },
      pathToFileURL('/repo').href,
    )).toThrow(/unsupported permissionProfile type/);
    expect(() => proxyApi.permissionProfileToLegacySandboxPolicy(
      managedProfile([{ path: { type: 'path', path: '/only-this' }, access: 'read' }]),
      pathToFileURL('/repo').href,
    )).toThrow(/restricted filesystem reads/);
  });

  it('preserves an existing sandboxPolicy instead of replacing its authority', () => {
    const request = toolCall({
      permissionProfile: { type: 'disabled' },
      sandboxPolicy: { type: 'read-only', network_access: false },
      sandboxCwd: '/repo',
    });
    expect(proxyApi.patchLegacySandboxState(request)).toBe(request);
  });

  it('retries the exact legacy schema failure and reaches browser.documentation()', async () => {
    const response = await runProxyToolCall('legacy');
    expect(response.error).toBeUndefined();
    const payload = JSON.parse(response.result?.content?.[0]?.text ?? '{}') as {
      state: Record<string, unknown>;
      code: string;
    };
    expect(payload.code).toBe('await browser.documentation()');
    expect(payload.state.sandboxCwd).toBe('/repo');
    expect(payload.state.sandboxPolicy).toEqual({
      type: 'workspace-write',
      writable_roots: ['/extra'],
      network_access: true,
      exclude_tmpdir_env_var: true,
      exclude_slash_tmp: true,
    });
  });

  it('leaves a modern node_repl request unchanged when the target accepts permissionProfile', async () => {
    const response = await runProxyToolCall('modern');
    const payload = JSON.parse(response.result?.content?.[0]?.text ?? '{}') as {
      state: Record<string, unknown>;
    };
    expect(payload.state.sandboxPolicy).toBeUndefined();
    expect(payload.state.sandboxCwd).toBe(pathToFileURL('/repo').href);
  });

  it('injects the bridge into an in-app thread without modifying user config', async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    class RecordingClient extends CodexAppServerClient {
      override request<T = unknown>(method: string, params: unknown): Promise<T> {
        calls.push({ method, params });
        if (method === 'config/read') {
          return Promise.resolve({
            config: {
              mcp_servers: {
                node_repl: {
                  command: '/Applications/Codex.app/node_repl',
                  args: ['--browser'],
                  env: { BROWSER_BACKEND: 'iab' },
                  environment_id: 'local',
                  startup_timeout_sec: 120,
                  tool_timeout_sec: null,
                },
              },
            },
          } as T);
        }
        return Promise.resolve({ thread: { id: 'thread-1' } } as T);
      }
    }
    const client = new RecordingClient({
      env: {},
      config: null,
      nodeReplSandboxMetaCompatibility: true,
    });
    await client.startThread({
      workingDirectory: '/repo',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      skipGitRepoCheck: true,
    }).ensureReady();

    expect(calls.map(({ method }) => method)).toEqual(['config/read', 'thread/start']);
    const start = calls[1].params as {
      config: { mcp_servers: { node_repl: Record<string, unknown> } };
    };
    const server = start.config.mcp_servers.node_repl;
    expect(server.command).toBe(process.execPath);
    expect(server.startup_timeout_sec).toBe(120);
    expect(server).not.toHaveProperty('tool_timeout_sec');
    expect(server.env).toEqual({ BROWSER_BACKEND: 'iab', ELECTRON_RUN_AS_NODE: '1' });
    const proxyArgs = server.args as string[];
    expect(proxyArgs[0]).toMatch(/node-repl-sandbox-meta-proxy\.cjs$/);
    expect(JSON.parse(Buffer.from(proxyArgs[1], 'base64url').toString('utf8'))).toEqual({
      command: '/Applications/Codex.app/node_repl',
      args: ['--browser'],
      electronRunAsNode: null,
    });
  });
});

function managedProfile(
  entries: Array<Record<string, unknown>>,
  network: 'enabled' | 'restricted' = 'restricted',
): Record<string, unknown> {
  return {
    type: 'managed',
    file_system: { type: 'restricted', entries },
    network,
  };
}

function specialPath(kind: string, subpath?: string): Record<string, unknown> {
  return {
    type: 'special',
    value: {
      kind,
      ...(kind === 'project_roots' ? { subpath: subpath ?? null } : {}),
    },
  };
}

function toolCall(state: Record<string, unknown>): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'js',
      arguments: { code: 'await browser.documentation()' },
      _meta: { 'codex/sandbox-state-meta': state },
    },
  };
}

async function runProxyToolCall(mode: 'legacy' | 'modern'): Promise<RpcMessage> {
  const target = Buffer.from(JSON.stringify({
    command: process.execPath,
    args: [fixturePath],
    electronRunAsNode: null,
  }), 'utf8').toString('base64url');
  const child = spawn(process.execPath, [proxyPath, target], {
    env: { ...process.env, LEGACY_NODE_REPL_FIXTURE_MODE: mode },
    stdio: 'pipe',
  });
  children.add(child);
  const responses = rpcResponses(child);

  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.1.0' },
    },
  })}\n`);
  expect((await responses.next()).id).toBe(1);

  child.stdin.write(`${JSON.stringify(toolCall({
    permissionProfile: managedProfile([
      { path: specialPath('root'), access: 'read' },
      { path: specialPath('project_roots'), access: 'write' },
      { path: { type: 'path', path: '/extra' }, access: 'write' },
    ], 'enabled'),
    sandboxCwd: pathToFileURL('/repo').href,
    codexLinuxSandboxExe: null,
    useLegacyLandlock: false,
  }))}\n`);
  const response = await responses.next();
  child.stdin.end();
  children.delete(child);
  return response;
}

function rpcResponses(child: ChildProcessWithoutNullStreams): { next: () => Promise<RpcMessage> } {
  const queue: RpcMessage[] = [];
  const waiters: Array<(message: RpcMessage) => void> = [];
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line) as RpcMessage;
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else queue.push(message);
  });
  return {
    next: () => {
      const queued = queue.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise<RpcMessage>((resolveMessage, reject) => {
        const timeout = setTimeout(() => reject(new Error('timed out waiting for proxy response')), 3000);
        waiters.push((message) => {
          clearTimeout(timeout);
          resolveMessage(message);
        });
      });
    },
  };
}
