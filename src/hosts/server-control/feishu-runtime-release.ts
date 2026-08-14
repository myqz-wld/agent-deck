import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import {
  commitManagedTextTransaction,
  readTrustedTextFile,
  type TrustedTextFile,
} from '@hosts/linux-runtime/connection-credential-issuer';
import type { FeishuProvisioningPaths } from './feishu-provisioning';

const DIGEST_LINE = /^([a-f0-9]{64})\n$/u;

export interface FeishuRuntimeReleaseState {
  readonly activeDigest: string;
  readonly desiredDigest: string;
  readonly updateAvailable: boolean;
  readonly activeFile: TrustedTextFile;
  readonly desiredFile: TrustedTextFile;
}

export interface AppliedFeishuRuntimeRelease {
  readonly previousDigest: string;
  readonly activeDigest: string;
  readonly changed: boolean;
  rollback(): void;
}

function currentOwner(): { readonly uid: number; readonly gid: number } {
  return {
    uid: typeof process.getuid === 'function' ? process.getuid() : 0,
    gid: typeof process.getgid === 'function' ? process.getgid() : 0,
  };
}

function verifyDirectory(path: string, mode: number): void {
  const owner = currentOwner();
  const metadata = lstatSync(path);
  if (
    !metadata.isDirectory() || metadata.isSymbolicLink() || realpathSync(path) !== path ||
    metadata.uid !== owner.uid || metadata.gid !== owner.gid ||
    (metadata.mode & 0o777) !== mode
  ) throw new Error('Feishu runtime directory trust check failed');
}

function pointer(path: string): { readonly file: TrustedTextFile; readonly digest: string } {
  const owner = currentOwner();
  const file = readTrustedTextFile(path);
  const match = file.text.match(DIGEST_LINE);
  if (
    !match || file.mode !== 0o644 || file.uid !== owner.uid || file.gid !== owner.gid
  ) throw new Error('Feishu runtime pointer trust check failed');
  return { file, digest: match[1] };
}

function verifyRelease(paths: FeishuProvisioningPaths, digest: string): void {
  const owner = currentOwner();
  const root = join(paths.runtimeReleases, digest);
  const rootMetadata = lstatSync(root);
  if (
    !rootMetadata.isDirectory() || rootMetadata.isSymbolicLink() || realpathSync(root) !== root ||
    rootMetadata.uid !== owner.uid || rootMetadata.gid !== owner.gid ||
    (rootMetadata.mode & 0o022) !== 0
  ) throw new Error('Feishu runtime release trust check failed');
  for (const relativePath of ['bin/node', 'app/index.mjs', 'runtime.json', 'SHA256SUMS']) {
    const path = join(root, relativePath);
    const metadata = lstatSync(path);
    if (
      !metadata.isFile() || metadata.isSymbolicLink() || realpathSync(path) !== path ||
      metadata.uid !== owner.uid || metadata.gid !== owner.gid ||
      (metadata.mode & 0o022) !== 0
    ) throw new Error('Feishu runtime release file trust check failed');
  }
}

export function inspectFeishuRuntimeRelease(
  paths: FeishuProvisioningPaths,
): FeishuRuntimeReleaseState {
  verifyDirectory(paths.runtimeRoot, 0o755);
  verifyDirectory(paths.runtimeReleases, 0o755);
  const active = pointer(paths.runtimeActive);
  const desired = pointer(paths.runtimeDesired);
  verifyRelease(paths, active.digest);
  verifyRelease(paths, desired.digest);
  return Object.freeze({
    activeDigest: active.digest,
    desiredDigest: desired.digest,
    updateAvailable: active.digest !== desired.digest,
    activeFile: active.file,
    desiredFile: desired.file,
  });
}

export function activateDesiredFeishuRuntime(
  state: FeishuRuntimeReleaseState,
): AppliedFeishuRuntimeRelease {
  if (!state.updateAvailable) {
    return Object.freeze({
      previousDigest: state.activeDigest,
      activeDigest: state.activeDigest,
      changed: false,
      rollback: () => undefined,
    });
  }
  commitManagedTextTransaction({
    mutations: [{ current: state.activeFile, next: state.desiredFile.text }],
  });
  return Object.freeze({
    previousDigest: state.activeDigest,
    activeDigest: state.desiredDigest,
    changed: true,
    rollback: () => {
      const current = readTrustedTextFile(state.activeFile.path);
      commitManagedTextTransaction({
        mutations: [{ current, next: state.activeFile.text }],
      });
    },
  });
}
