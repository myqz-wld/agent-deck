import * as TOML from '@iarna/toml';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import type { ProjectTrustProviderPort } from './core';
import { projectTrustDescriptor } from './core';
import {
  canonicalProjectDirectory,
  isPathWithin,
  resolveMainGitCheckout,
} from './project-paths';
import {
  ProjectTrustStateError,
  readSecureOptionalText,
  writeAtomicPrivateText,
} from './secure-state-file';

type TomlRecord = Record<string, unknown>;

export interface GrokProjectTrustGrantInput {
  readonly cwd: string;
  readonly statePath: string;
  readonly workspaceKey: string;
}

export interface GrokProjectTrustProviderOptions {
  grokHome(): string;
  homeDirectory(): string;
  grant(input: GrokProjectTrustGrantInput): Promise<void>;
  /** Remote containers use a fixed generated config where folder trust is always enabled. */
  forceFolderTrustEnabled?: boolean;
  environment?: Readonly<Record<string, string | undefined>>;
}

function record(value: unknown): value is TomlRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
}

function parseToml(text: string): TomlRecord {
  try {
    const value = TOML.parse(text) as unknown;
    if (record(value)) return value;
  } catch {}
  throw new ProjectTrustStateError('state-malformed');
}

function parseBoolFlag(value: string | undefined): boolean | null {
  if (value === undefined) return null;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return null;
}

function folderTrustEnabled(options: GrokProjectTrustProviderOptions, grokHome: string): boolean {
  if (options.forceFolderTrustEnabled === true) return true;
  const environment = options.environment ?? process.env;
  const env = parseBoolFlag(environment.GROK_FOLDER_TRUST);
  if (env !== null) return env;
  const config = readSecureOptionalText(join(grokHome, 'config.toml'));
  if (!config) return true;
  const parsed = parseToml(config.text);
  const table = parsed.folder_trust;
  if (table === undefined) return true;
  if (!record(table) || (table.enabled !== undefined && typeof table.enabled !== 'boolean')) {
    throw new ProjectTrustStateError('state-malformed');
  }
  return table.enabled !== false;
}

function unsafeTrustRoot(path: string, home: string): boolean {
  if (!isAbsolute(path)) return true;
  const normalized = resolve(path);
  return dirname(normalized) === normalized || normalized === resolve(home);
}

function readStore(path: string): {
  readonly root: TomlRecord;
  readonly folders: TomlRecord;
  readonly version: string;
} {
  const current = readSecureOptionalText(path);
  if (!current) return { root: {}, folders: {}, version: 'missing' };
  const root = parseToml(current.text);
  const folders = root.folders === undefined
    ? {}
    : record(root.folders) ? root.folders : (() => {
      throw new ProjectTrustStateError('state-malformed');
    })();
  for (const value of Object.values(folders)) {
    if (!record(value) || typeof value.trusted !== 'boolean' ||
        (value.decided_at !== undefined && !Number.isSafeInteger(value.decided_at))) {
      throw new ProjectTrustStateError('state-malformed');
    }
  }
  return { root, folders, version: current.version };
}

function effectiveDecision(
  folders: TomlRecord,
  workspaceKey: string,
  home: string,
): { readonly trusted: boolean; readonly evidence: string } {
  let depth = -1;
  let trusted = false;
  const keys: string[] = [];
  for (const [key, value] of Object.entries(folders)) {
    if (!isAbsolute(key) || unsafeTrustRoot(key, home) || !isPathWithin(key, workspaceKey)) continue;
    const currentDepth = resolve(key).split(/[\\/]+/u).length;
    if (currentDepth < depth) continue;
    if (currentDepth > depth) {
      depth = currentDepth;
      trusted = true;
      keys.length = 0;
    }
    trusted = trusted && (value as TomlRecord).trusted === true;
    keys.push(key);
  }
  return { trusted: depth >= 0 && trusted, evidence: keys.sort().join('\0') || 'unset' };
}

export function createDirectGrokProjectTrustGrant(
  now: () => number = Date.now,
): (input: GrokProjectTrustGrantInput) => Promise<void> {
  const queues = new Map<string, Promise<void>>();
  return async (input) => {
    const previous = queues.get(input.statePath) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => {
      const latest = readStore(input.statePath);
      const nextFolders = {
        ...latest.folders,
        [input.workspaceKey]: {
          ...(record(latest.folders[input.workspaceKey])
            ? latest.folders[input.workspaceKey] as TomlRecord
            : {}),
          trusted: true,
          decided_at: Math.floor(now() / 1000),
        },
      };
      writeAtomicPrivateText(input.statePath, TOML.stringify({
        ...latest.root,
        folders: nextFolders,
      } as TOML.JsonMap));
    });
    queues.set(input.statePath, current);
    try { await current; } finally {
      if (queues.get(input.statePath) === current) queues.delete(input.statePath);
    }
  };
}

export function createGrokProjectTrustProvider(
  options: GrokProjectTrustProviderOptions,
): ProjectTrustProviderPort {
  return Object.freeze({
    async observe(input) {
      let cwd: string;
      let grokHome: string;
      let home: string;
      try {
        cwd = canonicalProjectDirectory(input.cwd);
        grokHome = resolve(options.grokHome());
        home = canonicalProjectDirectory(options.homeDirectory());
      } catch {
        return { descriptor: projectTrustDescriptor({
          adapterId: 'grok-build', canGrant: false,
          identity: `${input.cwd}`, nativeVersion: 'unavailable',
          reasonCode: 'state-unreadable', status: 'unknown',
        }) };
      }
      const derived = resolveMainGitCheckout(cwd) ?? cwd;
      const workspaceKey = unsafeTrustRoot(derived, home) ? cwd : derived;
      const statePath = join(grokHome, 'trusted_folders.toml');
      if (unsafeTrustRoot(workspaceKey, home)) {
        return { descriptor: projectTrustDescriptor({
          adapterId: 'grok-build', canGrant: false,
          identity: `${statePath}\0${workspaceKey}`, nativeVersion: 'unsafe-root',
          reasonCode: 'unsafe-project-root', status: 'unsupported',
        }) };
      }
      try {
        if (!folderTrustEnabled(options, grokHome)) {
          return { descriptor: projectTrustDescriptor({
            adapterId: 'grok-build', canGrant: false,
            identity: `${statePath}\0${workspaceKey}`, nativeVersion: 'policy-disabled',
            reasonCode: 'policy-disabled', status: 'unsupported',
          }) };
        }
        const current = readStore(statePath);
        const decision = effectiveDecision(current.folders, workspaceKey, home);
        return Object.freeze({
          descriptor: projectTrustDescriptor({
            adapterId: 'grok-build', canGrant: !decision.trusted,
            identity: `${statePath}\0${workspaceKey}`,
            nativeVersion: `${current.version}:${decision.evidence}:${decision.trusted}`,
            reasonCode: null, status: decision.trusted ? 'trusted' : 'untrusted',
          }),
          ...(!decision.trusted ? {
            grant: () => options.grant({ cwd, statePath, workspaceKey }),
          } : {}),
        });
      } catch (error) {
        const reasonCode = error instanceof ProjectTrustStateError
          ? error.reasonCode
          : 'state-unreadable';
        return { descriptor: projectTrustDescriptor({
          adapterId: 'grok-build', canGrant: false,
          identity: `${statePath}\0${workspaceKey}`, nativeVersion: 'error',
          reasonCode, status: 'unknown',
        }) };
      }
    },
  });
}
