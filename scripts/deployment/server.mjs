import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildEvidenceArchive,
  buildFullSecretsArchive,
  buildReleaseArchive,
  resolveRelease,
  verifyRepository,
} from './artifacts.mjs';
import { buildAcceptanceEvidence, renderManagedUnit, sha256 } from './evidence.mjs';
import { runRemoteScript, uploadFile } from './process.mjs';

const deploymentRoot = dirname(fileURLToPath(import.meta.url));
export const RELEASE_UPLOAD_TIMEOUT_MS = 1_200_000;
const remoteScripts = Object.freeze({
  check: join(deploymentRoot, 'remote-check.sh'),
  install: join(deploymentRoot, 'remote-install.sh'),
  manager: join(deploymentRoot, 'remote-manager.sh'),
  evidence: join(deploymentRoot, 'remote-evidence.sh'),
  verify: join(deploymentRoot, 'remote-verify.sh'),
  fullSecrets: join(deploymentRoot, 'remote-full-secrets.sh'),
  relayAuthority: join(deploymentRoot, 'remote-relay-authority.sh'),
});

function remoteIdentity(config) {
  return [
    config.topology,
    config.service.user,
    String(config.service.uid),
    config.service.home,
    config.instance.id,
  ];
}

async function remoteCheck(config) {
  const result = await runRemoteScript(config.ssh, remoteScripts.check, remoteIdentity(config));
  if (result.stdout.trim() !== 'REMOTE_CHECK_OK') {
    throw new Error('远程部署预检返回了未知结果。');
  }
}

function parseImage(stdout) {
  const matches = [...stdout.matchAll(/^AGENT_DECK_IMAGE=(.+)$/gmu)];
  if (matches.length !== 1 || !/@sha256:[a-f0-9]{64}$/.test(matches[0][1])) {
    throw new Error('远程 release 未返回唯一的 digest-pinned image。');
  }
  return matches[0][1];
}

async function installRelease(config, release) {
  const prepared = await buildReleaseArchive(config);
  const remoteArchive = `/tmp/agent-deck-release-${randomUUID()}.tgz`;
  try {
    await uploadFile(config.ssh, prepared.archive, remoteArchive, {
      timeoutMs: RELEASE_UPLOAD_TIMEOUT_MS,
    });
    const result = await runRemoteScript(
      config.ssh,
      remoteScripts.install,
      [
        remoteArchive,
        config.topology,
        config.service.user,
        String(config.service.uid),
        config.service.home,
        config.instance.id,
        release.version,
        config.topology === 'relay' ? config.image.repository : '-',
        config.topology === 'relay' ? config.image.runtimeImage : config.image.reference,
      ],
      { timeoutMs: 900_000, maxOutputBytes: 8 * 1024 * 1024 },
    );
    return parseImage(result.stdout);
  } finally {
    await prepared.cleanup();
  }
}

function parseManager(stdout, command) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`实例管理器 ${command} 返回了无效 JSON。`);
  }
  if (parsed?.schemaVersion !== 1 || parsed?.ok !== true || parsed.command !== command) {
    throw new Error(`实例管理器 ${command} 返回了无效结果。`);
  }
  return parsed.result;
}

class ManagerCommandError extends Error {
  constructor(command, managerCode, cause) {
    super(`实例管理器 ${command} 失败（code=${managerCode}）。`, { cause });
    this.name = 'ManagerCommandError';
    this.managerCode = managerCode;
  }
}

export function managerFailureCode(error) {
  const direct = error && typeof error === 'object' ? error.managerCode : null;
  if (typeof direct === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(direct)) return direct;
  const stderr = error && typeof error === 'object' && error.result?.stderr;
  if (typeof stderr !== 'string') return null;
  for (const line of stderr.trim().split('\n').reverse()) {
    try {
      const parsed = JSON.parse(line);
      if (
        parsed?.schemaVersion === 1 && parsed?.ok === false &&
        typeof parsed.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(parsed.code)
      ) {
        return parsed.code;
      }
    } catch {
      // Ignore non-JSON diagnostics from SSH and sudo; the manager result remains authoritative.
    }
  }
  return null;
}

async function runManager(config, command, request) {
  const root = await mkdtemp(join(tmpdir(), 'agent-deck-request-'));
  const localPath = join(root, 'request.json');
  const requestId = randomUUID();
  const remotePath = `/tmp/agent-deck-request-${requestId}.json`;
  try {
    await writeFile(localPath, `${JSON.stringify(request, null, 2)}\n`, { mode: 0o600 });
    await chmod(localPath, 0o600);
    await uploadFile(config.ssh, localPath, remotePath);
    let result;
    try {
      result = await runRemoteScript(
        config.ssh,
        remoteScripts.manager,
        [config.service.user, String(config.service.uid), remotePath, requestId, command],
        { timeoutMs: 600_000, maxOutputBytes: 4 * 1024 * 1024 },
      );
    } catch (error) {
      const managerCode = managerFailureCode(error);
      if (managerCode) throw new ManagerCommandError(command, managerCode, error);
      throw error;
    }
    return parseManager(result.stdout, command);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function selector(config) {
  return { topology: config.topology, instanceId: config.instance.id };
}

function createRequest(config, release, image) {
  return {
    ...selector(config),
    version: release.version,
    image,
    runtimeConfig: config.runtimeConfig,
    ...(config.topology === 'full' ? { fullResources: config.instance.fullResources } : {}),
  };
}

function upgradeRequest(config, release, image, state) {
  return {
    ...selector(config),
    expectedGeneration: state.generation,
    expectedVersion: state.currentVersion,
    nextVersion: release.version,
    nextImage: image,
    runtimeConfig: config.runtimeConfig,
    ...(config.topology === 'full' ? { fullResources: config.instance.fullResources } : {}),
  };
}

export function relayCutoverRecovery(config, state, status) {
  if (config.topology !== 'relay' || status?.systemd?.activeState === 'active') return null;
  const current = state.versions.find((version) => version.version === state.currentVersion);
  if (!current) throw new Error('当前 Relay generation 缺少可恢复的 release 记录。');
  return {
    plan: { generation: state.generation, version: state.currentVersion },
    details: current,
  };
}

export function existingInstanceNeedsStart(status) {
  return status?.systemd?.activeState !== 'active';
}

async function ensureRelayRunningForCutover(config, state) {
  if (config.topology !== 'relay') return;
  const status = await runManager(config, 'status', selector(config));
  const recovery = relayCutoverRecovery(config, state, status);
  if (!recovery) return;
  await installEvidence(config, recovery.plan, recovery.details);
  await runManager(config, 'start', selector(config));
}

async function installEvidence(config, plan, details) {
  const evidence = buildAcceptanceEvidence({
    topology: config.topology,
    instanceId: config.instance.id,
    generation: plan.generation,
    version: plan.version,
    image: details.image,
    unitSha256: details.unitSha256,
    ...(config.topology === 'relay'
      ? { stateQuotaBytes: config.acceptance.stateQuotaBytes }
      : { fullResources: details.fullResources }),
  });
  const prepared = await buildEvidenceArchive(evidence);
  const remoteArchive = `/tmp/agent-deck-evidence-${randomUUID()}.tgz`;
  try {
    await uploadFile(config.ssh, prepared.archive, remoteArchive);
    const result = await runRemoteScript(
      config.ssh,
      remoteScripts.evidence,
      [
        remoteArchive,
        config.topology,
        config.service.user,
        String(config.service.uid),
        config.service.home,
        config.instance.id,
        String(plan.generation),
        plan.version,
      ],
      { timeoutMs: 300_000 },
    );
    if (result.stdout.trim() !== 'EVIDENCE_INSTALL_OK') {
      throw new Error('远程验收证据安装返回了未知结果。');
    }
  } finally {
    await prepared.cleanup();
  }
}

async function installFullSecrets(config) {
  const prepared = await buildFullSecretsArchive(config);
  const remoteArchive = `/tmp/agent-deck-secrets-${randomUUID()}.tgz`;
  try {
    await uploadFile(config.ssh, prepared.archive, remoteArchive);
    const result = await runRemoteScript(
      config.ssh,
      remoteScripts.fullSecrets,
      [
        remoteArchive,
        config.service.user,
        String(config.service.uid),
        config.service.home,
        config.instance.id,
      ],
      { timeoutMs: 300_000 },
    );
    if (result.stdout.trim() !== 'FULL_SECRETS_INSTALL_OK') {
      throw new Error('Full secrets 初始化返回了未知结果。');
    }
  } finally {
    await prepared.cleanup();
  }
}

async function ensureRelayAuthority(config, mode) {
  if (config.topology !== 'relay') return;
  const result = await runRemoteScript(
    config.ssh,
    remoteScripts.relayAuthority,
    [mode, config.service.user, String(config.service.uid), config.service.home, config.instance.id],
    { timeoutMs: 120_000 },
  );
  const output = result.stdout.trim();
  if (output !== 'RELAY_AUTHORITY_CREATED' && output !== 'RELAY_AUTHORITY_READY') {
    throw new Error('Relay connection authority 初始化返回了未知结果。');
  }
}

export function parseVerification(stdout, config, expectedImage = '-') {
  const output = stdout.trim();
  const match = /^VERIFY_OK topology=(relay|full) instance=([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?) image=(\S+@sha256:[a-f0-9]{64}) health=healthy feishuRuntime=ready$/u.exec(output);
  if (
    !match || match[1] !== config.topology || match[2] !== config.instance.id ||
    (expectedImage !== '-' && match[3] !== expectedImage)
  ) {
    throw new Error('远程部署验证返回了无效或不匹配的当前结果。');
  }
  return output;
}

async function verify(config, expectedImage = '-') {
  const result = await runRemoteScript(
    config.ssh,
    remoteScripts.verify,
    [...remoteIdentity(config), expectedImage],
    { timeoutMs: 120_000 },
  );
  return parseVerification(result.stdout, config, expectedImage);
}

async function prepareMutableRelease(config) {
  const release = await resolveRelease(config);
  await verifyRepository(config, { build: true, stream: true });
  await remoteCheck(config);
  const image = await installRelease(config, release);
  return { release, image };
}

async function deploy(config) {
  const { release, image } = await prepareMutableRelease(config);
  const request = createRequest(config, release, image);
  let existing = null;
  try {
    existing = await runManager(config, 'describe', selector(config));
  } catch (error) {
    if (managerFailureCode(error) !== 'not_found') throw error;
    existing = null;
  }
  if (existing !== null) {
    if (existing.currentVersion !== release.version) {
      throw new Error('实例已经存在且不是当前 Git release；请使用 --upgrade。');
    }
    const current = existing.versions.find((version) => version.version === release.version);
    if (!current) throw new Error('现有实例缺少当前 release 记录。');
    if (config.topology === 'full') await installFullSecrets(config);
    else await ensureRelayAuthority(config, 'create');
    await installEvidence(config, {
      generation: existing.generation,
      version: existing.currentVersion,
    }, current);
    const status = await runManager(config, 'status', selector(config));
    if (existingInstanceNeedsStart(status)) {
      await runManager(config, 'start', selector(config));
    }
    return {
      release,
      image: current.image,
      resumed: true,
      verification: await verify(config, current.image),
    };
  }
  const unitSha256 = sha256(await renderManagedUnit(config, image));
  const plan = await runManager(config, 'plan-create', request);
  await runManager(config, 'create', request);
  if (config.topology === 'full') await installFullSecrets(config);
  else await ensureRelayAuthority(config, 'create');
  const state = await runManager(config, 'describe', selector(config));
  const current = state.versions.find((version) => version.version === release.version);
  if (!current || current.unitSha256 !== unitSha256 || current.image !== image) {
    throw new Error('创建后的实例记录与本地 release 不一致。');
  }
  await installEvidence(config, plan, {
    image,
    unitSha256,
    fullResources: config.instance.fullResources,
  });
  await runManager(config, 'start', selector(config));
  return { release, image, verification: await verify(config, image) };
}

async function upgrade(config) {
  const { release, image } = await prepareMutableRelease(config);
  const state = await runManager(config, 'describe', selector(config));
  if (state.currentVersion === release.version) {
    throw new Error('目标实例已经运行当前 Git release；无需 upgrade。');
  }
  await ensureRelayAuthority(config, 'verify');
  await ensureRelayRunningForCutover(config, state);
  const request = upgradeRequest(config, release, image, state);
  const plan = await runManager(config, 'plan-upgrade', request);
  const unitSha256 = sha256(await renderManagedUnit(config, image));
  await installEvidence(config, plan, {
    image,
    unitSha256,
    fullResources: config.instance.fullResources,
  });
  await runManager(config, 'upgrade', request);
  return { release, image, verification: await verify(config, image) };
}

async function rollback(config) {
  const release = await resolveRelease(config);
  await verifyRepository(config, { build: false });
  await remoteCheck(config);
  const state = await runManager(config, 'describe', selector(config));
  await ensureRelayAuthority(config, 'verify');
  if (!state.previousVersion) throw new Error('目标实例没有可恢复的 previousVersion。');
  const request = {
    ...selector(config),
    expectedGeneration: state.generation,
    expectedVersion: state.currentVersion,
  };
  const plan = await runManager(config, 'plan-rollback', request);
  const target = state.versions.find((version) => version.version === plan.version);
  if (!target) throw new Error('实例记录缺少 rollback 目标 release。');
  if (config.topology === 'full' && !target.fullResources) {
    throw new Error('Full rollback 目标缺少资源记录。');
  }
  await installEvidence(config, plan, target);
  await runManager(config, 'rollback', request);
  return {
    release,
    image: target.image,
    version: target.version,
    verification: await verify(config, target.image),
  };
}

export async function runServerDeployment(config, action) {
  if (action !== 'verify' && config.service.home !== '/var/lib/agent-deck') {
    throw new Error('受管 lifecycle 要求 service.home 固定为 /var/lib/agent-deck；其他 home 仅可执行 --verify。');
  }
  if (action === 'dry-run') {
    const release = await resolveRelease(config);
    return {
      action,
      name: config.name,
      topology: config.topology,
      release,
      host: config.ssh.host,
      instanceId: config.instance.id,
      mutatesRemote: false,
      plannedSteps: [
        '验证仓库、SSH pin、远程 prerequisites 与显式验收声明',
        config.topology === 'relay' ? '构建并固定 Relay image digest' : '拉取并检查 Full image digest',
        '安装 root-owned host artifacts 与实例管理器',
        '执行 generation-fenced create/upgrade/rollback',
        '安装与目标 unit digest 绑定的验收证据并验证健康状态',
      ],
    };
  }
  if (action === 'check') {
    const release = await resolveRelease(config);
    await verifyRepository(config, { build: false });
    await remoteCheck(config);
    return { action, name: config.name, topology: config.topology, release, status: 'ok' };
  }
  if (action === 'verify') {
    return {
      action,
      name: config.name,
      topology: config.topology,
      verification: await verify(config),
    };
  }
  if (action === 'deploy') return { action, ...(await deploy(config)) };
  if (action === 'upgrade') return { action, ...(await upgrade(config)) };
  if (action === 'rollback') return { action, ...(await rollback(config)) };
  throw new Error(`不支持的 server 部署操作：${action}`);
}
