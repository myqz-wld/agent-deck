import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BUILD_INFO_MAX_BYTES,
  createProcessStartupRecord,
  getProcessRunId,
  loadBuildIdentity,
} from '../run-context';

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-run-context-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('loadBuildIdentity', () => {
  it('loads the explicit development build-info path and keeps only validated bounded fields', () => {
    const appPath = tempRoot();
    fs.mkdirSync(path.join(appPath, 'build'), { recursive: true });
    fs.writeFileSync(path.join(appPath, 'build', 'build-info.json'), JSON.stringify({
      name: 'agent-deck',
      version: '1.2.3',
      commit: 'a'.repeat(40),
      shortCommit: 'abcdef123456',
      branch: 'feature/private-branch',
      dirty: true,
      builtAt: '2026-07-28T12:34:56.000Z',
      prompt: 'must never escape the loader',
    }));

    expect(loadBuildIdentity({
      isPackaged: false,
      appPath,
      resourcesPath: path.join(appPath, 'unused-resources'),
    })).toEqual({
      status: 'ok',
      shortCommit: 'abcdef123456',
      builtAt: '2026-07-28T12:34:56.000Z',
      dirty: true,
    });
  });

  it('uses the packaged resources path instead of the development path', () => {
    const root = tempRoot();
    const appPath = path.join(root, 'app');
    const resourcesPath = path.join(root, 'resources');
    fs.mkdirSync(resourcesPath, { recursive: true });
    fs.writeFileSync(path.join(resourcesPath, 'build-info.json'), JSON.stringify({
      shortCommit: '1234567abcde',
      dirty: false,
      builtAt: '2026-07-28T12:34:56.000Z',
    }));

    expect(loadBuildIdentity({ isPackaged: true, appPath, resourcesPath })).toMatchObject({
      status: 'ok',
      shortCommit: '1234567abcde',
      dirty: false,
    });
  });

  it('reports compact truthful missing, invalid, and oversize statuses without raw data', () => {
    const missingRoot = tempRoot();
    expect(loadBuildIdentity({
      isPackaged: false,
      appPath: missingRoot,
      resourcesPath: missingRoot,
    })).toEqual({
      status: 'missing',
      shortCommit: null,
      builtAt: null,
      dirty: null,
    });

    const invalidRoot = tempRoot();
    fs.mkdirSync(path.join(invalidRoot, 'build'), { recursive: true });
    fs.writeFileSync(
      path.join(invalidRoot, 'build', 'build-info.json'),
      '{"prompt":"provider-secret","shortCommit":',
    );
    const invalid = loadBuildIdentity({
      isPackaged: false,
      appPath: invalidRoot,
      resourcesPath: invalidRoot,
    });
    expect(invalid.status).toBe('invalid');
    expect(JSON.stringify(invalid)).not.toContain('provider-secret');

    const oversizeRoot = tempRoot();
    fs.mkdirSync(path.join(oversizeRoot, 'build'), { recursive: true });
    fs.writeFileSync(
      path.join(oversizeRoot, 'build', 'build-info.json'),
      `{"rawResult":"${'provider-secret'.repeat(BUILD_INFO_MAX_BYTES)}"}`,
    );
    const oversize = loadBuildIdentity({
      isPackaged: false,
      appPath: oversizeRoot,
      resourcesPath: oversizeRoot,
    });
    expect(oversize.status).toBe('oversize');
    expect(JSON.stringify(oversize)).not.toContain('provider-secret');
  });
});

describe('process startup identity', () => {
  it('generates one stable UUID run id for this process module', () => {
    const first = getProcessRunId();
    expect(getProcessRunId()).toBe(first);
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('creates a compact startup record with every required diagnostic field', () => {
    expect(createProcessStartupRecord({
      runId: 'run-test',
      pid: 42,
      appVersion: '1.2.3',
      build: {
        status: 'ok',
        shortCommit: 'abcdef123456',
        builtAt: '2026-07-28T12:34:56.000Z',
        dirty: false,
      },
      isPackaged: true,
      platform: 'darwin',
      arch: 'arm64',
      schemaUserVersion: 43,
      configuredFileLogLevel: 'warn',
    })).toEqual({
      event: 'process-startup',
      runId: 'run-test',
      pid: 42,
      appVersion: '1.2.3',
      buildStatus: 'ok',
      buildShortCommit: 'abcdef123456',
      buildTimestamp: '2026-07-28T12:34:56.000Z',
      buildDirty: false,
      isPackaged: true,
      platform: 'darwin',
      arch: 'arm64',
      schemaUserVersion: 43,
      configuredFileLogLevel: 'warn',
    });
  });
});
