import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  commitManagedTextTransaction, readTrustedTextFile, type TrustedTextFile,
} from '@hosts/linux-runtime/connection-credential-issuer';
import type { FeishuProvisioningPaths } from './feishu-provisioning';
import { verifyFeishuRuntimeIntegrity } from './feishu-runtime-integrity';
import { liveFeishuRuntimeDigests } from './feishu-runtime-references';
import {
  inspectFeishuRuntimeRelease, type AppliedFeishuRuntimeRelease,
} from './feishu-runtime-release';

interface RetentionHistory {
  schemaVersion: 1;
  activeDigest: string;
  rollbackDigest: string;
}

export interface FeishuRuntimeRetentionResult {
  status: 'completed' | 'partial' | 'skipped';
  removed: string[];
  retained: string[];
}

export interface FeishuRuntimeRetentionPort {
  prune(paths: FeishuProvisioningPaths, applied: AppliedFeishuRuntimeRelease):
    Promise<FeishuRuntimeRetentionResult>;
}

function historyFile(paths: FeishuProvisioningPaths): TrustedTextFile | null {
  const path = join(paths.runtimeRoot, 'retention.json');
  if (!lstatSync(path, { throwIfNoEntry: false })) return null;
  const file = readTrustedTextFile(path);
  const root = lstatSync(paths.runtimeRoot);
  if (file.mode !== 0o600 || file.uid !== root.uid || file.gid !== root.gid) {
    throw new Error('Untrusted Feishu retention history');
  }
  return file;
}

function parseHistory(file: TrustedTextFile): RetentionHistory {
  const value = JSON.parse(file.text) as RetentionHistory;
  if (!value || value.schemaVersion !== 1 ||
    Object.keys(value).sort().join(',') !== 'activeDigest,rollbackDigest,schemaVersion' ||
    !/^[a-f0-9]{64}$/u.test(value.activeDigest) ||
    !/^[a-f0-9]{64}$/u.test(value.rollbackDigest)) {
    throw new Error('Invalid Feishu retention history');
  }
  return value;
}

export async function pruneFeishuRuntimeReleases(
  paths: FeishuProvisioningPaths,
  applied: AppliedFeishuRuntimeRelease,
  references: () => ReadonlySet<string> = () => liveFeishuRuntimeDigests(paths.runtimeReleases),
): Promise<FeishuRuntimeRetentionResult> {
  const result: FeishuRuntimeRetentionResult = { status: 'skipped', removed: [], retained: [] };
  // Called after health acceptance. Failure here must never revert that accepted runtime.
  try {
    const state = inspectFeishuRuntimeRelease(paths);
    if (state.activeDigest !== applied.activeDigest || state.desiredDigest !== applied.activeDigest) {
      return result;
    }
    const previous = historyFile(paths);
    const recorded = previous ? parseHistory(previous) : null;
    const rollback = applied.changed ? applied.previousDigest
      : recorded?.activeDigest === applied.activeDigest ? recorded.rollbackDigest : null;
    // There is no safe mtime-based inference: reproducible archives have identical timestamps.
    if (!rollback) return result;
    await verifyFeishuRuntimeIntegrity(paths, applied.activeDigest);
    await verifyFeishuRuntimeIntegrity(paths, rollback);
    const stable = (): boolean => {
      const current = inspectFeishuRuntimeRelease(paths);
      return current.activeDigest === applied.activeDigest &&
        current.desiredDigest === applied.activeDigest;
    };
    if (!stable()) return result;
    const history: RetentionHistory = {
      schemaVersion: 1, activeDigest: applied.activeDigest, rollbackDigest: rollback,
    };
    const text = `${JSON.stringify(history)}\n`;
    if (previous) {
      commitManagedTextTransaction({ mutations: [{ current: previous, next: text }] });
    } else {
      commitManagedTextTransaction({
        mutations: [{ current: state.activeFile, next: state.activeFile.text }],
        outputs: [{ path: join(paths.runtimeRoot, 'retention.json'), text, mode: 0o600 }],
      });
    }
    const keep = new Set([applied.activeDigest, rollback, ...references()]);
    const candidates = readdirSync(paths.runtimeReleases).filter(name => /^[a-f0-9]{64}$/u.test(name));
    if (candidates.length > 128) return result;
    result.status = 'completed';
    for (const digest of candidates) {
      if (keep.has(digest)) { result.retained.push(digest); continue; }
      try {
        await verifyFeishuRuntimeIntegrity(paths, digest);
        if (!stable() || historyFile(paths)?.text !== text) throw new Error('Runtime changed');
        if (references().has(digest)) { result.retained.push(digest); continue; }
        rmSync(join(paths.runtimeReleases, digest), { recursive: true });
        result.removed.push(digest);
      } catch {
        result.status = 'partial';
        result.retained.push(digest);
      }
    }
    return result;
  } catch {
    result.status = result.removed.length > 0 ? 'partial' : 'skipped';
    return result;
  }
}

export const FEISHU_RUNTIME_RETENTION: FeishuRuntimeRetentionPort = {
  prune: (paths, applied) => pruneFeishuRuntimeReleases(paths, applied),
};
