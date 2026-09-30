import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { readTrustedTextFile } from '@hosts/linux-runtime/connection-credential-issuer';
import type { FeishuProvisioningPaths } from './feishu-provisioning';
import { verifyFeishuRuntimeRelease } from './feishu-runtime-release';

/** Only complete, immutable runtime trees are eligible for automatic deletion. */
export async function verifyFeishuRuntimeIntegrity(
  paths: FeishuProvisioningPaths, digest: string,
): Promise<void> {
  verifyFeishuRuntimeRelease(paths, digest);
  const root = join(paths.runtimeReleases, digest);
  const owner = lstatSync(root);
  const manifest = readTrustedTextFile(join(root, 'SHA256SUMS')).text;
  const expected = new Map<string, string>();
  for (const line of manifest.trimEnd().split('\n')) {
    const match = line.match(/^([a-f0-9]{64})  \.\/([A-Za-z0-9_./-]+)$/u);
    if (!match || match[2].split('/').some(part => !part || part === '.' || part === '..') ||
      match[2] === 'SHA256SUMS' || expected.has(match[2]) || expected.size >= 512) {
      throw new Error('Untrusted Feishu runtime manifest');
    }
    expected.set(match[2], match[1]);
  }
  for (const required of ['bin/node', 'app/index.mjs', 'runtime.json']) {
    if (!expected.has(required)) throw new Error('Incomplete Feishu runtime manifest');
  }
  let bytes = 0;
  let nodes = 0;
  const found = new Set<string>();
  const visit = (relative: string): void => {
    const path = join(root, relative);
    const stat = lstatSync(path);
    if (++nodes > 1_024 || stat.isSymbolicLink() || realpathSync(path) !== path ||
      stat.uid !== owner.uid || stat.gid !== owner.gid || stat.dev !== owner.dev ||
      (stat.mode & 0o022) !== 0) throw new Error('Untrusted Feishu runtime member');
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) visit(relative ? `${relative}/${name}` : name);
      return;
    }
    if (!stat.isFile() || stat.nlink !== 1 ||
      (relative !== 'SHA256SUMS' && !expected.has(relative))) {
      throw new Error('Unexpected Feishu runtime member');
    }
    bytes += stat.size;
    if (bytes > 512 * 1024 ** 2) throw new Error('Feishu runtime tree exceeds retention bounds');
    found.add(relative);
  };
  visit('');
  if (found.size !== expected.size + 1) throw new Error('Incomplete Feishu runtime tree');
  for (const [relative, expectedHash] of expected) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(join(root, relative))) hash.update(chunk);
    if (hash.digest('hex') !== expectedHash) throw new Error('Feishu runtime checksum mismatch');
  }
}
