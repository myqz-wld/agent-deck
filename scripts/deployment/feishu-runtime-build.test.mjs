import { describe, expect, it } from 'vitest';

import {
  FEISHU_RUNTIME_NODE_IMAGES,
  parseFeishuRuntimeArchitectures,
  runtimeArtifactNames,
  validateRuntimeArchiveEntries,
  validateRuntimeDescriptor,
} from '../build-feishu-runtime.mjs';

function descriptor(architecture) {
  const names = runtimeArtifactNames(architecture);
  return {
    schemaVersion: 1,
    artifact: names.artifact,
    sha256: 'a'.repeat(64),
    size: 123,
    platform: 'linux',
    architecture,
    libc: 'glibc',
    nodeVersion: '22.22.3',
    nodeAbi: 127,
    betterSqlite3Version: '11.10.0',
    releaseVersion: '0.1.0',
    baseImage: FEISHU_RUNTIME_NODE_IMAGES[architecture],
  };
}

describe('Feishu dedicated runtime build contract', () => {
  it('builds both supported architectures by default and accepts one exact target', () => {
    expect(parseFeishuRuntimeArchitectures([])).toEqual(['amd64', 'arm64']);
    expect(parseFeishuRuntimeArchitectures(['--arch', 'amd64'])).toEqual(['amd64']);
    expect(() => parseFeishuRuntimeArchitectures(['--arch', 'x64'])).toThrow('usage');
  });

  it.each(['amd64', 'arm64'])('pins the complete %s descriptor', (architecture) => {
    expect(validateRuntimeDescriptor(descriptor(architecture), architecture)).toEqual(
      descriptor(architecture),
    );
    expect(() => validateRuntimeDescriptor({
      ...descriptor(architecture),
      baseImage: 'docker.io/library/node:22',
    }, architecture)).toThrow('descriptor');
  });

  it('rejects source, tests, credentials, and traversal from the runtime payload', () => {
    const valid = [
      './', './SHA256SUMS', './app/', './app/index.mjs', './bin/', './bin/node',
      './node_modules/', './node_modules/better-sqlite3/',
      './node_modules/better-sqlite3/build/Release/better_sqlite3.node',
      './node_modules/better-sqlite3/lib/index.js', './runtime.json',
    ];
    expect(() => validateRuntimeArchiveEntries(valid)).not.toThrow();
    for (const forbidden of [
      './unexpected/runtime.js', './src/secret.ts',
      './node_modules/a/test/example.js', '../credential.json',
    ]) {
      expect(() => validateRuntimeArchiveEntries([...valid, forbidden])).toThrow('forbidden');
    }
  });
});
