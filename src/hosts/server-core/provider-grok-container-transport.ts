import { lstatSync, realpathSync, type Stats } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { parseWorkspaceDirectoryRef, type SessionConsoleSandboxAccess } from '@contracts/index';
import {
  GrokAcpProcess,
  type GrokAcpClientOptions,
  type GrokAcpSessionFactory,
  type GrokAcpSessionFactoryInput,
} from '@main/adapters/grok-build/acp-process';

import type {
  ServerCoreProviderGrokContainerRuntime,
} from './provider-grok-container-runtime';

const CONTAINER_WORKSPACE = '/workspace';

interface RootIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly uid: number;
}

export interface ServerCoreProviderGrokContainerTransportOptions {
  readonly runtime: Pick<ServerCoreProviderGrokContainerRuntime, 'open'>;
  readonly workspaceRoot: string;
}

function identity(stat: Stats): RootIdentity {
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode & 0o777,
    uid: stat.uid,
  });
}

function same(left: RootIdentity, right: RootIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.uid === right.uid;
}

function canonicalDirectory(path: string, field: string): RootIdentity {
  if (!isAbsolute(path) || resolve(path) !== path || path === '/' || path.includes('\0')) {
    throw new Error(`${field} is invalid`);
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) {
    throw new Error(`${field} is not canonical`);
  }
  return identity(stat);
}

function access(profile: string | null): SessionConsoleSandboxAccess {
  if (profile === 'strict') return 'provider-strict';
  if (profile === 'read-only') return 'workspace-read-only';
  if (profile === 'workspace') return 'selected-directory-read-write';
  if (profile === 'off') return 'workspace-read-write';
  throw new Error('Provider Grok sandbox profile is unavailable');
}

function clientOptions(input: GrokAcpSessionFactoryInput): GrokAcpClientOptions {
  return {
    authenticate: input.authenticate,
    onGrokExtensionUpdate: input.onGrokExtensionUpdate,
    onGrokPromptComplete: input.onGrokPromptComplete,
    onPermissionRequest: input.onPermissionRequest,
    onSessionUpdate: input.onSessionUpdate,
    onSessionUpdateError: input.onSessionUpdateError,
  };
}

/** Maps a canonical Core Workspace cwd to the fixed container namespace and ACP channel. */
export function createServerCoreProviderGrokContainerTransport(
  options: ServerCoreProviderGrokContainerTransportOptions,
): GrokAcpSessionFactory {
  const workspaceIdentity = canonicalDirectory(options.workspaceRoot, 'Provider Workspace');
  return async (input) => {
    if (!same(
      workspaceIdentity,
      canonicalDirectory(options.workspaceRoot, 'Provider Workspace'),
    )) throw new Error('Provider Workspace identity changed');
    canonicalDirectory(input.cwd, 'Provider Grok working directory');
    const relation = relative(options.workspaceRoot, input.cwd);
    if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
      throw new Error('Provider Grok working directory escapes the Workspace');
    }
    const workingDirectory = parseWorkspaceDirectoryRef(
      relation === '' ? '.' : relation.split(sep).join('/'),
      'provider.grok.workingDirectory',
    );
    const effectiveAccess = access(input.sandboxProfile);
    const session = await options.runtime.open({
      effectiveAccess,
      sessionId: input.applicationSessionId,
      workingDirectory,
      ...(input.browserContext ? { browserContext: input.browserContext } : {}),
    });
    const process = await GrokAcpProcess.connect(session, clientOptions(input));
    const selectedCwd = workingDirectory === '.'
      ? CONTAINER_WORKSPACE
      : `${CONTAINER_WORKSPACE}/${workingDirectory}`;
    return Object.freeze({
      allowAgentDeckMcp: false,
      allowHostPathMetadata: false,
      process,
      sessionCwd: effectiveAccess === 'provider-strict'
        ? CONTAINER_WORKSPACE
        : selectedCwd,
    });
  };
}
