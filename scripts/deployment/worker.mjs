import { chmod, lstat, mkdir, realpath } from 'node:fs/promises';

import { runCommand } from './process.mjs';
import {
  checkWorkerProviderSupervisor,
  deployWorkerProviderSupervisor,
  verifyWorkerProviderSupervisor,
} from './worker-supervisor.mjs';

async function workspaceStatus(config) {
  let stats;
  try {
    stats = await lstat(config.workspace);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return { exists: false, path: config.workspace };
    }
    throw error;
  }
  if (!stats.isDirectory() || stats.isSymbolicLink() || (await realpath(config.workspace)) !== config.workspace) {
    throw new Error('Worker workspace 必须是规范化的非符号链接目录。');
  }
  return { exists: true, path: config.workspace };
}

async function worker(config, args, options = {}) {
  return runCommand(config.wrapper, args, {
    timeoutMs: options.timeoutMs ?? 180_000,
    maxOutputBytes: 1024 * 1024,
  });
}

async function checkAbi(config) {
  await worker(config, ['check-abi']);
}

async function status(config, requireRunning) {
  const result = await worker(config, ['status']);
  const running = result.stdout.includes('Worker 状态：运行中');
  if (requireRunning && !running) throw new Error('Worker 尚未处于运行状态。');
  const workerConfigId = result.stdout.match(/（(worker-[a-f0-9]{24})）/u)?.[1] ?? null;
  return { running, workerConfigId, output: result.stdout.trim() };
}

function supervisor(config) {
  return config.providerSupervisor === null ? null : {
    ...config.providerSupervisor,
    workerWrapper: config.wrapper,
  };
}

function assertSupervisorWorker(config, workerStatus) {
  if (config.providerSupervisor !== null &&
      workerStatus.workerConfigId !== config.providerSupervisor.workerConfigId) {
    throw new Error('Worker 当前配置标识与 Provider supervisor 配置不匹配。');
  }
}

export function workerConfigureArgs(config) {
  return [
    'configure',
    '--credential', config.credentialFile,
    '--workspace', config.workspace,
  ];
}

export async function runWorkerDeployment(config, action) {
  if (action === 'dry-run') {
    return {
      action,
      name: config.name,
      workspace: config.workspace,
      wrapper: config.wrapper,
      mutatesLocalState: false,
      plannedSteps: [
        '验证签名 Worker runtime 与 Node SQLite ABI',
        '确保隔离 Workspace 不位于 Agent Deck 仓库中',
        '从 Worker connection credential 配置或重启 LaunchAgent/systemd-user service',
        '从本机 Provider 配置自动投影 Remote Gateway、Provider 与模型摘要',
        ...(config.providerSupervisor === null ? [] : [
          '验证 Grok 凭证、Provider supervisor 配置与 Worker identity',
          '原子投射凭证、安装 LaunchAgent、等待就绪并受控重启 Worker',
        ]),
        '验证 Worker 后台服务为 running',
      ],
      providerSupervisor: config.providerSupervisor === null
        ? 'not-configured'
        : 'managed-through-launchd',
    };
  }
  if (action === 'check') {
    await checkAbi(config);
    const providerSupervisor = await checkWorkerProviderSupervisor(supervisor(config));
    return {
      action,
      name: config.name,
      workspace: await workspaceStatus(config),
      service: 'not-mutated',
      status: 'ok',
      providerSupervisor,
    };
  }
  if (action === 'verify') {
    const service = await status(config, true);
    assertSupervisorWorker(config, service);
    const providerSupervisor = await verifyWorkerProviderSupervisor(supervisor(config));
    return {
      action,
      name: config.name,
      status: providerSupervisor.status === 'degraded' ? 'degraded' : 'ok',
      service,
      providerSupervisor,
    };
  }
  if (action === 'deploy') {
    if (config.credentialFile === null) {
      throw new Error('Worker --deploy 需要 credentialFile；配置完成后可将其改为 null。');
    }
    const before = await workspaceStatus(config);
    if (!before.exists) {
      await mkdir(config.workspace, { recursive: true, mode: 0o700 });
      await chmod(config.workspace, 0o700);
    }
    await workspaceStatus(config);
    await checkAbi(config);
    await checkWorkerProviderSupervisor(supervisor(config));
    await worker(config, workerConfigureArgs(config), { timeoutMs: 300_000 });
    const configured = await status(config, true);
    assertSupervisorWorker(config, configured);
    const providerSupervisor = await deployWorkerProviderSupervisor(supervisor(config));
    if (config.providerSupervisor !== null) {
      await worker(config, ['start', '--worker', config.providerSupervisor.workerConfigId], {
        timeoutMs: 300_000,
      });
    }
    return {
      action,
      name: config.name,
      workspace: config.workspace,
      service: await status(config, true),
      providerSupervisor,
    };
  }
  if (action === 'upgrade') {
    await workspaceStatus(config);
    await checkAbi(config);
    await checkWorkerProviderSupervisor(supervisor(config));
    const before = await status(config, false);
    assertSupervisorWorker(config, before);
    const providerSupervisor = await deployWorkerProviderSupervisor(supervisor(config));
    await worker(config, [
      'start',
      ...(config.providerSupervisor === null
        ? []
        : ['--worker', config.providerSupervisor.workerConfigId]),
    ], { timeoutMs: 300_000 });
    return {
      action,
      name: config.name,
      workspace: config.workspace,
      service: await status(config, true),
      providerSupervisor,
    };
  }
  throw new Error(`不支持的 Worker 部署操作：${action}`);
}
