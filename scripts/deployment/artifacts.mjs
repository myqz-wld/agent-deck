import { randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { runCommand } from './process.mjs';

const RELEASE_FILES = [
  'build/linux-headless/instance-manager/index.mjs',
  'build/linux-headless/relay/index.mjs',
  'build/linux-headless/server-core-host-bridge/index.mjs',
  'resources/bin/agent-deck-instance-manager',
  'resources/bin/agent-deck-relay',
  'resources/bin/agent-deck-relay-health-gate',
  'resources/bin/agent-deck-full-bridge',
  'deploy/linux/full/agent-deck-full@.container.in',
  'deploy/linux/full/preflight.sh',
  'deploy/linux/relay/agent-deck-relay@.container',
  'deploy/linux/relay/preflight.sh',
  'deploy/linux/relay/Containerfile',
];

function managerConfig(config) {
  const home = config.service.home;
  const uid = config.service.uid;
  return {
    schemaVersion: 1,
    roots: {
      serviceHome: home,
      runtimeRoot: `/run/user/${uid}`,
      unitRoot: `${home}/.config/containers/systemd`,
      metadataRoot: '/var/lib/agent-deck-manager/metadata',
      backupRoot: '/var/lib/agent-deck-manager/backups',
      journalRoot: '/var/lib/agent-deck-manager/journals',
      cutoverEvidenceRoot: '/etc/agent-deck-manager/evidence',
      fullTemplatePath: '/opt/agent-deck/share/full/agent-deck-full@.container.in',
      fullPreflightPath: '/opt/agent-deck/libexec/agent-deck-full-preflight',
      relayTemplatePath: '/opt/agent-deck/share/relay/agent-deck-relay@.container',
      relayPreflightPath: '/opt/agent-deck/libexec/agent-deck-relay-preflight',
      relayEvidenceRoot: '/etc/agent-deck-relay/evidence',
    },
    limits: {
      commandTimeoutMs: 120_000,
      lifecycleTimeoutMs: 180_000,
      healthTimeoutMs: 120_000,
      maxOutputBytes: 1_048_576,
      maxArtifactBytes: 4_194_304,
      maxEvidenceAgeMs: 604_800_000,
    },
    serviceUid: uid,
    trustedRootUid: 0,
    trustedArtifactUid: 0,
    lockRoot: '/var/lib/agent-deck-manager/locks',
  };
}

async function git(config, args, options = {}) {
  return runCommand('/usr/bin/git', args, {
    cwd: config.repoRoot,
    timeoutMs: options.timeoutMs ?? 120_000,
    maxOutputBytes: 1024 * 1024,
  });
}

export async function resolveRelease(config, options = {}) {
  const status = await git(config, ['status', '--porcelain', '--untracked-files=all']);
  if (status.stdout !== '') throw new Error('部署前必须先提交所有改动，包括 untracked 文件。');
  const head = (await git(config, ['rev-parse', 'HEAD'])).stdout.trim();
  const branch = (await git(config, ['symbolic-ref', '--short', 'HEAD'])).stdout.trim();
  const upstream = (await git(config, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).stdout.trim();
  const tracked = (await git(config, ['rev-parse', '@{u}'])).stdout.trim();
  if (tracked !== head) throw new Error(`当前 HEAD 未与 ${upstream} 对齐。`);
  if (options.verifyRemote !== false) {
    const remoteName = (await git(config, ['config', '--get', `branch.${branch}.remote`])).stdout.trim();
    const mergeRef = (await git(config, ['config', '--get', `branch.${branch}.merge`])).stdout.trim();
    const remote = await git(config, ['ls-remote', '--exit-code', remoteName, mergeRef], { timeoutMs: 60_000 });
    const remoteHead = remote.stdout.trim().split(/\s+/u)[0];
    if (remoteHead !== head) throw new Error('远端分支已有更新；请先同步并重新验证。');
  }
  return Object.freeze({
    commit: head,
    shortCommit: head.slice(0, 12),
    version: `git-${head.slice(0, 12)}`,
    branch,
    upstream,
  });
}

export async function verifyRepository(config, options = {}) {
  const scripts = [
    ['bash', ['-n', 'deploy/linux/full/preflight.sh']],
    ['bash', ['-n', 'deploy/linux/relay/preflight.sh']],
    ['bash', ['deploy/linux/full/static-check.sh']],
    ['bash', ['deploy/linux/relay/static-check.sh']],
    ['bash', ['deploy/linux/manager/static-check.sh']],
  ];
  for (const [command, args] of scripts) {
    await runCommand('/usr/bin/env', [command, ...args], {
      cwd: config.repoRoot,
      timeoutMs: 120_000,
      maxOutputBytes: 4 * 1024 * 1024,
    });
  }
  if (options.build === true) {
    await runCommand('/usr/bin/env', ['pnpm', 'build:linux-headless'], {
      cwd: config.repoRoot,
      timeoutMs: 300_000,
      maxOutputBytes: 8 * 1024 * 1024,
      stream: options.stream === true,
    });
  }
}

async function archiveDirectory(root, prefix) {
  const archive = join(tmpdir(), `${prefix}-${randomUUID()}.tgz`);
  await writeFile(archive, '', { mode: 0o600, flag: 'wx' });
  try {
    await runCommand('/usr/bin/tar', ['--no-xattrs', '-czf', archive, '-C', root, '.'], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
      timeoutMs: 120_000,
      maxOutputBytes: 1024 * 1024,
    });
    await chmod(archive, 0o600);
    return archive;
  } catch (error) {
    await rm(archive, { force: true });
    throw error;
  }
}

export async function buildReleaseArchive(config) {
  const staging = await mkdtemp(join(tmpdir(), 'agent-deck-release-'));
  try {
    for (const relativePath of RELEASE_FILES) {
      const target = join(staging, relativePath);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(resolve(config.repoRoot, relativePath), target);
    }
    const managerPath = join(staging, 'config/instance-manager.json');
    await mkdir(dirname(managerPath), { recursive: true, mode: 0o700 });
    await writeFile(managerPath, `${JSON.stringify(managerConfig(config), null, 2)}\n`, { mode: 0o600 });
    const archive = await archiveDirectory(staging, 'agent-deck-release');
    return {
      archive,
      cleanup: async () => {
        await rm(staging, { recursive: true, force: true });
        await rm(archive, { force: true });
      },
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function buildEvidenceArchive(evidence) {
  const staging = await mkdtemp(join(tmpdir(), 'agent-deck-evidence-'));
  try {
    for (const [name, value] of [
      ['runtime-egress', evidence.runtimeEgress],
      ['runtime-quota', evidence.runtimeQuota],
      ['exact-egress', evidence.exactEgress],
      ['exact-quota', evidence.exactQuota],
    ]) {
      const path = join(staging, name);
      await writeFile(path, value, { mode: 0o600 });
      await chmod(path, 0o600);
    }
    const archive = await archiveDirectory(staging, 'agent-deck-evidence');
    return {
      archive,
      cleanup: async () => {
        await rm(staging, { recursive: true, force: true });
        await rm(archive, { force: true });
      },
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function buildFullSecretsArchive(config) {
  const staging = await mkdtemp(join(tmpdir(), 'agent-deck-secrets-'));
  try {
    const inputs = [
      [config.secrets.credentialsFile, 'agent-deck/credentials.json'],
      [config.secrets.claudeCredentialsFile, 'agent-deck/provider-home/.claude/.credentials.json'],
      [config.secrets.codexAuthFile, 'agent-deck/provider-home/.codex/auth.json'],
      [config.secrets.grokAuthFile, 'agent-deck/provider-inference/grok-auth.json'],
    ];
    for (const [source, relativePath] of inputs) {
      if (source === null) continue;
      const target = join(staging, relativePath);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(source, target);
      await chmod(target, 0o600);
    }
    const archive = await archiveDirectory(staging, 'agent-deck-secrets');
    return {
      archive,
      cleanup: async () => {
        await rm(staging, { recursive: true, force: true });
        await rm(archive, { force: true });
      },
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
