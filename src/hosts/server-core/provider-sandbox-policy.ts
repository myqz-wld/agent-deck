import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import type { SessionConsoleSandboxAccess } from '@contracts/index';
import type { SessionAdapterId } from '@shared/types';

import type { ServerCoreProviderWorkspaceBoundary } from './provider-host-common';

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

export type ServerCoreProviderSandboxRequest =
  | { readonly adapterId: 'claude-code'; readonly mode: 'off' | 'strict' | 'workspace-write' }
  | { readonly adapterId: 'codex-cli'; readonly mode: 'danger-full-access' | 'read-only' | 'workspace-write' }
  | { readonly adapterId: 'grok-build'; readonly mode: 'off' | 'read-only' | 'workspace' };

export interface ServerCoreProviderSandboxRootIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly path: string;
  readonly uid: number;
}

export interface ServerCoreProviderSandboxScope {
  readonly roots: readonly ServerCoreProviderSandboxRootIdentity[];
  readonly selectedDirectory: string;
  readonly workspaceRoot: string;
}

export interface ServerCoreEffectiveProviderSandboxPolicy {
  readonly adapterId: SessionAdapterId;
  readonly effectiveAccess: SessionConsoleSandboxAccess;
  /** Model-facing roots only. Provider credentials and mutable state are deliberately absent. */
  readonly readOnlyRoots: readonly string[];
  readonly readWriteRoots: readonly string[];
  readonly requestedMode: string;
  readonly scope: ServerCoreProviderSandboxScope;
  readonly modelDeniedRoots: readonly string[];
  readonly networkBoundary: 'provider-controlled';
}

export interface ServerCoreProviderSandboxChoice {
  readonly effectiveAccess: SessionConsoleSandboxAccess;
  readonly enabled: boolean;
  readonly disabledReason: string | null;
  readonly value: string;
}

export const SERVER_CORE_REMOTE_GROK_CONTAINER_REQUIRED_REASON =
  'Remote Grok 需要 Provider 会话容器与 Core 凭证代理；当前运行时尚未提供安全隔离。';

function canonicalDirectory(path: string, field: string): ServerCoreProviderSandboxRootIdentity {
  if (!isAbsolute(path) || resolve(path) !== path || CONTROL.test(path)) {
    throw new Error(`${field} must be one normalized absolute directory`);
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) {
    throw new Error(`${field} must be one canonical directory`);
  }
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode & 0o777,
    path,
    uid: stat.uid,
  });
}

function within(parent: string, child: string): boolean {
  const relation = relative(parent, child);
  return relation === '' || (
    relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation)
  );
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function captureScope(
  boundary: ServerCoreProviderWorkspaceBoundary,
  workingDirectory: string,
): ServerCoreProviderSandboxScope {
  const roots = unique([
    boundary.workspaceRoot,
    workingDirectory,
    boundary.privateRoot,
    boundary.providerHomeRoot,
    boundary.providerCacheRoot,
    boundary.providerTempRoot,
    ...boundary.runtimeReadRoots,
  ]).map((path, index) => canonicalDirectory(path, `provider sandbox root[${index}]`));
  const workspaceRoot = roots.find((root) => root.path === boundary.workspaceRoot)!;
  const selectedDirectory = roots.find((root) => root.path === workingDirectory)!;
  if (!within(workspaceRoot.path, selectedDirectory.path)) {
    throw new Error('provider sandbox working directory escapes the Workspace');
  }
  for (const privatePath of [
    boundary.privateRoot,
    boundary.providerHomeRoot,
    boundary.providerCacheRoot,
    boundary.providerTempRoot,
  ]) {
    if (within(workspaceRoot.path, privatePath) || within(privatePath, workspaceRoot.path)) {
      throw new Error('provider sandbox private state overlaps the Workspace');
    }
  }
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  for (const privatePath of [
    boundary.privateRoot,
    boundary.providerHomeRoot,
    boundary.providerCacheRoot,
    boundary.providerTempRoot,
  ]) {
    const identity = roots.find((root) => root.path === privatePath)!;
    if ((identity.mode & 0o077) !== 0 || (currentUid !== null && identity.uid !== currentUid)) {
      throw new Error('provider sandbox private state is not process-private');
    }
  }
  if (!within(boundary.privateRoot, boundary.providerHomeRoot) ||
      !within(boundary.privateRoot, boundary.providerCacheRoot) ||
      !within(boundary.privateRoot, boundary.providerTempRoot)) {
    throw new Error('provider sandbox state projections must remain below the private root');
  }
  return Object.freeze({
    roots: Object.freeze(roots),
    selectedDirectory: selectedDirectory.path,
    workspaceRoot: workspaceRoot.path,
  });
}

function accessFor(request: ServerCoreProviderSandboxRequest): {
  readonly effectiveAccess: SessionConsoleSandboxAccess;
  readonly workspaceRead: boolean;
  readonly workspaceWrite: boolean;
  readonly selectedRead: boolean;
  readonly selectedWrite: boolean;
} {
  if (request.adapterId === 'claude-code') {
    if (request.mode === 'off') {
      return { effectiveAccess: 'workspace-read-write', workspaceRead: true,
        workspaceWrite: true, selectedRead: true, selectedWrite: true };
    }
    if (request.mode === 'workspace-write') {
      return { effectiveAccess: 'selected-directory-read-write', workspaceRead: true,
        workspaceWrite: false, selectedRead: true, selectedWrite: true };
    }
    return { effectiveAccess: 'provider-strict', workspaceRead: false,
      workspaceWrite: false, selectedRead: true, selectedWrite: false };
  }
  if (request.adapterId === 'codex-cli') {
    if (request.mode === 'danger-full-access') {
      return { effectiveAccess: 'workspace-read-write', workspaceRead: true,
        workspaceWrite: true, selectedRead: true, selectedWrite: true };
    }
    if (request.mode === 'workspace-write') {
      return { effectiveAccess: 'selected-directory-read-write', workspaceRead: true,
        workspaceWrite: false, selectedRead: true, selectedWrite: true };
    }
    return { effectiveAccess: 'workspace-read-only', workspaceRead: true,
      workspaceWrite: false, selectedRead: true, selectedWrite: false };
  }
  if (request.mode === 'off') {
    return { effectiveAccess: 'workspace-read-write', workspaceRead: true,
      workspaceWrite: true, selectedRead: true, selectedWrite: true };
  }
  if (request.mode === 'workspace') {
    return { effectiveAccess: 'selected-directory-read-write', workspaceRead: true,
      workspaceWrite: false, selectedRead: true, selectedWrite: true };
  }
  return { effectiveAccess: 'workspace-read-only', workspaceRead: true,
    workspaceWrite: false, selectedRead: true, selectedWrite: false };
}

export function compileServerCoreProviderSandboxPolicy(
  boundary: ServerCoreProviderWorkspaceBoundary,
  request: ServerCoreProviderSandboxRequest,
  workingDirectory: string,
): ServerCoreEffectiveProviderSandboxPolicy {
  const scope = captureScope(boundary, workingDirectory);
  const access = accessFor(request);
  const readWriteRoots = access.workspaceWrite
    ? [scope.workspaceRoot]
    : access.selectedWrite ? [scope.selectedDirectory] : [];
  const readOnlyRoots = unique([
    ...boundary.runtimeReadRoots,
    ...(access.workspaceRead ? [scope.workspaceRoot] : []),
    ...(access.selectedRead && !access.workspaceRead && !access.selectedWrite
      ? [scope.selectedDirectory]
      : []),
  ]);
  return Object.freeze({
    adapterId: request.adapterId,
    effectiveAccess: access.effectiveAccess,
    modelDeniedRoots: Object.freeze(unique([
      boundary.privateRoot,
      boundary.providerHomeRoot,
      boundary.providerCacheRoot,
      boundary.providerTempRoot,
    ])),
    networkBoundary: 'provider-controlled',
    readOnlyRoots: Object.freeze(readOnlyRoots),
    readWriteRoots: Object.freeze(readWriteRoots),
    requestedMode: request.mode,
    scope,
  });
}

export function assertServerCoreProviderSandboxScope(
  scope: ServerCoreProviderSandboxScope,
): void {
  for (const expected of scope.roots) {
    const actual = canonicalDirectory(expected.path, 'provider sandbox root');
    if (
      actual.dev !== expected.dev || actual.ino !== expected.ino ||
      actual.mode !== expected.mode || actual.uid !== expected.uid
    ) {
      throw new Error('provider sandbox root identity changed before child spawn');
    }
  }
}

export function assertServerCoreAdditionalWriteRoots(
  _policy: ServerCoreEffectiveProviderSandboxPolicy,
  requested: readonly string[] | undefined,
): void {
  if ((requested?.length ?? 0) > 0) {
    throw new Error('Remote provider sandbox does not accept additional write roots');
  }
}

export function serverCoreProviderSandboxChoices(
  adapterId: SessionAdapterId,
  grokAvailable = false,
): readonly ServerCoreProviderSandboxChoice[] {
  if (adapterId === 'claude-code') return Object.freeze([
    { value: 'off', effectiveAccess: 'workspace-read-write', enabled: true, disabledReason: null },
    { value: 'workspace-write', effectiveAccess: 'selected-directory-read-write', enabled: true,
      disabledReason: null },
    { value: 'strict', effectiveAccess: 'provider-strict', enabled: true, disabledReason: null },
  ]);
  if (adapterId === 'codex-cli') return Object.freeze([
    { value: 'workspace-write', effectiveAccess: 'selected-directory-read-write', enabled: true,
      disabledReason: null },
    { value: 'read-only', effectiveAccess: 'workspace-read-only', enabled: true,
      disabledReason: null },
    { value: 'danger-full-access', effectiveAccess: 'workspace-read-write', enabled: true,
      disabledReason: null },
  ]);
  return Object.freeze([
    { value: 'read-only', effectiveAccess: 'workspace-read-only', enabled: grokAvailable,
      disabledReason: grokAvailable ? null : SERVER_CORE_REMOTE_GROK_CONTAINER_REQUIRED_REASON },
    { value: 'workspace', effectiveAccess: 'selected-directory-read-write',
      enabled: grokAvailable,
      disabledReason: grokAvailable ? null : SERVER_CORE_REMOTE_GROK_CONTAINER_REQUIRED_REASON },
    { value: 'off', effectiveAccess: 'workspace-read-write', enabled: grokAvailable,
      disabledReason: grokAvailable ? null : SERVER_CORE_REMOTE_GROK_CONTAINER_REQUIRED_REASON },
  ]);
}
