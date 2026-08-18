import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { validateCurrentLinuxPackageManifests } from '../check-linux-headless-support.mjs';
import { parseVerification } from './server.mjs';

const repoRoot = resolve(import.meta.dirname, '../..');

describe('current deployment bridge contracts', () => {
  it('allows only manager commands produced by the current server deployment module', async () => {
    const [server, bridge] = await Promise.all([
      readFile(resolve(repoRoot, 'scripts/deployment/server.mjs'), 'utf8'),
      readFile(resolve(repoRoot, 'scripts/deployment/remote-manager.sh'), 'utf8'),
    ]);
    const produced = [...server.matchAll(/runManager\(config, '([^']+)'/gu)]
      .map((match) => match[1]);
    const allowlist = /^  ([a-z|-]+)\) ;;$/mu.exec(bridge)?.[1].split('|') ?? [];
    expect([...new Set(allowlist)].sort()).toEqual([...new Set(produced)].sort());
  });

  it('rejects release archive files outside the current producer manifest', async () => {
    const installer = await readFile(
      resolve(repoRoot, 'scripts/deployment/remote-install.sh'),
      'utf8',
    );
    expect(installer).toContain('for architecture in amd64 arm64');
    expect(installer).toContain('actual_manifest=');
    expect(installer).toContain('release archive 包含缺失、多余或非当前布局的文件');
    expect(installer).toContain('actual_runtime_manifest=');
    expect(installer).toContain('validate_runtime_tree "$runtime_target"');
  });

  it('accepts only the current verification result bound to the requested instance', () => {
    const image = `registry.example.test/relay@sha256:${'a'.repeat(64)}`;
    const config = { topology: 'relay', instance: { id: 'relay-a' } };
    expect(parseVerification(
      `VERIFY_OK topology=relay instance=relay-a image=${image} health=healthy feishuRuntime=ready\n`,
      config,
      image,
    )).toContain('topology=relay instance=relay-a');
    expect(() => parseVerification(`VERIFY_OK image=${image}\n`, config, image)).toThrow(
      /无效或不匹配的当前结果/,
    );
    expect(() => parseVerification(
      `VERIFY_OK topology=relay instance=relay-b image=${image} health=healthy feishuRuntime=ready\n`,
      config,
      image,
    )).toThrow(/无效或不匹配的当前结果/);
  });

  it('rejects non-current Linux build manifest schemas and fields', () => {
    const current = {
      schemaVersion: 1,
      runtime: 'node',
      target: 'node22',
      entries: {},
      nativeExternals: ['better-sqlite3'],
    };
    const currentPackage = {
      ...current,
      forcedCommandSshdPolicy: {},
      hostRequirements: {},
      installMapping: {},
      instanceManagerKind: 'host-only-command',
      relayArtifactMustExclude: [],
      serverControlKind: 'root-only-command',
    };
    expect(() => validateCurrentLinuxPackageManifests(
      currentPackage,
      current,
    )).not.toThrow();
    expect(() => validateCurrentLinuxPackageManifests(
      { ...currentPackage, schemaVersion: 0 },
      current,
    )).toThrow(/schemaVersion 1/);
    expect(() => validateCurrentLinuxPackageManifests(
      currentPackage,
      { ...current, retiredLayout: true },
    )).toThrow(/non-current fields/);
    expect(() => validateCurrentLinuxPackageManifests(
      { ...currentPackage, target: 'node20' },
      current,
    )).toThrow(/current Node 22/);
  });
});
