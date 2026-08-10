import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function bytes(value) {
  return String(value);
}

function cpu(value) {
  return value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

export async function renderManagedUnit(config, image) {
  const templatePath = resolve(
    config.repoRoot,
    config.topology === 'full'
      ? 'deploy/linux/full/agent-deck-full@.container.in'
      : 'deploy/linux/relay/agent-deck-relay@.container',
  );
  let rendered = await readFile(templatePath, 'utf8');
  if (config.topology === 'relay') {
    const lines = rendered.match(/^Image=.*$/gm) ?? [];
    if (lines.length !== 1 || !lines[0].includes('__REPLACE_WITH_PINNED_DIGEST__')) {
      throw new Error('Relay Quadlet 模板镜像占位符无效。');
    }
    return rendered.replace(lines[0], `Image=${image}`);
  }
  const resources = config.instance.fullResources;
  const replacements = {
    IMAGE_DIGEST: image,
    VERIFIED_EGRESS_NETWORK: `agent-deck-${config.instance.id}-egress`,
    TMPFS_SIZE: bytes(resources.tmpfsBytes),
    MEMORY_LIMIT: bytes(resources.memoryBytes),
    PIDS_LIMIT: bytes(resources.pids),
    CPU_LIMIT: cpu(resources.cpuCores),
    ROOTFS_SIZE: bytes(resources.rootfsBytes),
    LOG_SIZE: bytes(resources.logBytes),
  };
  for (const [key, value] of Object.entries(replacements)) {
    const marker = `@@${key}@@`;
    if (rendered.split(marker).length !== 2) throw new Error(`Full Quadlet 缺少唯一占位符 ${marker}。`);
    rendered = rendered.replace(marker, value);
  }
  if (rendered.includes('@@')) throw new Error('Full Quadlet 仍包含未知占位符。');
  return rendered;
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function text(lines) {
  return `${lines.join('\n')}\n`;
}

export function buildAcceptanceEvidence(input) {
  const common = [
    'schemaVersion=2',
    `topology=${input.topology}`,
    `instanceId=${input.instanceId}`,
    `generation=${input.generation}`,
    `version=${input.version}`,
    `image=${input.image}`,
    `unitSha256=${input.unitSha256}`,
  ];
  if (input.topology === 'relay') {
    return {
      legacyEgress: text([
        'schemaVersion=1',
        `instanceId=${input.instanceId}`,
        'publicOnlyEgressVerified=true',
        'privateAndLinkLocalDenied=true',
        'cloudMetadataDenied=true',
      ]),
      legacyQuota: text([
        'schemaVersion=1',
        `instanceId=${input.instanceId}`,
        `statePath=/var/lib/agent-deck/.local/share/agent-deck-relay/${input.instanceId}`,
        'stateQuotaEnforced=true',
        `stateQuotaBytes=${input.stateQuotaBytes}`,
      ]),
      exactEgress: text([
        ...common,
        'networkName=slirp4netns:allow_host_loopback=false',
        'networkPolicy=public-only-private-linklocal-metadata-denied',
        'egressVerified=true',
      ]),
      exactQuota: text([
        ...common,
        `statePath=/var/lib/agent-deck/.local/share/agent-deck-relay/${input.instanceId}`,
        'stateQuotaBytes=1073741824',
        'quotaVerified=true',
      ]),
    };
  }
  const resources = input.fullResources;
  const volumes = ['state', 'workspace', 'socket', 'browser', 'secrets']
    .map((suffix) => `agent-deck-${input.instanceId}-${suffix}`);
  return {
    legacyEgress: text([
      'schemaVersion=1',
      `instanceId=${input.instanceId}`,
      'topology=full',
      'publicOnlyEgressVerified=true',
      'privateAndLinkLocalDenied=true',
      'cloudMetadataDenied=true',
    ]),
    legacyQuota: text([
      'schemaVersion=1',
      `instanceId=${input.instanceId}`,
      'topology=full',
      ...volumes.map((volume, index) => `${['state', 'workspace', 'socket', 'browser', 'secrets'][index]}Volume=${volume}`),
      'volumeQuotaEnforced=true',
    ]),
    exactEgress: text([
      ...common,
      `networkName=agent-deck-${input.instanceId}-egress`,
      'networkPolicy=public-dns-http-https-only',
      'egressVerified=true',
    ]),
    exactQuota: text([
      ...common,
      `cpuCores=${cpu(resources.cpuCores)}`,
      `memoryBytes=${resources.memoryBytes}`,
      `pids=${resources.pids}`,
      `rootfsBytes=${resources.rootfsBytes}`,
      `tmpfsBytes=${resources.tmpfsBytes}`,
      `logBytes=${resources.logBytes}`,
      `volumes=${volumes.join(',')}`,
      'quotaVerified=true',
    ]),
  };
}
