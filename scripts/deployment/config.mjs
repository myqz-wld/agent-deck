import { isAbsolute, relative } from 'node:path';

import {
  absolutePath,
  digestReference,
  exactKeys,
  exactTrue,
  fail,
  object,
  positiveInteger,
  readTrustedJson,
  requireExecutable,
  requireTrustedFile,
  string,
  token,
} from './common.mjs';

const FULL_RESOURCE_KEYS = [
  'cpuCores', 'memoryBytes', 'pids', 'rootfsBytes', 'tmpfsBytes', 'logBytes',
];

function parseSsh(value) {
  const ssh = object(value, 'ssh');
  exactKeys(ssh, ['host', 'port', 'user', 'identityFile', 'knownHostsFile'], 'ssh');
  const host = string(ssh.host, 'ssh.host', 253);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(host)) {
    fail('ssh.host 仅支持规范化 DNS 名称或 IPv4 地址。');
  }
  const user = string(ssh.user, 'ssh.user', 32);
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) fail('ssh.user 格式无效。');
  return {
    host,
    port: positiveInteger(ssh.port, 'ssh.port', 65_535),
    user,
    identityFile: absolutePath(ssh.identityFile, 'ssh.identityFile'),
    knownHostsFile: absolutePath(ssh.knownHostsFile, 'ssh.knownHostsFile'),
    sshBinary: '/usr/bin/ssh',
    scpBinary: '/usr/bin/scp',
  };
}

function parseService(value) {
  const service = object(value, 'service');
  exactKeys(service, ['user', 'uid', 'home'], 'service');
  const user = string(service.user, 'service.user', 32);
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) fail('service.user 格式无效。');
  const home = absolutePath(service.home, 'service.home');
  return { user, uid: positiveInteger(service.uid, 'service.uid', 0x7fffffff), home };
}

function parseResources(value) {
  const resources = object(value, 'instance.fullResources');
  exactKeys(resources, FULL_RESOURCE_KEYS, 'instance.fullResources');
  if (typeof resources.cpuCores !== 'number' || !Number.isFinite(resources.cpuCores) || resources.cpuCores <= 0) {
    fail('instance.fullResources.cpuCores 必须是正数。');
  }
  return {
    cpuCores: resources.cpuCores,
    ...Object.fromEntries(FULL_RESOURCE_KEYS.slice(1).map((key) => [
      key,
      positiveInteger(resources[key], `instance.fullResources.${key}`),
    ])),
  };
}

function parseAcceptance(value, topology) {
  const acceptance = object(value, 'acceptance');
  const keys = topology === 'relay'
    ? ['egressVerified', 'quotaVerified', 'stateQuotaBytes']
    : ['egressVerified', 'quotaVerified'];
  exactKeys(acceptance, keys, 'acceptance');
  const stateQuotaBytes = topology === 'relay'
    ? positiveInteger(acceptance.stateQuotaBytes, 'acceptance.stateQuotaBytes')
    : null;
  if (topology === 'relay' && stateQuotaBytes !== 1_073_741_824) {
    fail('Relay 当前证据契约要求 acceptance.stateQuotaBytes 固定为 1073741824。');
  }
  return {
    egressVerified: exactTrue(acceptance.egressVerified, 'acceptance.egressVerified'),
    quotaVerified: exactTrue(acceptance.quotaVerified, 'acceptance.quotaVerified'),
    ...(topology === 'relay' ? {
      stateQuotaBytes,
    } : {}),
  };
}

function parseInstance(value, topology) {
  const instance = object(value, 'instance');
  exactKeys(
    instance,
    topology === 'full'
      ? ['id', 'runtimeConfigFile', 'fullResources']
      : ['id', 'runtimeConfigFile'],
    'instance',
  );
  return {
    id: token(instance.id, 'instance.id'),
    runtimeConfigFile: absolutePath(instance.runtimeConfigFile, 'instance.runtimeConfigFile'),
    ...(topology === 'full' ? { fullResources: parseResources(instance.fullResources) } : {}),
  };
}

function parseSecrets(value) {
  const secrets = object(value, 'secrets');
  exactKeys(secrets, [
    'credentialsFile', 'claudeCredentialsFile', 'codexAuthFile', 'grokAuthFile',
  ], 'secrets');
  const optional = (nested, field) => nested === null ? null : absolutePath(nested, field);
  return {
    credentialsFile: absolutePath(secrets.credentialsFile, 'secrets.credentialsFile'),
    claudeCredentialsFile: optional(secrets.claudeCredentialsFile, 'secrets.claudeCredentialsFile'),
    codexAuthFile: optional(secrets.codexAuthFile, 'secrets.codexAuthFile'),
    grokAuthFile: optional(secrets.grokAuthFile, 'secrets.grokAuthFile'),
  };
}

export async function loadServerConfig(path, topology, repoRoot) {
  const loaded = await readTrustedJson(path, '部署配置');
  const config = object(loaded.value, '部署配置');
  exactKeys(config, topology === 'full'
    ? ['schemaVersion', 'name', 'ssh', 'service', 'instance', 'image', 'acceptance', 'secrets']
    : ['schemaVersion', 'name', 'ssh', 'service', 'instance', 'image', 'acceptance'],
  '部署配置');
  if (config.schemaVersion !== 1) fail('部署配置 schemaVersion 不受支持。');
  const name = token(config.name, 'name');
  const image = object(config.image, 'image');
  exactKeys(
    image,
    topology === 'relay' ? ['repository', 'runtimeImage'] : ['reference'],
    'image',
  );
  const repository = topology === 'relay'
    ? string(image.repository, 'image.repository', 256)
    : null;
  if (repository && !/^(?:localhost\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/.test(repository)) {
    fail('image.repository 格式无效。');
  }
  const parsed = {
    schemaVersion: 1,
    topology,
    name,
    ssh: parseSsh(config.ssh),
    service: parseService(config.service),
    instance: parseInstance(config.instance, topology),
    image: topology === 'relay'
      ? {
          repository,
          runtimeImage: digestReference(image.runtimeImage, 'image.runtimeImage'),
        }
      : { reference: digestReference(image.reference, 'image.reference') },
    acceptance: parseAcceptance(config.acceptance, topology),
    ...(topology === 'full' ? { secrets: parseSecrets(config.secrets) } : {}),
    repoRoot,
    configPath: loaded.path,
  };
  await Promise.all([
    requireTrustedFile(parsed.ssh.identityFile, 'ssh.identityFile', { private: true }),
    requireTrustedFile(parsed.ssh.knownHostsFile, 'ssh.knownHostsFile'),
    requireExecutable(parsed.ssh.sshBinary, 'ssh executable'),
    requireExecutable(parsed.ssh.scpBinary, 'scp executable'),
    requireTrustedFile(parsed.instance.runtimeConfigFile, 'instance.runtimeConfigFile'),
    ...(topology === 'full'
      ? Object.entries(parsed.secrets)
          .filter(([, secretPath]) => secretPath !== null)
          .map(([field, secretPath]) => requireTrustedFile(
            secretPath,
            `secrets.${field}`,
            { private: true },
          ))
      : []),
  ]);
  const runtime = await readTrustedJson(parsed.instance.runtimeConfigFile, 'instance.runtimeConfigFile');
  const runtimeObject = object(runtime.value, 'runtimeConfig');
  if (runtimeObject.instanceId !== parsed.instance.id) {
    fail('runtimeConfig.instanceId 必须与 instance.id 完全一致。');
  }
  parsed.runtimeConfig = runtimeObject;
  if (topology === 'full') {
    const credentials = await readTrustedJson(
      parsed.secrets.credentialsFile,
      'secrets.credentialsFile',
    );
    if (object(credentials.value, 'credentials').instanceId !== parsed.instance.id) {
      fail('secrets.credentialsFile 的 instanceId 必须与 instance.id 完全一致。');
    }
  }
  return Object.freeze(parsed);
}

export async function loadWorkerConfig(path, repoRoot) {
  const loaded = await readTrustedJson(path, 'Worker 部署配置');
  const config = object(loaded.value, 'Worker 部署配置');
  exactKeys(config, ['schemaVersion', 'name', 'wrapper', 'credentialFile', 'workspace'], 'Worker 部署配置');
  if (config.schemaVersion !== 1) fail('Worker 部署配置 schemaVersion 不受支持。');
  const parsed = {
    schemaVersion: 1,
    name: token(config.name, 'name'),
    wrapper: absolutePath(config.wrapper, 'wrapper'),
    credentialFile: config.credentialFile === null
      ? null
      : absolutePath(config.credentialFile, 'credentialFile'),
    workspace: absolutePath(config.workspace, 'workspace'),
    repoRoot,
    configPath: loaded.path,
  };
  await Promise.all([
    requireExecutable(parsed.wrapper, 'wrapper'),
    ...(parsed.credentialFile === null
      ? []
      : [requireTrustedFile(parsed.credentialFile, 'credentialFile', { private: true })]),
  ]);
  const workspaceRelative = relative(repoRoot, parsed.workspace);
  if (workspaceRelative === '' || (!workspaceRelative.startsWith('..') && !isAbsolute(workspaceRelative))) {
    fail('Worker workspace 不能指向 Agent Deck 仓库或其子目录。');
  }
  return Object.freeze(parsed);
}
