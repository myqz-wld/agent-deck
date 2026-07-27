import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
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

function runPreflight(projectRoot: string) {
  return spawnSync(
    process.execPath,
    [scriptPath, '--project-root', projectRoot],
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

describe('bundled Grok packaging preflight', () => {
  it('accepts matching platform assets with a non-empty compressed payload', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'agent-deck-grok-preflight-'));
    await writeFile(join(projectRoot, 'package.json'), '{"private":true}');
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
    await writeFile(join(projectRoot, 'package.json'), '{"private":true}');

    const result = runPreflight(projectRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('@xai-official/grok is missing');
    expect(result.stderr).toContain('pnpm install');
  });
});
