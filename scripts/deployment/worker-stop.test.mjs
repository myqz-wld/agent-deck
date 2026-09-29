import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseEntrypointArgs, WORKER_ACTIONS } from './common.mjs';

const state = vi.hoisted(() => ({ worker: '', arguments: '', printCode: 0, printError: '' }));
vi.mock('./process.mjs', () => ({
  runCommand: vi.fn(async (executable, args) => ({
    code: args[0] === 'print' ? state.printCode : 0,
    stdout: args[0] === 'status' ? `Worker 状态：运行中（${state.worker}）`
      : args[0] === 'print' ? `state = running\npid = 123\narguments = {\n${state.arguments}\n}\n` : '',
    stderr: args[0] === 'print' ? state.printError : '',
    timedOut: false,
  })),
}));
import { runCommand } from './process.mjs';
import { runWorkerDeployment } from './worker.mjs';

const id = `worker-${'a'.repeat(24)}`;
const config = {
  name: 'fixture', wrapper: '/opt/Fixture App/bin/agent-deck-worker',
  providerSupervisor: {
    command: '/opt/Fixture App/bin/agent-deck-provider-supervisor',
    configFile: '/private/fixture/config.json', workerConfigId: id,
    hostConfig: { instanceId: 'fixture', transportSocketPath: '/private/fixture/s.sock' },
  },
};
beforeEach(() => {
  vi.clearAllMocks();
  state.worker = id; state.printCode = 0; state.printError = '';
  state.arguments = [config.providerSupervisor.command, 'serve', '--instance', 'fixture',
    '--config', config.providerSupervisor.configFile, '--socket',
    config.providerSupervisor.hostConfig.transportSocketPath].join('\n');
});

describe.skipIf(process.platform !== 'darwin')('managed Worker quiescence before app replacement', () => {
  it('parses stop and unloads only the configured Worker and supervisor without deleting configuration', async () => {
    expect(parseEntrypointArgs(['--config', '/fixture.json', '--stop'], WORKER_ACTIONS).action).toBe('stop');
    await expect(runWorkerDeployment(config, 'stop')).resolves.toMatchObject({ status: 'stopped' });
    expect(runCommand).toHaveBeenCalledWith(config.wrapper, ['stop', '--worker', id], expect.any(Object));
    expect(runCommand).toHaveBeenCalledWith('/bin/launchctl', [
      'bootout', `gui/${process.getuid()}/com.agentdeck.provider-supervisor.fixture`,
    ], expect.any(Object));
    expect(runCommand.mock.calls.some(([, args]) => args[0] === 'remove')).toBe(false);
  });

  it('rejects an unexpected Worker before sending any stop command', async () => {
    state.worker = `worker-${'b'.repeat(24)}`;
    await expect(runWorkerDeployment(config, 'stop')).rejects.toThrow(/配置不匹配/);
    expect(runCommand.mock.calls.some(([, args]) => ['stop', 'bootout'].includes(args[0]))).toBe(false);
  });

  it('does not unload a supervisor whose loaded executable or config identity differs', async () => {
    state.arguments = state.arguments.replace(config.providerSupervisor.command, '/opt/other/service');
    await expect(runWorkerDeployment(config, 'stop')).rejects.toThrow(/服务身份与配置不匹配/);
    expect(runCommand.mock.calls.some(([, args]) => args[0] === 'bootout')).toBe(false);
  });

  it('treats an already absent supervisor as stopped', async () => {
    state.printCode = 113; state.printError = 'Could not find service "fixture"';
    await expect(runWorkerDeployment(config, 'stop')).resolves.toMatchObject({
      providerSupervisor: { status: 'stopped' },
    });
  });

  it('does not confuse a launchctl failure with an absent supervisor', async () => {
    state.printCode = 1; state.printError = 'permission denied';
    await expect(runWorkerDeployment(config, 'stop')).rejects.toThrow(/无法核实/);
    expect(runCommand.mock.calls.some(([, args]) => args[0] === 'bootout')).toBe(false);
  });

  it('keeps an unmanaged provider lifecycle untouched', async () => {
    await expect(runWorkerDeployment({ ...config, providerSupervisor: null }, 'stop'))
      .resolves.toMatchObject({ providerSupervisor: { managed: false } });
    expect(runCommand.mock.calls.some(([executable]) => executable === '/bin/launchctl')).toBe(false);
  });
});
