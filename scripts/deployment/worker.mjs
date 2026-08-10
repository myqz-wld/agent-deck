import { chmod, lstat, mkdir, realpath } from 'node:fs/promises';

import { runCommand } from './process.mjs';

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
  return { running, output: result.stdout.trim() };
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
        '验证 Worker 后台服务为 running',
      ],
      providerSupervisor: 'optional-not-managed',
    };
  }
  if (action === 'check') {
    await checkAbi(config);
    return {
      action,
      name: config.name,
      workspace: await workspaceStatus(config),
      service: 'not-mutated',
      status: 'ok',
    };
  }
  if (action === 'verify') {
    return { action, name: config.name, service: await status(config, true) };
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
    await worker(config, [
      'configure',
      '--credential', config.credentialFile,
      '--workspace', config.workspace,
    ], { timeoutMs: 300_000 });
    return {
      action,
      name: config.name,
      workspace: config.workspace,
      service: await status(config, true),
      providerSupervisor: 'optional-not-managed',
    };
  }
  if (action === 'upgrade') {
    await workspaceStatus(config);
    await checkAbi(config);
    await worker(config, ['start'], { timeoutMs: 300_000 });
    return {
      action,
      name: config.name,
      workspace: config.workspace,
      service: await status(config, true),
      providerSupervisor: 'optional-not-managed',
    };
  }
  throw new Error(`不支持的 Worker 部署操作：${action}`);
}
