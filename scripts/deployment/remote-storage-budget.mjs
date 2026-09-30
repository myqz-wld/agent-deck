import { statSync, statfsSync } from 'node:fs';
import { dirname } from 'node:path';

export const DEPLOYMENT_FREE_RESERVE_BYTES = 256 * 1024 * 1024;

function byteCount(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid disk budget');
  return value;
}

export function assessStorageBudget(requirements, filesystems) {
  const groups = new Map();
  for (const [role, bytes] of Object.entries(requirements)) {
    byteCount(bytes);
    const volume = filesystems[role];
    if (!volume || typeof volume.device !== 'string') throw new Error('missing filesystem');
    byteCount(volume.availableBytes);
    let group = groups.get(volume.device);
    if (!group) {
      group = { roles: [], availableBytes: volume.availableBytes, requiredBytes: DEPLOYMENT_FREE_RESERVE_BYTES };
      groups.set(volume.device, group);
    }
    group.roles.push(role);
    group.availableBytes = Math.min(group.availableBytes, volume.availableBytes);
    group.requiredBytes = byteCount(group.requiredBytes + bytes);
  }
  const checks = [...groups.values()];
  return { schemaVersion: 1, ok: checks.every(c => c.availableBytes >= c.requiredBytes), checks };
}

function filesystem(path) {
  let existing = path;
  for (;;) {
    try {
      const metadata = statSync(existing);
      const capacity = statfsSync(existing, { bigint: true });
      const available = capacity.bavail * capacity.bsize;
      return {
        device: String(metadata.dev),
        availableBytes: Number(available > BigInt(Number.MAX_SAFE_INTEGER)
          ? BigInt(Number.MAX_SAFE_INTEGER) : available),
      };
    } catch (error) {
      if (error.code !== 'ENOENT' || dirname(existing) === existing) throw error;
      existing = dirname(existing);
    }
  }
}

export function inspectDeploymentStorage(values, architecture = process.arch) {
  if (values.length !== 4 || values.some(value => !/^(0|[1-9][0-9]*)$/u.test(value))) {
    throw new Error('invalid disk budget arguments');
  }
  const [archive, expanded, amd64, arm64] = values.map(value => byteCount(Number(value)));
  if (!['x64', 'arm64'].includes(architecture)) throw new Error('unsupported architecture');
  return assessStorageBudget({
    staging: byteCount(archive + expanded),
    runtime: architecture === 'arm64' ? arm64 : amd64,
    service: 0,
  }, {
    staging: filesystem('/tmp'),
    runtime: filesystem('/opt/agent-deck'),
    service: filesystem('/var/lib/agent-deck'),
  });
}

if (process.argv[1] === '-') {
  try {
    const result = inspectDeploymentStorage(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 1;
  } catch {
    process.stderr.write('无法核验远程部署磁盘预算。\n');
    process.exitCode = 1;
  }
}
