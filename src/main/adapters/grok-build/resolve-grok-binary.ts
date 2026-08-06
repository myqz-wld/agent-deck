import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  access,
  lstat,
  mkdir,
  open,
  rename,
  unlink,
} from 'node:fs/promises';
import { constants, readFileSync, type Stats } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import {
  getApplicationHostPaths,
  type ApplicationHostPaths,
} from '@main/runtime-host/application-paths';

type GrokPlatformSpec = {
  packageName: string;
  binaryName: string;
};

const requireFromHere = createRequire(__filename);

const GROK_PLATFORM_SPECS: Record<string, GrokPlatformSpec> = {
  'darwin-arm64': { packageName: '@xai-official/grok-darwin-arm64', binaryName: 'grok' },
  'darwin-x64': { packageName: '@xai-official/grok-darwin-x64', binaryName: 'grok' },
  'linux-arm64': { packageName: '@xai-official/grok-linux-arm64', binaryName: 'grok' },
  'linux-x64': { packageName: '@xai-official/grok-linux-x64', binaryName: 'grok' },
  'win32-arm64': { packageName: '@xai-official/grok-win32-arm64', binaryName: 'grok.exe' },
  'win32-x64': { packageName: '@xai-official/grok-win32-x64', binaryName: 'grok.exe' },
};

function currentPlatformSpec(): GrokPlatformSpec | undefined {
  return GROK_PLATFORM_SPECS[`${process.platform}-${process.arch}`];
}

function unpackAsarPath(filePath: string): string {
  return filePath.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
}

function resolvePlatformPackageDir(spec: GrokPlatformSpec): string | null {
  try {
    const packageJsonPath = requireFromHere.resolve(`${spec.packageName}/package.json`);
    return dirname(unpackAsarPath(packageJsonPath));
  } catch {
    try {
      const grokPackageJsonPath = requireFromHere.resolve('@xai-official/grok/package.json');
      const requireFromGrok = createRequire(grokPackageJsonPath);
      const packageJsonPath = requireFromGrok.resolve(`${spec.packageName}/package.json`);
      return dirname(unpackAsarPath(packageJsonPath));
    } catch {
      return null;
    }
  }
}

function resolveGrokVersion(): string {
  try {
    const packageJsonPath = requireFromHere.resolve('@xai-official/grok/package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      version?: unknown;
    };
    return typeof packageJson.version === 'string' ? packageJson.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

export function resolveGrokBinaryCacheRoot(
  paths: Pick<ApplicationHostPaths, 'userDataPath'>,
  configuredOverride: string | undefined,
): string {
  const override = configuredOverride?.trim();
  return override
    ? resolve(override)
    : join(paths.userDataPath, 'grok-binary-cache');
}

function cacheRoot(): string {
  return resolveGrokBinaryCacheRoot(
    getApplicationHostPaths(),
    process.env.AGENT_DECK_GROK_CACHE_DIR,
  );
}

function currentUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function sameSnapshot(left: Stats, right: Stats): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

async function readRegularFileNoFollow(filePath: string, expected: Stats): Promise<Buffer> {
  const handle = await open(
    filePath,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameSnapshot(expected, opened)) {
      throw new Error(`${filePath} changed while it was being opened.`);
    }
    const contents = await handle.readFile();
    const afterRead = await handle.stat();
    if (!sameSnapshot(opened, afterRead)) {
      throw new Error(`${filePath} changed while it was being read.`);
    }
    return contents;
  } finally {
    await handle.close();
  }
}

async function isUsableBundledExecutable(filePath: string): Promise<boolean> {
  try {
    const file = await lstat(filePath);
    if (file.isSymbolicLink() || !file.isFile() || file.size === 0) return false;
    if (process.platform !== 'win32' && (file.mode & 0o022) !== 0) return false;
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface GrokBinaryMaterializationOptions {
  compressedPath: string;
  cacheRoot: string;
  cacheKey: string;
  binaryName: string;
  platform?: NodeJS.Platform;
  uid?: number | null;
}

/** Materialize one trusted bundled .br payload into an app-owned executable cache. */
export async function materializeCompressedGrokBinary(
  options: GrokBinaryMaterializationOptions,
): Promise<string> {
  const platform = options.platform ?? process.platform;
  const uid = options.uid === undefined ? currentUid() : options.uid;
  const root = resolve(options.cacheRoot);
  if (basename(options.binaryName) !== options.binaryName) {
    throw new Error('内置 Grok Build 二进制文件名无效。');
  }
  const versionDirectory = join(root, safeCacheSegment(options.cacheKey));
  const destination = join(versionDirectory, options.binaryName);
  const compressedStat = await lstat(options.compressedPath);
  if (
    compressedStat.isSymbolicLink() ||
    !compressedStat.isFile() ||
    compressedStat.size === 0
  ) {
    throw new Error('内置 Grok Build 压缩载荷不是可信的常规文件。');
  }
  const expected = brotliDecompressSync(
    await readRegularFileNoFollow(options.compressedPath, compressedStat),
  );
  if (expected.length === 0) {
    throw new Error('内置 Grok Build 压缩载荷解压后为空。');
  }

  await ensureSecureDirectory(root, root, platform, uid);
  await ensureSecureDirectory(versionDirectory, root, platform, uid);
  if (await cachedFileMatches(destination, expected, platform, uid)) return destination;

  const staging = await createVerifiedStagingFile(
    versionDirectory,
    options.binaryName,
    expected,
    platform,
    uid,
  );
  try {
    await publishStagingFile(staging, destination, expected, platform, uid);
    if (!(await cachedFileMatchesAfterPublication(destination, expected, platform, uid))) {
      throw new Error('内置 Grok Build 二进制文件发布后校验失败。');
    }
    return destination;
  } finally {
    await unlink(staging).catch(() => undefined);
  }
}

async function materializeBundledBinary(
  packageDir: string,
  spec: GrokPlatformSpec,
): Promise<string> {
  const sourcePath = join(packageDir, 'bin', spec.binaryName);
  if (await isUsableBundledExecutable(sourcePath)) return sourcePath;

  const compressedPath = `${sourcePath}.br`;
  try {
    await lstat(compressedPath);
  } catch {
    throw new Error(
      `未找到适用于 ${process.platform}-${process.arch} 的内置 Grok Build 二进制文件。` +
        '请重新安装 Agent Deck 依赖，或选择外部绝对路径。',
    );
  }

  return materializeCompressedGrokBinary({
    compressedPath,
    cacheRoot: cacheRoot(),
    cacheKey: `${resolveGrokVersion()}-${process.platform}-${process.arch}`,
    binaryName: spec.binaryName,
  });
}

function safeCacheSegment(value: string): string {
  const segment = value.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 160);
  return !segment || segment === '.' || segment === '..' ? 'unknown' : segment;
}

async function ensureSecureDirectory(
  directory: string,
  cacheRoot: string,
  platform: NodeJS.Platform,
  uid: number | null,
): Promise<void> {
  const pathRoot = parse(directory).root;
  const segments = relative(pathRoot, directory).split(sep).filter(Boolean);
  let currentPath = pathRoot;
  assertSecureCacheAncestor(
    currentPath,
    await lstat(currentPath),
    cacheRoot,
    platform,
    uid,
  );
  for (const segment of segments) {
    currentPath = join(currentPath, segment);
    let current: Stats;
    try {
      current = await lstat(currentPath);
    } catch (error) {
      if (!isMissing(error)) throw error;
      try {
        await mkdir(currentPath, { mode: 0o700 });
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException)?.code !== 'EEXIST') throw mkdirError;
      }
      current = await lstat(currentPath);
    }
    assertSecureCacheAncestor(currentPath, current, cacheRoot, platform, uid);
  }
}

function assertSecureCacheAncestor(
  directory: string,
  current: Stats,
  cacheRoot: string,
  platform: NodeJS.Platform,
  uid: number | null,
): void {
  if (current.isSymbolicLink() || !current.isDirectory()) {
    throw new Error(`Grok Build 缓存目录不安全：${directory}`);
  }
  if (platform === 'win32') return;
  const insideCache = directory === cacheRoot || directory.startsWith(`${cacheRoot}${sep}`);
  if (uid !== null) {
    const expectedOwner = insideCache ? current.uid === uid : current.uid === uid || current.uid === 0;
    if (!expectedOwner) throw new Error(`Grok Build 缓存目录不属于可信用户：${directory}`);
  }
  if ((current.mode & 0o022) !== 0) {
    throw new Error(`Grok Build 缓存目录允许组或其他用户写入：${directory}`);
  }
}

async function cachedFileMatches(
  filePath: string,
  expected: Buffer,
  platform: NodeJS.Platform,
  uid: number | null,
): Promise<boolean> {
  try {
    const current = await lstat(filePath);
    if (current.isSymbolicLink() || !current.isFile() || current.size !== expected.length) {
      return false;
    }
    if (platform !== 'win32') {
      if (uid !== null && current.uid !== uid) return false;
      if ((current.mode & 0o022) !== 0 || (current.mode & 0o100) === 0) return false;
    }
    const contents = await readRegularFileNoFollow(filePath, current);
    return contents.length === expected.length && timingSafeEqual(contents, expected);
  } catch {
    return false;
  }
}

async function createVerifiedStagingFile(
  directory: string,
  binaryName: string,
  expected: Buffer,
  platform: NodeJS.Platform,
  uid: number | null,
): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const staging = join(
      directory,
      `.${binaryName}.stage-${process.pid}-${randomBytes(12).toString('hex')}`,
    );
    try {
      const handle = await open(
        staging,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          (constants.O_NOFOLLOW ?? 0),
        0o700,
      );
      try {
        await handle.writeFile(expected);
        if (platform !== 'win32') await handle.chmod(0o700);
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (!(await cachedFileMatches(staging, expected, platform, uid))) {
        throw new Error('内置 Grok Build 二进制文件暂存校验失败。');
      }
      return staging;
    } catch (error) {
      await unlink(staging).catch(() => undefined);
      if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') continue;
      throw error;
    }
  }
  throw new Error('无法创建唯一的 Grok Build 二进制文件暂存路径。');
}

async function publishStagingFile(
  staging: string,
  destination: string,
  expected: Buffer,
  platform: NodeJS.Platform,
  uid: number | null,
): Promise<void> {
  if (await cachedFileMatches(destination, expected, platform, uid)) return;
  try {
    await rename(staging, destination);
    return;
  } catch (firstError) {
    if (await cachedFileMatches(destination, expected, platform, uid)) return;
    let destinationStat: Stats | null = null;
    try {
      destinationStat = await lstat(destination);
    } catch (error) {
      if (!isMissing(error)) throw firstError;
    }
    if (destinationStat) {
      if (!destinationStat.isFile() && !destinationStat.isSymbolicLink()) throw firstError;
      await unlink(destination);
    }
    try {
      await rename(staging, destination);
    } catch (secondError) {
      if (!(await cachedFileMatches(destination, expected, platform, uid))) throw secondError;
    }
  }
}

async function cachedFileMatchesAfterPublication(
  destination: string,
  expected: Buffer,
  platform: NodeJS.Platform,
  uid: number | null,
): Promise<boolean> {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    if (await cachedFileMatches(destination, expected, platform, uid)) return true;
    await new Promise<void>((resolveAttempt) => setImmediate(resolveAttempt));
  }
  return false;
}

async function resolveBundledGrokBinary(): Promise<string> {
  const spec = currentPlatformSpec();
  if (!spec) {
    throw new Error(
      `内置 Grok Build CLI 不支持 ${process.platform}-${process.arch}；` +
        '请选择外部绝对路径。',
    );
  }
  const packageDir = resolvePlatformPackageDir(spec);
  if (!packageDir) {
    throw new Error(
      `未安装内置 Grok Build CLI 包 ${spec.packageName}。` +
        '请重新安装 Agent Deck 依赖，或选择外部绝对路径。',
    );
  }
  return materializeBundledBinary(packageDir, spec);
}

export async function resolveGrokBinary(configuredPath: string | null): Promise<string> {
  const candidate = configuredPath?.trim();
  if (candidate) {
    if (!isAbsolute(candidate)) {
      throw new Error(
        'Grok Build 二进制路径必须是绝对路径；留空则使用内置 CLI。',
      );
    }
    try {
      await access(candidate);
    } catch {
      throw new Error(`在 ${candidate} 找不到 Grok Build 二进制文件。`);
    }
    return candidate;
  }
  return resolveBundledGrokBinary();
}
