import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  bootstrapLaunchAgentWithRetry,
  launchAgentProcessId,
  waitForLaunchAgentProcessExit,
} from './deployment/worker-supervisor.mjs';

const LABEL = /^com\.agentdeck\.(worker|provider-supervisor)\.[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;

function execute(command, args, input) {
  const result = spawnSync(command, args, {
    encoding: 'utf8', input, timeout: 30_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C' },
  });
  if (result.error) throw result.error;
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function readDefinition(path, uid) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid ||
      (stat.mode & 0o022) !== 0 || stat.size > 128 * 1024 || realpathSync(path) !== path) {
    throw new Error('后台服务定义不可信，已取消安装。');
  }
  const bytes = readFileSync(path);
  const converted = execute('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], bytes);
  if (converted.code !== 0) throw new Error('无法读取后台服务定义，已取消安装。');
  return {
    definition: JSON.parse(converted.stdout),
    fingerprint: createHash('sha256').update(bytes).digest('hex'),
  };
}

function runtime(options) {
  const uid = options.uid ?? process.getuid();
  const root = options.root ?? join(homedir(), 'Library/LaunchAgents');
  return {
    uid, root,
    files: () => {
      try { return readdirSync(root); } catch (error) {
        if (error?.code === 'ENOENT') return [];
        throw error;
      }
    },
    read: (path) => readDefinition(path, uid),
    launchctl: (args) => execute('/bin/launchctl', args),
    wait: delay,
    waitForExit: waitForLaunchAgentProcessExit,
    ...options,
  };
}

function inspect(job, host) {
  const result = host.launchctl(['print', job.target]);
  if (result.code === 113 && /Could not find service/.test(result.stderr)) return null;
  if (result.code !== 0) throw new Error('无法核实后台服务状态，已取消安装。');
  const field = (name) => result.stdout.match(new RegExp(`^\\s*${name} = (.+)$`, 'm'))?.[1];
  const block = result.stdout.match(/^\s*arguments = \{\s*$([\s\S]*?)^\s*\}/m)?.[1];
  const args = block?.split('\n').map((line) => line.trim()).filter(Boolean) ?? [];
  if (field('path') !== job.path || field('program') !== job.program ||
      JSON.stringify(args) !== JSON.stringify(job.args)) {
    throw new Error('后台服务已加载的身份与安装目标不匹配，已取消操作。');
  }
  return { pid: launchAgentProcessId(result.stdout), running: field('state') === 'running' };
}

function assertDefinition(job, host) {
  if (host.read(job.path).fingerprint !== job.fingerprint) {
    throw new Error('后台服务定义在安装期间发生变化，已取消操作。');
  }
}

async function waitForUnload(job, host) {
  // launchctl bootout returns before a SIGTERMed job has left the launchd domain.
  // A still-registered job must not count as restored: it will disappear after exit.
  for (let attempt = 0; attempt < 300; attempt += 1) {
    assertDefinition(job, host);
    if (!inspect(job, host)) return;
    await host.wait(100);
  }
  throw new Error('后台服务未在期限内完成卸载，已取消安装。');
}

export function discoverAppLaunchAgents(appPath, options = {}) {
  const host = runtime(options);
  const jobs = [];
  for (const filename of host.files()) {
    const label = filename.replace(/\.plist$/, '');
    const match = LABEL.exec(label);
    if (!match || filename !== `${label}.plist` || basename(filename) !== filename) continue;
    const path = join(host.root, filename);
    const { definition, fingerprint } = host.read(path);
    const program = definition.Program ?? definition.ProgramArguments?.[0];
    const expected = resolve(appPath, match[1] === 'worker'
      ? 'Contents/MacOS/agent-deck-worker-sandbox'
      : 'Contents/Resources/bin/agent-deck-provider-supervisor');
    // Another installed copy can own a same-kind service; never stop it for this bundle.
    if (program !== expected) continue;
    const args = definition.ProgramArguments;
    if (definition.Label !== label || !Array.isArray(args) || args[0] !== program ||
        !args.every((arg) => typeof arg === 'string' && !/[\r\n\0]/.test(arg))) {
      throw new Error('后台服务定义与安装目标不匹配，已取消安装。');
    }
    const job = { label, path, program, args, fingerprint, kind: match[1],
      domain: `gui/${host.uid}`, target: `gui/${host.uid}/${label}` };
    const current = inspect(job, host);
    if (current) jobs.push({ ...job, ...current });
  }
  // Stop consumers first; restore the provider supervisor before its Worker.
  return jobs.sort((a, b) => Number(a.kind !== 'worker') - Number(b.kind !== 'worker') ||
    a.label.localeCompare(b.label));
}

async function restoreJobs(jobs, host) {
  const errors = [];
  for (const job of [...jobs].reverse()) {
    try {
      assertDefinition(job, host);
      if (job.unloadRequested) {
        await waitForUnload(job, host);
        job.unloadRequested = false;
      }
      if (!inspect(job, host)) {
        await host.waitForExit(job.pid);
        await bootstrapLaunchAgentWithRetry({
          ...job, plistPath: job.path, execute: host.launchctl, wait: host.wait,
        });
      }
      let restored;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        restored = inspect(job, host);
        if (restored && (!job.running || restored.running)) break;
        await host.wait(100);
      }
      if (!restored || (job.running && !restored.running)) {
        throw new Error('后台服务未在期限内恢复运行。');
      }
    } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors,
    `后台服务恢复失败：${errors.map((error) => error.message).join('；')}`);
}

/** --stop-running authorizes quiescing only verified jobs belonging to the target bundle. */
export async function pauseAppLaunchAgents(appPath, options = {}) {
  const host = runtime(options);
  const jobs = discoverAppLaunchAgents(appPath, host);
  const paused = [];
  try {
    for (const job of jobs) {
      assertDefinition(job, host);
      if (!inspect(job, host)) continue;
      const pausedJob = { ...job, unloadRequested: false };
      paused.push(pausedJob);
      const stopped = host.launchctl(['bootout', job.target]);
      if (stopped.code !== 0) {
        throw new Error(`后台服务无法受控暂停（exit ${stopped.code}），已取消安装。`);
      }
      pausedJob.unloadRequested = true;
      await waitForUnload(job, host);
    }
  } catch (error) {
    try { await restoreJobs(paused, host); } catch (restoreError) {
      throw new AggregateError([error, restoreError], `${error.message} ${restoreError.message}`);
    }
    throw error;
  }
  return () => restoreJobs(paused, host);
}
