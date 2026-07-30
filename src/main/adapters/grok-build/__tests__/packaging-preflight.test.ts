import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const scriptPath = resolve('scripts/verify-bundled-grok.mjs');

function platformSpec(): { packageName: string; binaryName: string } {
  const specs: Record<string, { packageName: string; binaryName: string }> = {
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
  const spec = specs[`${process.platform}-${process.arch}`];
  if (!spec) throw new Error('Unsupported test platform');
  return spec;
}

function runPreflight(projectRoot: string, extraArgs: string[] = []) {
  return spawnSync(
    process.execPath,
    [scriptPath, '--project-root', projectRoot, ...extraArgs],
    {
      encoding: 'utf8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    },
  );
}

async function writePackage(
  projectRoot: string,
  packageName: string,
  packageJson: object,
): Promise<string> {
  const packageDir = join(projectRoot, 'node_modules', ...packageName.split('/'));
  await mkdir(packageDir, { recursive: true });
  await writeFile(join(packageDir, 'package.json'), JSON.stringify(packageJson));
  return packageDir;
}

async function writeProjectPackage(
  projectRoot: string,
  grokRange = '^1.2.3',
): Promise<void> {
  await writeFile(
    join(projectRoot, 'package.json'),
    JSON.stringify({
      private: true,
      dependencies: { '@xai-official/grok': grokRange },
    }),
  );
}

describe('bundled Grok packaging preflight', () => {
  it('accepts matching platform assets with a non-empty compressed payload', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'agent-deck-grok-preflight-'));
    await writeProjectPackage(projectRoot);
    const spec = platformSpec();
    await writePackage(projectRoot, '@xai-official/grok', {
      name: '@xai-official/grok',
      version: '1.2.3',
    });
    const platformDir = await writePackage(projectRoot, spec.packageName, {
      name: spec.packageName,
      version: '1.2.3',
    });
    const payloadPath = join(platformDir, 'bin', `${spec.binaryName}.br`);
    await mkdir(dirname(payloadPath), { recursive: true });
    await writeFile(payloadPath, 'compressed-grok');

    const result = runPreflight(projectRoot);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`verified ${spec.packageName}@1.2.3`);
  });

  it('fails before packaging when the Grok dependency is absent', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'agent-deck-grok-preflight-'));
    await writeProjectPackage(projectRoot);

    const result = runPreflight(projectRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('@xai-official/grok is missing');
    expect(result.stderr).toContain('pnpm install');
  });

  it('rejects stale installed packages that do not satisfy package.json', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'agent-deck-grok-preflight-'));
    await writeProjectPackage(projectRoot, '^1.3.0');
    const spec = platformSpec();
    await writePackage(projectRoot, '@xai-official/grok', {
      name: '@xai-official/grok',
      version: '1.2.3',
    });
    const platformDir = await writePackage(projectRoot, spec.packageName, {
      name: spec.packageName,
      version: '1.2.3',
    });
    const payloadPath = join(platformDir, 'bin', `${spec.binaryName}.br`);
    await mkdir(dirname(payloadPath), { recursive: true });
    await writeFile(payloadPath, 'compressed-grok');

    const result = runPreflight(projectRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Installed @xai-official/grok 1.2.3 does not satisfy package.json dependency ^1.3.0',
    );
    expect(result.stderr).toContain('pnpm install');
  });

  it('rejects a packaging target that does not match the host OS', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'agent-deck-grok-preflight-'));
    await writeFile(join(projectRoot, 'package.json'), '{"private":true}');
    const foreignPlatform = process.platform === 'darwin' ? 'win32' : 'darwin';

    const result = runPreflight(projectRoot, [
      '--target-platform',
      foreignPlatform,
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `Native-only packaging target ${foreignPlatform}-${process.arch} does not match host ` +
        `${process.platform}-${process.arch}`,
    );
    expect(result.stderr).toContain('Run the target-specific dist command on its matching host');
    expect(result.stderr).not.toContain(projectRoot);
  });

  it('rejects a packaging target that does not match the host architecture', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'agent-deck-grok-preflight-'));
    await writeFile(join(projectRoot, 'package.json'), '{"private":true}');
    const foreignArch = process.arch === 'arm64' ? 'x64' : 'arm64';

    const result = runPreflight(projectRoot, [
      '--target-arch',
      foreignArch,
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `Native-only packaging target ${process.platform}-${foreignArch} does not match host ` +
        `${process.platform}-${process.arch}`,
    );
    expect(result.stderr).not.toContain(projectRoot);
  });

  it('pins every target-specific dist command to its matching native OS', async () => {
    const packageJson = JSON.parse(
      await readFile(resolve('package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };

    expect(packageJson.scripts['dist:mac']).toContain(
      'verify-bundled-grok.mjs --target-platform darwin',
    );
    expect(packageJson.scripts['dist:win']).toContain(
      'verify-bundled-grok.mjs --target-platform win32',
    );
    expect(packageJson.scripts['dist:linux']).toContain(
      'verify-bundled-grok.mjs --target-platform linux',
    );
  });
});
