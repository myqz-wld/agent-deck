#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PLATFORM_SPECS = {
  'darwin-arm64': {
    packageName: '@xai-official/grok-darwin-arm64',
    binaryName: 'grok',
  },
  'darwin-x64': {
    packageName: '@xai-official/grok-darwin-x64',
    binaryName: 'grok',
  },
  'linux-arm64': {
    packageName: '@xai-official/grok-linux-arm64',
    binaryName: 'grok',
  },
  'linux-x64': {
    packageName: '@xai-official/grok-linux-x64',
    binaryName: 'grok',
  },
  'win32-arm64': {
    packageName: '@xai-official/grok-win32-arm64',
    binaryName: 'grok.exe',
  },
  'win32-x64': {
    packageName: '@xai-official/grok-win32-x64',
    binaryName: 'grok.exe',
  },
};

const defaultProjectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function parseCliArgs(argv) {
  let projectRoot = defaultProjectRoot;
  let targetPlatform = process.platform;
  let targetArch = process.arch;

  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value) {
      throw new Error(
        'Usage: node scripts/verify-bundled-grok.mjs ' +
          '[--project-root <path>] [--target-platform <platform>] ' +
          '[--target-arch <arch>]',
      );
    }
    if (flag === '--project-root') {
      projectRoot = resolve(value);
    } else if (flag === '--target-platform') {
      targetPlatform = value;
    } else if (flag === '--target-arch') {
      targetArch = value;
    } else {
      throw new Error(
        'Usage: node scripts/verify-bundled-grok.mjs ' +
          '[--project-root <path>] [--target-platform <platform>] ' +
          '[--target-arch <arch>]',
      );
    }
  }

  return { projectRoot, targetPlatform, targetArch };
}

export function assertNativePackagingTarget({
  targetPlatform,
  targetArch,
  hostPlatform = process.platform,
  hostArch = process.arch,
}) {
  if (targetPlatform === hostPlatform && targetArch === hostArch) return;
  throw new Error(
    `[bundled-grok] Native-only packaging target ${targetPlatform}-${targetArch} ` +
      `does not match host ${hostPlatform}-${hostArch}. ` +
      'Run the target-specific dist command on its matching host.',
  );
}

function resolvePackageJson(requireFromProject, packageName) {
  try {
    return requireFromProject.resolve(`${packageName}/package.json`);
  } catch {
    return null;
  }
}

async function readPackageJson(packageJsonPath) {
  return JSON.parse(await readFile(packageJsonPath, 'utf8'));
}

async function isNonEmptyFile(filePath) {
  try {
    const details = await stat(filePath);
    return details.isFile() && details.size > 0;
  } catch {
    return false;
  }
}

export async function verifyBundledGrok({
  projectRoot = defaultProjectRoot,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const platformKey = `${platform}-${arch}`;
  const spec = PLATFORM_SPECS[platformKey];
  if (!spec) {
    throw new Error(
      `[bundled-grok] Unsupported packaging platform ${platformKey}. ` +
        'Configure an external Grok binary for this target.',
    );
  }

  const requireFromProject = createRequire(join(resolve(projectRoot), 'package.json'));
  const grokPackageJsonPath = resolvePackageJson(
    requireFromProject,
    '@xai-official/grok',
  );
  if (!grokPackageJsonPath) {
    throw new Error(
      '[bundled-grok] @xai-official/grok is missing. Run pnpm install before packaging.',
    );
  }

  const requireFromGrok = createRequire(grokPackageJsonPath);
  const platformPackageJsonPath =
    resolvePackageJson(requireFromProject, spec.packageName) ??
    resolvePackageJson(requireFromGrok, spec.packageName);
  if (!platformPackageJsonPath) {
    throw new Error(
      `[bundled-grok] ${spec.packageName} is missing for ${platformKey}. ` +
        'Run pnpm install on the target platform before packaging.',
    );
  }

  const [grokPackage, platformPackage] = await Promise.all([
    readPackageJson(grokPackageJsonPath),
    readPackageJson(platformPackageJsonPath),
  ]);
  if (
    typeof grokPackage.version !== 'string' ||
    platformPackage.version !== grokPackage.version
  ) {
    throw new Error(
      `[bundled-grok] Package version mismatch: @xai-official/grok is ` +
        `${String(grokPackage.version)}, but ${spec.packageName} is ` +
        `${String(platformPackage.version)}. Run pnpm install before packaging.`,
    );
  }

  const binaryPath = join(dirname(platformPackageJsonPath), 'bin', spec.binaryName);
  const compressedPath = `${binaryPath}.br`;
  const [hasBinary, hasCompressedPayload] = await Promise.all([
    isNonEmptyFile(binaryPath),
    isNonEmptyFile(compressedPath),
  ]);
  if (!hasBinary && !hasCompressedPayload) {
    throw new Error(
      `[bundled-grok] ${spec.packageName} contains neither a usable ` +
        `${spec.binaryName} nor ${spec.binaryName}.br payload. Run pnpm install before packaging.`,
    );
  }

  return {
    platformKey,
    packageName: spec.packageName,
    version: grokPackage.version,
    payloadPath: hasBinary ? binaryPath : compressedPath,
  };
}

async function main() {
  const { projectRoot, targetPlatform, targetArch } = parseCliArgs(
    process.argv.slice(2),
  );
  assertNativePackagingTarget({ targetPlatform, targetArch });
  const result = await verifyBundledGrok({
    projectRoot,
    platform: targetPlatform,
    arch: targetArch,
  });
  console.log(
    `[bundled-grok] verified ${result.packageName}@${result.version} ` +
      `for ${result.platformKey}`,
  );
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (entryPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
