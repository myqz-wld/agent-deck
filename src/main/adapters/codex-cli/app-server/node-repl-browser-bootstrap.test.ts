import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CodexAppServerClient } from './client';

interface ProxyChild extends EventEmitter {
  kill: (signal?: NodeJS.Signals | number) => boolean;
  unref: () => void;
}

interface ProxyHostProcess extends EventEmitter {
  exitCode: number | undefined;
  stderr: { write: (text: string) => boolean };
}

interface ProxyApi {
  attachProxyLifecycle: (
    child: ProxyChild,
    options?: {
      cancelTimeout?: (timer: unknown) => void;
      forceKillTimeoutMs?: number;
      hostProcess?: ProxyHostProcess;
      scheduleTimeout?: (callback: () => void, timeoutMs: number) => unknown;
    },
  ) => void;
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
const proxyHarness = String.raw`
  const bootstrap = require(process.argv[1]);
  const target = JSON.parse(Buffer.from(process.argv[2], 'base64url').toString('utf8'));
  bootstrap.startProxy(target, { forceKillTimeoutMs: Number(process.argv[3]) });
`;

interface ProxyRun {
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  output: { stderr: string; stdout: string };
  proxy: ChildProcess;
}

function launchSignalProxy(childSource: string, forceKillTimeoutMs: number): ProxyRun {
  const target = Buffer.from(JSON.stringify({
    command: process.execPath,
    args: ['-e', childSource],
    electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
  }), 'utf8').toString('base64url');
  const proxy = spawn(process.execPath, [
    '-e',
    proxyHarness,
    proxyPath,
    target,
    String(forceKillTimeoutMs),
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const output = { stderr: '', stdout: '' };
  proxy.stdout?.setEncoding('utf8');
  proxy.stderr?.setEncoding('utf8');
  proxy.stdout?.on('data', (chunk: string) => {
    output.stdout += chunk;
  });
  proxy.stderr?.on('data', (chunk: string) => {
    output.stderr += chunk;
  });
  return {
    exited: waitForProxyExit(proxy, forceKillTimeoutMs + 4_000),
    output,
    proxy,
  };
}

function waitForProxyExit(
  proxy: ChildProcess,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => {
      killExactProcess(proxy.pid);
      rejectExit(new Error('node_repl Browser bootstrap exceeded its test timeout'));
    }, timeoutMs);
    proxy.once('error', (error) => {
      clearTimeout(timeout);
      rejectExit(error);
    });
    proxy.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolveExit({ code, signal });
    });
  });
}

function waitForOutput(run: ProxyRun, expected: string, timeoutMs = 2_000): Promise<void> {
  if (run.output.stdout.includes(expected)) return Promise.resolve();
  return new Promise((resolveOutput, rejectOutput) => {
    const cleanup = () => {
      clearTimeout(timeout);
      run.proxy.stdout?.removeListener('data', onData);
      run.proxy.removeListener('exit', onExit);
    };
    const onData = () => {
      if (!run.output.stdout.includes(expected)) return;
      cleanup();
      resolveOutput();
    };
    const onExit = () => {
      cleanup();
      rejectOutput(new Error(
        `proxy exited before output ${JSON.stringify(expected)}\n${run.output.stderr}`,
      ));
    };
    const timeout = setTimeout(() => {
      cleanup();
      rejectOutput(new Error(
        `timed out waiting for ${JSON.stringify(expected)}\n${run.output.stderr}`,
      ));
    }, timeoutMs);
    run.proxy.stdout?.on('data', onData);
    run.proxy.once('exit', onExit);
    onData();
  });
}

function readTargetPid(run: ProxyRun): number {
  const match = run.output.stdout.match(/READY:(\d+)/);
  if (!match) throw new Error(`target pid was not reported\n${run.output.stdout}`);
  return Number(match[1]);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

function killExactProcess(pid: number | undefined): void {
  if (pid === undefined || !isProcessAlive(pid)) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

async function waitForProcessGone(pid: number, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`target process ${pid} remained alive after the wrapper exited`);
}

async function cleanupProxyRun(run: ProxyRun, targetPid?: number): Promise<void> {
  if (run.proxy.exitCode === null && run.proxy.signalCode === null) {
    killExactProcess(run.proxy.pid);
  }
  if (targetPid !== undefined) killExactProcess(targetPid);
  await run.exited.catch(() => undefined);
}

function createLifecycleFakes(): {
  cancelTimeout: ReturnType<typeof vi.fn>;
  child: ProxyChild & { kill: ReturnType<typeof vi.fn>; unref: ReturnType<typeof vi.fn> };
  fireTimeout: () => void;
  hostProcess: ProxyHostProcess;
  scheduleTimeout: ReturnType<typeof vi.fn>;
  stderrWrite: ReturnType<typeof vi.fn>;
} {
  let timeoutCallback: (() => void) | null = null;
  const timerToken = Symbol('force-kill-timer');
  const child = Object.assign(new EventEmitter(), {
    kill: vi.fn(() => true),
    unref: vi.fn(),
  });
  const stderrWrite = vi.fn(() => true);
  const hostProcess = Object.assign(new EventEmitter(), {
    exitCode: undefined as number | undefined,
    stderr: { write: stderrWrite },
  });
  const scheduleTimeout = vi.fn((callback: () => void) => {
    timeoutCallback = callback;
    return timerToken;
  });
  const cancelTimeout = vi.fn();
  return {
    cancelTimeout,
    child,
    fireTimeout: () => timeoutCallback?.(),
    hostProcess,
    scheduleTimeout,
    stderrWrite,
  };
}

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

  it('clears the force-kill timer when the child exits and ignores late races', () => {
    const fakes = createLifecycleFakes();
    proxyApi.attachProxyLifecycle(fakes.child, {
      cancelTimeout: fakes.cancelTimeout,
      forceKillTimeoutMs: 50,
      hostProcess: fakes.hostProcess,
      scheduleTimeout: fakes.scheduleTimeout,
    });

    fakes.hostProcess.emit('SIGTERM');
    expect(fakes.child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(fakes.scheduleTimeout).toHaveBeenCalledOnce();

    fakes.child.emit('exit', 0, null);
    expect(fakes.cancelTimeout).toHaveBeenCalledOnce();
    expect(fakes.hostProcess.exitCode).toBe(0);
    expect(fakes.hostProcess.listenerCount('SIGINT')).toBe(0);
    expect(fakes.hostProcess.listenerCount('SIGTERM')).toBe(0);

    fakes.fireTimeout();
    fakes.child.emit('error', new Error('late error'));
    expect(fakes.child.kill).toHaveBeenCalledTimes(1);
    expect(fakes.hostProcess.exitCode).toBe(0);
    expect(fakes.stderrWrite).not.toHaveBeenCalled();
  });

  it('clears the force-kill timer on child error and finishes only once', () => {
    const fakes = createLifecycleFakes();
    proxyApi.attachProxyLifecycle(fakes.child, {
      cancelTimeout: fakes.cancelTimeout,
      forceKillTimeoutMs: 50,
      hostProcess: fakes.hostProcess,
      scheduleTimeout: fakes.scheduleTimeout,
    });

    fakes.hostProcess.emit('SIGINT');
    fakes.hostProcess.emit('SIGTERM');
    fakes.hostProcess.emit('SIGINT');
    expect(fakes.scheduleTimeout).toHaveBeenCalledOnce();
    expect(fakes.child.kill.mock.calls.map(([signal]) => signal))
      .toEqual(['SIGINT', 'SIGTERM', 'SIGINT']);
    fakes.child.emit('error', new Error('child failed'));
    expect(fakes.cancelTimeout).toHaveBeenCalledOnce();
    expect(fakes.hostProcess.exitCode).toBe(1);
    expect(fakes.child.unref).toHaveBeenCalledOnce();
    expect(fakes.stderrWrite).toHaveBeenCalledWith(
      'Agent Deck node_repl Browser bootstrap failed: child failed\n',
    );

    fakes.fireTimeout();
    fakes.child.emit('exit', 0, null);
    expect(fakes.child.kill).toHaveBeenCalledTimes(3);
    expect(fakes.hostProcess.exitCode).toBe(1);
  });

  describe.skipIf(process.platform === 'win32')('termination signal proxying', () => {
    it('lets a cooperative child exit after the first signal without SIGKILL', async () => {
      const childSource = [
        "process.on('SIGTERM', () => {",
        "  process.stdout.write('COOPERATIVE:SIGTERM\\n');",
        '  setTimeout(() => process.exit(0), 20);',
        '});',
        "process.stdout.write('READY:' + process.pid + '\\n');",
        'setInterval(() => {}, 1_000);',
      ].join('\n');
      const run = launchSignalProxy(childSource, 500);
      let targetPid: number | undefined;
      try {
        await waitForOutput(run, 'READY:');
        targetPid = readTargetPid(run);
        if (run.proxy.pid === undefined) throw new Error('proxy pid was not assigned');
        process.kill(run.proxy.pid, 'SIGTERM');

        const result = await run.exited;
        expect(result, run.output.stderr).toEqual({ code: 0, signal: null });
        expect(run.output.stdout).toContain('COOPERATIVE:SIGTERM');
        await waitForProcessGone(targetPid);
      } finally {
        await cleanupProxyRun(run, targetPid);
      }
    }, 10_000);

    it('forwards repeated signals then force-kills an uncooperative child', async () => {
      const childSource = [
        'const seen = { SIGINT: 0, SIGTERM: 0 };',
        "for (const signal of ['SIGINT', 'SIGTERM']) {",
        '  process.on(signal, () => {',
        '    seen[signal] += 1;',
        "    process.stdout.write('SEEN:' + signal + ':' + seen[signal] + '\\n');",
        '  });',
        '}',
        "process.stdout.write('READY:' + process.pid + '\\n');",
        'setInterval(() => {}, 1_000);',
        'setTimeout(() => process.exit(98), 10_000);',
      ].join('\n');
      const run = launchSignalProxy(childSource, 750);
      let targetPid: number | undefined;
      try {
        await waitForOutput(run, 'READY:');
        targetPid = readTargetPid(run);
        if (run.proxy.pid === undefined) throw new Error('proxy pid was not assigned');

        process.kill(run.proxy.pid, 'SIGINT');
        await waitForOutput(run, 'SEEN:SIGINT:1');
        process.kill(run.proxy.pid, 'SIGINT');
        await waitForOutput(run, 'SEEN:SIGINT:2');
        process.kill(run.proxy.pid, 'SIGTERM');
        await waitForOutput(run, 'SEEN:SIGTERM:1');

        const result = await run.exited;
        expect(result, run.output.stderr).toEqual({ code: 1, signal: null });
        await waitForProcessGone(targetPid);
      } finally {
        await cleanupProxyRun(run, targetPid);
      }
    }, 10_000);
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
