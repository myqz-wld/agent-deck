import { lstatSync, realpathSync } from 'node:fs';

import type { WorkspaceSandboxSpec } from '@contracts/index';

export type WorkspaceSandboxRootKind =
  | 'private'
  | 'private-state'
  | 'runtime-read'
  | 'workspace';

export interface WorkspaceSandboxRootSnapshot {
  readonly path: string;
  readonly kind: WorkspaceSandboxRootKind;
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly uid: number;
}

export interface WorkspaceSandboxIdentitySnapshot {
  readonly expectedUid: number;
  readonly roots: readonly WorkspaceSandboxRootSnapshot[];
}

function captureRoot(
  path: string,
  kind: WorkspaceSandboxRootKind,
  expectedUid: number,
): WorkspaceSandboxRootSnapshot {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) {
    throw new Error(`workspace sandbox ${kind} root is not one canonical directory`);
  }
  const mode = stat.mode & 0o777;
  if (kind === 'private' || kind === 'private-state') {
    if (stat.uid !== expectedUid || mode !== 0o700) {
      throw new Error(`workspace sandbox ${kind} root must be owned by the Worker uid and mode 0700`);
    }
  } else if (kind === 'workspace') {
    if (stat.uid !== expectedUid || (mode & 0o002) !== 0) {
      throw new Error('workspace sandbox workspace root ownership or mode is unsafe');
    }
  } else if ((mode & 0o022) !== 0) {
    throw new Error('workspace sandbox runtime root is writable by group or world');
  }
  return Object.freeze({
    path,
    kind,
    dev: stat.dev,
    ino: stat.ino,
    mode,
    uid: stat.uid,
  });
}

function allRoots(spec: WorkspaceSandboxSpec): Array<{
  readonly kind: WorkspaceSandboxRootKind;
  readonly path: string;
}> {
  return [
    { kind: 'workspace', path: spec.workspaceRoot },
    { kind: 'private', path: spec.privateRoot },
    ...Object.values(spec.environment).map((path) => ({
      kind: 'private-state' as const,
      path,
    })),
    ...spec.runtimeReadRoots.map((path) => ({ kind: 'runtime-read' as const, path })),
  ];
}

export function captureWorkspaceSandboxIdentity(
  spec: WorkspaceSandboxSpec,
  expectedUid = typeof process.getuid === 'function' ? process.getuid() : -1,
): WorkspaceSandboxIdentitySnapshot {
  if (!Number.isSafeInteger(expectedUid) || expectedUid < 0) {
    throw new Error('workspace sandbox requires one concrete Worker uid');
  }
  const roots = allRoots(spec).map(({ path, kind }) => captureRoot(path, kind, expectedUid));
  return Object.freeze({ expectedUid, roots: Object.freeze(roots) });
}

export function assertWorkspaceSandboxIdentity(
  snapshot: WorkspaceSandboxIdentitySnapshot,
): void {
  for (const expected of snapshot.roots) {
    const actual = captureRoot(expected.path, expected.kind, snapshot.expectedUid);
    if (
      actual.dev !== expected.dev || actual.ino !== expected.ino ||
      actual.mode !== expected.mode || actual.uid !== expected.uid
    ) {
      throw new Error(`workspace sandbox ${expected.kind} root identity changed`);
    }
  }
}
