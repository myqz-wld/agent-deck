import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodexAppServerClient } from './client';

interface ProxyApi {
  appendNodeRequireOption: (existing: string | undefined, preloadPath: string) => string;
  buildTargetEnv: (
    target: { electronRunAsNode: string | null },
    sourceEnv: Record<string, string>,
  ) => Record<string, string>;
}

const require = createRequire(import.meta.url);
const proxyPath = resolve(
  process.cwd(),
  'resources/bin/node-repl-browser-bootstrap.cjs',
);
const processPreloadPath = resolve(
  process.cwd(),
  'resources/bin/node-repl-browser-process-compat.cjs',
);
const proxyApi = require(proxyPath) as ProxyApi;

describe('node_repl Browser process bootstrap', () => {
  it('preloads the Browser process shim without dropping the target environment', () => {
    expect(proxyApi.appendNodeRequireOption('--trace-warnings', '/Agent Deck/process.cjs'))
      .toBe('--trace-warnings --require="/Agent Deck/process.cjs"');
    expect(proxyApi.buildTargetEnv(
      { electronRunAsNode: null },
      {
        BROWSER_BACKEND: 'iab',
        ELECTRON_RUN_AS_NODE: '1',
        NODE_OPTIONS: '--trace-warnings',
      },
    )).toEqual({
      BROWSER_BACKEND: 'iab',
      NODE_OPTIONS: `--trace-warnings --require=${JSON.stringify(processPreloadPath)}`,
    });
  });

  it('lets the Browser client replace only the locked trusted process facade', () => {
    const script = String.raw`
      const vm = require('node:vm');
      const unrelatedContext = vm.createContext({});
      Object.defineProperty(unrelatedContext, 'process', {
        value: Object.freeze({ pid: 1 }),
        writable: false,
        configurable: false,
        enumerable: false,
      });
      const context = vm.createContext({});
      context.globalThis = context;
      context.global = context;
      const facade = Object.freeze({
        arch: process.arch,
        cwd: () => '/repo',
        env: Object.freeze({}),
        off: () => facade,
        once: () => facade,
        pid: 1,
        platform: process.platform,
      });
      Object.defineProperty(context, 'process', {
        value: facade,
        writable: false,
        configurable: false,
        enumerable: false,
      });
      const module = new vm.SourceTextModule(
        'globalThis.process = { pid: 0 }; globalThis.global.process = globalThis.process;',
        { context },
      );
      (async () => {
        await module.link(() => {});
        await module.evaluate();
        process.stdout.write(JSON.stringify({
          pid: context.process.pid,
          descriptor: Object.getOwnPropertyDescriptor(context, 'process'),
          unrelatedDescriptor: Object.getOwnPropertyDescriptor(unrelatedContext, 'process'),
        }));
      })().catch((error) => {
        process.stderr.write(error.stack);
        process.exitCode = 1;
      });
    `;
    const result = spawnSync(process.execPath, [
      '--experimental-vm-modules',
      '--require',
      processPreloadPath,
      '-e',
      script,
    ], { encoding: 'utf8' });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      pid: 0,
      descriptor: {
        writable: true,
        configurable: false,
        enumerable: false,
      },
      unrelatedDescriptor: {
        writable: false,
        configurable: false,
        enumerable: false,
      },
    });
  });

  it('launches the target with the preload and relays its stdio', () => {
    const payload = Buffer.from(JSON.stringify({
      command: process.execPath,
      args: ['-e', 'process.stdout.write(JSON.stringify({ sentinel: process.env.BOOTSTRAP_SENTINEL, nodeOptions: process.env.NODE_OPTIONS }))'],
      electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
    }), 'utf8').toString('base64url');
    const result = spawnSync(process.execPath, [proxyPath, payload], {
      encoding: 'utf8',
      env: { ...process.env, BOOTSTRAP_SENTINEL: 'present' },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ sentinel: 'present' });
    expect(JSON.parse(result.stdout).nodeOptions).toContain(
      'node-repl-browser-process-compat.cjs',
    );
  });

  it('injects the bootstrap into a local configured node_repl server', async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    class RecordingClient extends CodexAppServerClient {
      override request<T = unknown>(method: string, params: unknown): Promise<T> {
        calls.push({ method, params });
        if (method === 'config/read') {
          return Promise.resolve({
            config: {
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
            },
          } as T);
        }
        return Promise.resolve({ thread: { id: 'thread-1' } } as T);
      }
    }
    const client = new RecordingClient({
      env: {},
      config: null,
      nodeReplBrowserBootstrap: true,
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
    expect(proxyArgs[0]).toMatch(/node-repl-browser-bootstrap\.cjs$/);
    expect(JSON.parse(Buffer.from(proxyArgs[1], 'base64url').toString('utf8'))).toEqual({
      command: '/Applications/ChatGPT.app/node_repl',
      args: ['--browser'],
      electronRunAsNode: null,
    });
  });
});
