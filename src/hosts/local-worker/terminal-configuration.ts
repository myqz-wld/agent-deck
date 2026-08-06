import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import { isJsonObject, parseWorkspaceSandboxSpec, type JsonObject } from '@contracts/index';
import { readTrustedTextFile } from '@hosts/linux-runtime/connection-credential-issuer';
import { AtomicPrivateStateFile } from '@hosts/linux-runtime/atomic-state-file';
import {
  isRemoteConnectionWorkerCredential,
  parseRemoteConnectionCredential,
  renderRemoteConnectionKnownHosts,
} from '@shared/remote-host';

import { parseLocalWorkerHeadlessConfig, type LocalWorkerHeadlessConfig } from './headless-config';
import { projectLocalWorkerProviderHome } from './provider-home-projection';

const WORKER_CONFIG_FILE = 'worker.json';
export const DARWIN_WORKSPACE_BOOKMARK_FILE = 'workspace.bookmark';
const MAX_APP_VERSION_BYTES = 128;
const MAX_BOOKMARK_BYTES = 1024 * 1024;
const BOOKMARK_TIMEOUT_MS = 20_000;

export interface LocalWorkerWorkspaceBookmarkPort {
  create(workspaceRoot: string, bookmarkFile: string): Promise<void>;
}

export interface ConfigureLocalWorkerInput {
  readonly appVersion: string;
  readonly credentialFile: string;
  readonly runtimeModule: string;
  readonly runtimeOptions?: JsonObject;
  readonly runtimeReadRoots: readonly string[];
  readonly sshBinary: string;
  readonly stateRoot: string;
  readonly workspaceRoot: string;
  readonly connectTimeoutSeconds?: number;
  readonly platform?: 'darwin' | 'linux';
  readonly providerSourceHome?: string;
  readonly workspaceBookmark?: LocalWorkerWorkspaceBookmarkPort;
}

export interface InstalledLocalWorkerConfiguration {
  readonly configFile: string;
  readonly privateRoot: string;
  readonly workerConfigId: string;
  readonly config: LocalWorkerHeadlessConfig;
}

function assertOwnedDirectory(path: string, field: string, exactMode?: number): void {
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path) {
    throw new Error(`${field} must be one canonical absolute directory`);
  }
  const stat = lstatSync(path);
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== null && stat.uid !== uid)) {
    throw new Error(`${field} ownership is invalid`);
  }
  const mode = stat.mode & 0o777;
  if (exactMode === undefined ? (mode & 0o002) !== 0 : mode !== exactMode) {
    throw new Error(`${field} mode is invalid`);
  }
}

function workerConfigId(instanceId: string, workerId: string): string {
  return `worker-${createHash('sha256')
    .update(instanceId)
    .update('\0')
    .update(workerId)
    .digest('hex')
    .slice(0, 24)}`;
}

function writePrivateFile(path: string, text: string): void {
  const bytes = Buffer.from(text, 'utf8');
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    let offset = 0;
    while (offset < bytes.byteLength) offset += writeSync(descriptor, bytes, offset);
    fsyncSync(descriptor);
    const stat = statSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
      throw new Error('Worker private file post-write verification failed');
    }
  } finally {
    bytes.fill(0);
    if (descriptor !== null) closeSync(descriptor);
  }
}

function assertTrustedExecutable(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path) {
    throw new Error('Worker 工作区授权程序路径无效');
  }
  const stat = lstatSync(path);
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (
    !stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0 ||
    (stat.mode & 0o022) !== 0 || (uid !== null && stat.uid !== uid && stat.uid !== 0)
  ) {
    throw new Error('Worker 工作区授权程序不可信');
  }
}

export function createDarwinWorkspaceBookmarkPort(
  executable: string,
): LocalWorkerWorkspaceBookmarkPort {
  assertTrustedExecutable(executable);
  return Object.freeze({
    create(workspaceRoot, bookmarkFile): Promise<void> {
      return new Promise<void>((resolveCreate, rejectCreate) => {
        execFile(executable, ['create', workspaceRoot, bookmarkFile], {
          env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
          maxBuffer: 64 * 1024,
          shell: false,
          timeout: BOOKMARK_TIMEOUT_MS,
          killSignal: 'SIGKILL',
        }, (error, stdout, stderr) => {
          if (error || stdout.length > 0 || stderr.length > 0) {
            rejectCreate(new Error('Worker 工作区授权创建失败'));
          } else {
            resolveCreate();
          }
        });
      });
    },
  });
}

function assertPrivateBookmark(path: string): void {
  const stat = lstatSync(path);
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (
    !stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path ||
    (stat.mode & 0o777) !== 0o600 || (uid !== null && stat.uid !== uid) ||
    stat.size < 1 || stat.size > MAX_BOOKMARK_BYTES
  ) {
    throw new Error('Worker 工作区授权文件无效');
  }
}

function createPrivateDirectory(path: string): void {
  mkdirSync(path, { mode: 0o700 });
  assertOwnedDirectory(path, `Worker private directory ${basename(path)}`, 0o700);
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

export async function configureLocalWorker(
  input: ConfigureLocalWorkerInput,
): Promise<InstalledLocalWorkerConfiguration> {
  const platform = input.platform ?? process.platform;
  if (platform !== 'darwin' && platform !== 'linux') {
    throw new Error('Local Worker 当前仅支持 macOS 和 Linux');
  }
  if (Buffer.byteLength(input.appVersion, 'utf8') < 1 ||
      Buffer.byteLength(input.appVersion, 'utf8') > MAX_APP_VERSION_BYTES) {
    throw new Error('appVersion is invalid');
  }
  if (!isJsonObject(input.runtimeOptions ?? {})) throw new Error('runtimeOptions must be JSON');
  assertOwnedDirectory(input.stateRoot, 'Worker state root', 0o700);
  assertOwnedDirectory(input.workspaceRoot, 'Worker workspace root');
  const workspaceRoot = realpathSync(input.workspaceRoot);
  const runtimeOptions = input.runtimeOptions ?? {};
  const credentialSource = readTrustedTextFile(input.credentialFile);
  if (credentialSource.mode !== 0o600) throw new Error('Worker credential file must be mode 0600');
  const credential = parseRemoteConnectionCredential(JSON.parse(credentialSource.text));
  if (!isRemoteConnectionWorkerCredential(credential)) {
    throw new Error('该文件不是 Worker 凭证；Client 凭证只能导入 Electron');
  }
  const id = workerConfigId(credential.instanceId, credential.workerId);
  const privateRoot = join(input.stateRoot, id);
  if (statSync(privateRoot, { throwIfNoEntry: false }) !== undefined) {
    throw new Error('Worker 配置已存在；请先停止并移除旧配置');
  }
  const sshRoot = join(privateRoot, 'ssh');
  const environment = {
    coreConfigRoot: join(privateRoot, 'core-config'),
    coreRuntimeRoot: join(privateRoot, 'core-runtime'),
    coreStateRoot: join(privateRoot, 'core-state'),
    providerCacheRoot: join(privateRoot, 'provider-cache'),
    providerHomeRoot: join(privateRoot, 'provider-home'),
    providerTempRoot: join(privateRoot, 'provider-tmp'),
  };
  const identityFile = join(sshRoot, 'id_ed25519');
  const knownHostsFile = join(sshRoot, 'known_hosts');
  const configFile = join(privateRoot, WORKER_CONFIG_FILE);
  try {
    createPrivateDirectory(privateRoot);
    createPrivateDirectory(sshRoot);
    for (const path of Object.values(environment)) createPrivateDirectory(path);
    if (input.providerSourceHome) {
      projectLocalWorkerProviderHome(input.providerSourceHome, environment.providerHomeRoot);
    }
    if (platform === 'darwin') {
      if (!input.workspaceBookmark) throw new Error('macOS Worker 缺少工作区授权程序');
      const bookmarkFile = join(privateRoot, DARWIN_WORKSPACE_BOOKMARK_FILE);
      await input.workspaceBookmark.create(workspaceRoot, bookmarkFile);
      assertPrivateBookmark(bookmarkFile);
    }
    const workspaceSandbox = parseWorkspaceSandboxSpec({
      schemaVersion: 1,
      execution: 'relay-worker',
      workerConfigId: id,
      workerId: credential.workerId,
      workspaceRoot,
      privateRoot,
      runtimeReadRoots: input.runtimeReadRoots,
      environment,
      networkBoundary: 'provider-controlled',
    });
    writePrivateFile(
      identityFile,
      credential.identity.privateKey.endsWith('\n')
        ? credential.identity.privateKey
        : `${credential.identity.privateKey}\n`,
    );
    writePrivateFile(knownHostsFile, renderRemoteConnectionKnownHosts(credential));
    const config = parseLocalWorkerHeadlessConfig({
      schemaVersion: 2,
      instanceId: credential.instanceId,
      appVersion: input.appVersion,
      runtimeModule: input.runtimeModule,
      runtimeOptions,
      generationFile: join(privateRoot, 'generation.json'),
      ssh: {
        sshBinary: input.sshBinary,
        host: credential.endpoint.hostname,
        port: credential.endpoint.port,
        user: credential.endpoint.username,
        identityFile,
        knownHostsFile,
        instanceId: credential.instanceId,
        workerId: credential.workerId,
        credentialId: credential.credentialId,
        connectTimeoutSeconds: input.connectTimeoutSeconds ?? 15,
      },
      workspaceSandbox,
    });
    const encoded = Buffer.from(`${JSON.stringify(config, null, 2)}\n`, 'utf8');
    try {
      await new AtomicPrivateStateFile(configFile, 1024 * 1024).write(encoded);
    } finally {
      encoded.fill(0);
    }
    syncDirectory(privateRoot);
    return Object.freeze({ configFile, privateRoot, workerConfigId: id, config });
  } catch (error) {
    if (dirname(privateRoot) === input.stateRoot && basename(privateRoot) === id) {
      rmSync(privateRoot, { recursive: true, force: true });
    }
    throw error;
  }
}
