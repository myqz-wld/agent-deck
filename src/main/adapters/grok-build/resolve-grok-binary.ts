import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { constants, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';

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

function cacheRoot(): string {
  return process.env.AGENT_DECK_GROK_CACHE_DIR?.trim() || join(tmpdir(), 'agent-deck-grok');
}

async function isUsableFile(filePath: string): Promise<boolean> {
  try {
    const file = await stat(filePath);
    if (!file.isFile() || file.size === 0) return false;
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function materializeBundledBinary(
  packageDir: string,
  spec: GrokPlatformSpec,
): Promise<string> {
  const sourcePath = join(packageDir, 'bin', spec.binaryName);
  if (await isUsableFile(sourcePath)) return sourcePath;

  const compressedPath = `${sourcePath}.br`;
  try {
    await access(compressedPath);
  } catch {
    throw new Error(
      `Bundled Grok binary was not found for ${process.platform}-${process.arch}. ` +
        'Reinstall Agent Deck dependencies or choose an external absolute path.',
    );
  }

  const destination = join(
    cacheRoot(),
    `${resolveGrokVersion()}-${process.platform}-${process.arch}`,
    spec.binaryName,
  );
  if (await isUsableFile(destination)) return destination;

  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporaryPath = `${destination}.tmp-${process.pid}-${Date.now()}`;
  try {
    const compressed = await readFile(compressedPath);
    await writeFile(temporaryPath, brotliDecompressSync(compressed), { mode: 0o700 });
    if (process.platform !== 'win32') await chmod(temporaryPath, 0o755);
    try {
      await rename(temporaryPath, destination);
    } catch {
      if (!(await isUsableFile(destination))) {
        throw new Error('Unable to cache bundled Grok binary.');
      }
    }
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
  return destination;
}

async function resolveBundledGrokBinary(): Promise<string> {
  const spec = currentPlatformSpec();
  if (!spec) {
    throw new Error(
      `Bundled Grok CLI is unavailable for ${process.platform}-${process.arch}; ` +
        'choose an external absolute path.',
    );
  }
  const packageDir = resolvePlatformPackageDir(spec);
  if (!packageDir) {
    throw new Error(
      `Bundled Grok CLI package ${spec.packageName} is not installed. ` +
        'Reinstall Agent Deck dependencies or choose an external absolute path.',
    );
  }
  return materializeBundledBinary(packageDir, spec);
}

export async function resolveGrokBinary(configuredPath: string | null): Promise<string> {
  const candidate = configuredPath?.trim();
  if (candidate) {
    if (!isAbsolute(candidate)) {
      throw new Error(
        'Grok binary path must be absolute, or leave it empty to use the bundled CLI.',
      );
    }
    try {
      await access(candidate);
    } catch {
      throw new Error(`Grok binary was not found at ${candidate}.`);
    }
    return candidate;
  }
  return resolveBundledGrokBinary();
}
