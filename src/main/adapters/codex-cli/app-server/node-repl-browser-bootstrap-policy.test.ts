import { describe, expect, it, vi } from 'vitest';
import type { CodexThreadOptions } from '../sdk-bridge/thread-options-builder';
import {
  prepareNodeReplBrowserBootstrapPolicy,
  type NodeReplBrowserBootstrapClient,
  type NodeReplBrowserBootstrapDiagnostic,
  type NodeReplBrowserBootstrapOperation,
} from './node-repl-browser-bootstrap';

const EXECUTABLE_PATH = '/opt/agent-deck/node';
const PROXY_PATH = '/opt/agent-deck/bin/node-repl-browser-bootstrap.cjs';

function threadOptions(
  overrides: Partial<CodexThreadOptions> = {},
): CodexThreadOptions {
  return {
    workingDirectory: '/repo',
    sandboxMode: 'workspace-write',
    skipGitRepoCheck: true,
    ...overrides,
  };
}

function clientWith(
  read: (cwd: string) => unknown | Promise<unknown>,
): NodeReplBrowserBootstrapClient & {
  generation: number;
  requestSpy: ReturnType<typeof vi.fn>;
} {
  const requestSpy = vi.fn(async (_method: string, params: unknown) => ({
    config: await read((params as { cwd: string }).cwd),
  }));
  return {
    generation: 0,
    request: async <T>(method: string, params: unknown): Promise<T> =>
      await requestSpy(method, params) as T,
    requestSpy,
  };
}

function decodeTarget(options: CodexThreadOptions): Record<string, unknown> {
  const server = readWrappedServer(options);
  const args = server.args as string[];
  return JSON.parse(Buffer.from(args[1], 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
}

function readWrappedServer(options: CodexThreadOptions): Record<string, unknown> {
  const config = options.configOverrides as {
    mcp_servers: { node_repl: Record<string, unknown> };
  };
  return config.mcp_servers.node_repl;
}

describe('node_repl Browser bootstrap policy', () => {
  it('wraps the inherited local server through explicit host ports', async () => {
    const diagnostics: NodeReplBrowserBootstrapDiagnostic[] = [];
    const client = clientWith(() => ({
      mcp_servers: {
        node_repl: {
          command: '/Applications/ChatGPT.app/node_repl',
          args: ['--browser'],
          env: { BROWSER_BACKEND: 'iab' },
          environment_id: 'local',
          startup_timeout_sec: 120,
          tool_timeout_sec: null,
        },
      },
    }));

    const prepared = await prepareNodeReplBrowserBootstrapPolicy(
      client,
      threadOptions(),
      null,
      {
        executablePath: EXECUTABLE_PATH,
        proxyPath: PROXY_PATH,
        diagnose: (diagnostic) => diagnostics.push(diagnostic),
      },
    );

    expect(client.requestSpy).toHaveBeenCalledWith('config/read', {
      includeLayers: false,
      cwd: '/repo',
    });
    expect(readWrappedServer(prepared)).toMatchObject({
      command: EXECUTABLE_PATH,
      args: [PROXY_PATH, expect.any(String)],
      env: { BROWSER_BACKEND: 'iab', ELECTRON_RUN_AS_NODE: '1' },
      environment_id: 'local',
      startup_timeout_sec: 120,
    });
    expect(readWrappedServer(prepared)).not.toHaveProperty('tool_timeout_sec');
    expect(decodeTarget(prepared)).toEqual({
      command: '/Applications/ChatGPT.app/node_repl',
      args: ['--browser'],
      electronRunAsNode: null,
    });
    expect(diagnostics).toEqual([{ type: 'installed' }]);
  });

  it('uses explicit config without reading inherited host config', async () => {
    const client = clientWith(() => {
      throw new Error('config/read must not run');
    });
    const options = threadOptions({
      useBaseConfig: false,
      configOverrides: {
        preserved: true,
        mcp_servers: {
          node_repl: {
            command: '/usr/local/bin/node_repl',
            environment_id: 'local',
          },
        },
      },
    });

    const prepared = await prepareNodeReplBrowserBootstrapPolicy(
      client,
      options,
      null,
      { executablePath: EXECUTABLE_PATH, proxyPath: PROXY_PATH },
    );

    expect(client.requestSpy).not.toHaveBeenCalled();
    expect(prepared.configOverrides).toMatchObject({ preserved: true });
    expect(decodeTarget(prepared)).toMatchObject({
      command: '/usr/local/bin/node_repl',
      args: [],
    });
  });

  it.each([
    { enabled: false, environment_id: 'local', command: '/bin/node_repl' },
    { environment_id: 'remote', command: '/bin/node_repl' },
    { environment_id: 'local', command: '   ' },
  ])('leaves an ineligible server unchanged: %j', async (server) => {
    const client = clientWith(() => ({ mcp_servers: { node_repl: server } }));
    const options = threadOptions();

    await expect(prepareNodeReplBrowserBootstrapPolicy(
      client,
      options,
      null,
      { executablePath: EXECUTABLE_PATH, proxyPath: PROXY_PATH },
    )).resolves.toBe(options);
  });

  it('does not wrap a server that already uses the supplied executable and proxy', async () => {
    const client = clientWith(() => ({
      mcp_servers: {
        node_repl: {
          command: EXECUTABLE_PATH,
          args: [PROXY_PATH, 'existing-payload'],
          environment_id: 'local',
        },
      },
    }));
    const options = threadOptions();

    await expect(prepareNodeReplBrowserBootstrapPolicy(
      client,
      options,
      null,
      { executablePath: EXECUTABLE_PATH, proxyPath: PROXY_PATH },
    )).resolves.toBe(options);
  });

  it('evicts failed reads, reports them safely, and retries', async () => {
    const error = new Error('raw config failure');
    let attempt = 0;
    const client = clientWith(() => {
      attempt += 1;
      if (attempt === 1) throw error;
      return {
        mcp_servers: {
          node_repl: { command: '/bin/node_repl', environment_id: 'local' },
        },
      };
    });
    const diagnose = vi.fn(() => {
      throw new Error('diagnostics failure');
    });
    const options = threadOptions();
    const ports = { executablePath: EXECUTABLE_PATH, proxyPath: PROXY_PATH, diagnose };

    await expect(prepareNodeReplBrowserBootstrapPolicy(
      client,
      options,
      null,
      ports,
    )).resolves.toBe(options);
    const prepared = await prepareNodeReplBrowserBootstrapPolicy(
      client,
      options,
      null,
      ports,
    );

    expect(client.requestSpy).toHaveBeenCalledTimes(2);
    expect(diagnose).toHaveBeenNthCalledWith(1, { type: 'config-read-failed', error });
    expect(diagnose).toHaveBeenNthCalledWith(2, { type: 'installed' });
    expect(readWrappedServer(prepared).command).toBe(EXECUTABLE_PATH);
  });

  it('rethrows a stale operation failure without reporting it as host config failure', async () => {
    const error = new Error('retired generation');
    const client = clientWith(() => ({}));
    const diagnose = vi.fn();
    const operation: NodeReplBrowserBootstrapOperation = {
      isCurrent: () => false,
      request: vi.fn(async () => {
        throw error;
      }),
    };

    await expect(prepareNodeReplBrowserBootstrapPolicy(
      client,
      threadOptions(),
      null,
      { executablePath: EXECUTABLE_PATH, proxyPath: PROXY_PATH, diagnose },
      operation,
    )).rejects.toBe(error);
    expect(diagnose).not.toHaveBeenCalled();
  });

  it('caches successful config reads by client generation and cwd', async () => {
    const client = clientWith(() => ({}));
    const ports = { executablePath: EXECUTABLE_PATH, proxyPath: PROXY_PATH };

    await prepareNodeReplBrowserBootstrapPolicy(client, threadOptions(), null, ports);
    await prepareNodeReplBrowserBootstrapPolicy(client, threadOptions(), null, ports);
    await prepareNodeReplBrowserBootstrapPolicy(
      client,
      threadOptions({ workingDirectory: '/other' }),
      null,
      ports,
    );
    client.generation += 1;
    await prepareNodeReplBrowserBootstrapPolicy(client, threadOptions(), null, ports);

    expect(client.requestSpy).toHaveBeenCalledTimes(3);
  });
});
