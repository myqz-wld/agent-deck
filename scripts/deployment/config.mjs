import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';

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

function parseRelayRuntime(value, instanceId) {
  const runtime = object(value, 'runtimeConfig');
  exactKeys(runtime, [
    'authorityFile', 'instanceId', 'plumbingModule', 'schemaVersion', 'tickIntervalMs',
  ], 'runtimeConfig');
  if (runtime.schemaVersion !== 2) fail('runtimeConfig.schemaVersion 必须为 2。');
  if (runtime.instanceId !== instanceId) {
    fail('runtimeConfig.instanceId 必须与 instance.id 完全一致。');
  }
  const authorityFile = absolutePath(runtime.authorityFile, 'runtimeConfig.authorityFile');
  if (authorityFile !== `/etc/agent-deck-relay/${instanceId}/authority.json`) {
    fail('runtimeConfig.authorityFile 必须是实例容器内的固定 authority.json 路径。');
  }
  return {
    schemaVersion: 2,
    instanceId,
    tickIntervalMs: positiveInteger(runtime.tickIntervalMs, 'runtimeConfig.tickIntervalMs', 60_000),
    plumbingModule: runtime.plumbingModule === null
      ? null
      : absolutePath(runtime.plumbingModule, 'runtimeConfig.plumbingModule'),
    authorityFile,
  };
}

function parseFullRuntime(value, instanceId) {
  const runtime = object(value, 'runtimeConfig');
  exactKeys(runtime, [
    'appVersion', 'instanceId', 'runtimeModule', 'runtimeOptions', 'schemaVersion', 'socketPath',
  ], 'runtimeConfig');
  if (runtime.schemaVersion !== 1) fail('runtimeConfig.schemaVersion 必须为 1。');
  if (runtime.instanceId !== instanceId) {
    fail('runtimeConfig.instanceId 必须与 instance.id 完全一致。');
  }
  const appVersion = string(runtime.appVersion, 'runtimeConfig.appVersion', 128);
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(appVersion)) {
    fail('runtimeConfig.appVersion 包含无效控制字符。');
  }
  const socketPath = absolutePath(runtime.socketPath, 'runtimeConfig.socketPath');
  if (basename(socketPath) !== 'agent-deckd.sock' || basename(dirname(socketPath)) !== instanceId) {
    fail('runtimeConfig.socketPath 必须使用当前实例的 agent-deckd.sock 命名空间。');
  }
  return {
    schemaVersion: 1,
    instanceId,
    appVersion,
    runtimeModule: absolutePath(runtime.runtimeModule, 'runtimeConfig.runtimeModule'),
    runtimeOptions: object(runtime.runtimeOptions, 'runtimeConfig.runtimeOptions'),
    socketPath,
  };
}

function validateFullCredentials(value, instanceId) {
  const credentials = object(value, 'credentials');
  exactKeys(credentials, ['credentials', 'instanceId', 'schemaVersion'], 'credentials');
  if (credentials.schemaVersion !== 3) {
    fail('secrets.credentialsFile.schemaVersion 必须为 3。');
  }
  if (credentials.instanceId !== instanceId) {
    fail('secrets.credentialsFile 的 instanceId 必须与 instance.id 完全一致。');
  }
  if (!Array.isArray(credentials.credentials) || credentials.credentials.length > 256) {
    fail('secrets.credentialsFile.credentials 必须是当前有界数组。');
  }
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
  parsed.runtimeConfig = topology === 'relay'
    ? parseRelayRuntime(runtime.value, parsed.instance.id)
    : parseFullRuntime(runtime.value, parsed.instance.id);
  if (topology === 'full') {
    const credentials = await readTrustedJson(
      parsed.secrets.credentialsFile,
      'secrets.credentialsFile',
    );
    validateFullCredentials(credentials.value, parsed.instance.id);
  }
  return Object.freeze(parsed);
}

export async function loadWorkerConfig(path, repoRoot) {
  const loaded = await readTrustedJson(path, 'Worker 部署配置');
  const config = object(loaded.value, 'Worker 部署配置');
  exactKeys(config, [
    'schemaVersion', 'name', 'wrapper', 'credentialFile', 'workspace',
    ...(Object.hasOwn(config, 'providerSupervisor') ? ['providerSupervisor'] : []),
  ], 'Worker 部署配置');
  if (config.schemaVersion !== 1) fail('Worker 部署配置 schemaVersion 不受支持。');
  let providerSupervisor = null;
  if (Object.hasOwn(config, 'providerSupervisor') && config.providerSupervisor !== null) {
    const supervisor = object(config.providerSupervisor, 'providerSupervisor');
    exactKeys(supervisor, [
      'command', 'configFile', 'grokCredentialFile', 'workerConfigId',
    ], 'providerSupervisor');
    providerSupervisor = {
      command: absolutePath(supervisor.command, 'providerSupervisor.command'),
      configFile: absolutePath(supervisor.configFile, 'providerSupervisor.configFile'),
      grokCredentialFile: absolutePath(
        supervisor.grokCredentialFile,
        'providerSupervisor.grokCredentialFile',
      ),
      workerConfigId: token(
        supervisor.workerConfigId,
        'providerSupervisor.workerConfigId',
        /^worker-[a-f0-9]{24}$/,
      ),
    };
  }
  const parsed = {
    schemaVersion: 1,
    name: token(config.name, 'name'),
    wrapper: absolutePath(config.wrapper, 'wrapper'),
    credentialFile: config.credentialFile === null
      ? null
      : absolutePath(config.credentialFile, 'credentialFile'),
    workspace: absolutePath(config.workspace, 'workspace'),
    providerSupervisor,
    repoRoot,
    configPath: loaded.path,
  };
  await Promise.all([
    requireExecutable(parsed.wrapper, 'wrapper'),
    ...(parsed.credentialFile === null
      ? []
      : [requireTrustedFile(parsed.credentialFile, 'credentialFile', { private: true })]),
    ...(parsed.providerSupervisor === null ? [] : [
      requireExecutable(parsed.providerSupervisor.command, 'providerSupervisor.command'),
      requireTrustedFile(
        parsed.providerSupervisor.configFile,
        'providerSupervisor.configFile',
        { private: true },
      ),
      requireTrustedFile(
        parsed.providerSupervisor.grokCredentialFile,
        'providerSupervisor.grokCredentialFile',
        { private: true },
      ),
    ]),
  ]);
  if (parsed.providerSupervisor !== null) {
    if (
      dirname(parsed.providerSupervisor.command) !== dirname(parsed.wrapper) ||
      basename(parsed.providerSupervisor.command) !== 'agent-deck-provider-supervisor'
    ) {
      fail('Provider supervisor 必须与 Worker wrapper 来自同一个应用 bin 目录。');
    }
    const templateFile = resolve(
      dirname(parsed.providerSupervisor.command),
      '../provider-session/com.agentdeck.provider-supervisor.plist.in',
    );
    await requireTrustedFile(templateFile, 'providerSupervisor LaunchAgent template');
    const supervisorConfig = object(
      (await readTrustedJson(
        parsed.providerSupervisor.configFile,
        'providerSupervisor.configFile',
        { maxBytes: 64 * 1024 },
      )).value,
      'providerSupervisor.configFile',
    );
    exactKeys(supervisorConfig, [
      'brokerRoot', 'desktopSocketPath', 'desktopVm', 'engine', 'executable', 'images',
      'instanceId', 'maxActive', 'privateRoot', 'rootlessHome', 'rootlessRuntimeDirectory',
      'schemaVersion', 'stateRoot', 'transportRuntimeDirectory', 'transportSocketPath',
      'workspaceRoot',
    ], 'providerSupervisor.configFile');
    if (supervisorConfig.schemaVersion !== 1 ||
        supervisorConfig.workspaceRoot !== parsed.workspace) {
      fail('Provider supervisor 配置必须使用 schemaVersion 1 和同一个 Worker workspace。');
    }
    parsed.providerSupervisor = Object.freeze({
      ...parsed.providerSupervisor,
      templateFile,
      hostConfig: Object.freeze({
        instanceId: token(supervisorConfig.instanceId, 'providerSupervisor.instanceId'),
        privateRoot: absolutePath(supervisorConfig.privateRoot, 'providerSupervisor.privateRoot'),
        stateRoot: absolutePath(supervisorConfig.stateRoot, 'providerSupervisor.stateRoot'),
        brokerRoot: absolutePath(supervisorConfig.brokerRoot, 'providerSupervisor.brokerRoot'),
        transportRuntimeDirectory: absolutePath(
          supervisorConfig.transportRuntimeDirectory,
          'providerSupervisor.transportRuntimeDirectory',
        ),
        transportSocketPath: absolutePath(
          supervisorConfig.transportSocketPath,
          'providerSupervisor.transportSocketPath',
        ),
      }),
    });
  }
  const workspaceRelative = relative(repoRoot, parsed.workspace);
  if (workspaceRelative === '' || (!workspaceRelative.startsWith('..') && !isAbsolute(workspaceRelative))) {
    fail('Worker workspace 不能指向 Agent Deck 仓库或其子目录。');
  }
  return Object.freeze(parsed);
}
