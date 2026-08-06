import { isAbsolute, resolve } from 'node:path';

import type { WorkspaceSandboxSpec } from '@contracts/index';

export const DARWIN_WORKER_SANDBOX_CONTAINER_ID = 'com.agentdeck.worker-sandbox';
export const LINUX_BWRAP_EXECUTABLE = '/usr/bin/bwrap';

export interface WorkspaceSandboxLaunchCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
}

interface WorkspaceSandboxLaunchInput {
  readonly configFile: string;
  readonly wrapperPath: string;
}

interface DarwinWorkspaceSandboxLaunchInput extends WorkspaceSandboxLaunchInput {
  readonly bookmarkPath: string;
  readonly launcherPath: string;
}

const LINUX_RUNTIME_ROOTS = Object.freeze([
  '/usr',
  '/bin',
  '/lib',
  '/lib64',
]);

const LINUX_RUNTIME_FILES = Object.freeze([
  '/etc/gai.conf',
  '/etc/group',
  '/etc/hosts',
  '/etc/localtime',
  '/etc/nsswitch.conf',
  '/etc/passwd',
  '/etc/pki',
  '/etc/protocols',
  '/etc/resolv.conf',
  '/etc/services',
  '/etc/ssl',
  '/run/systemd/resolve',
]);

function launchPath(value: string, field: string): string {
  if (
    !isAbsolute(value) || resolve(value) !== value ||
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)
  ) {
    throw new Error(`${field} must be one normalized absolute path`);
  }
  return value;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function workspaceSandboxEnvironment(
  spec: WorkspaceSandboxSpec,
): Readonly<Record<string, string>> {
  return Object.freeze({
    HOME: spec.environment.providerHomeRoot,
    XDG_CACHE_HOME: spec.environment.providerCacheRoot,
    XDG_CONFIG_HOME: spec.environment.providerHomeRoot,
    XDG_RUNTIME_DIR: spec.environment.coreRuntimeRoot,
    XDG_STATE_HOME: spec.environment.providerHomeRoot,
    TMPDIR: spec.environment.providerTempRoot,
    TMP: spec.environment.providerTempRoot,
    TEMP: spec.environment.providerTempRoot,
    PATH: '/usr/bin:/bin',
    LANG: 'C',
    LC_ALL: 'C',
  });
}

export function buildDarwinWorkspaceSandboxLaunch(
  spec: WorkspaceSandboxSpec,
  input: DarwinWorkspaceSandboxLaunchInput,
): WorkspaceSandboxLaunchCommand {
  const bookmarkPath = launchPath(input.bookmarkPath, 'workspace bookmark');
  const launcherPath = launchPath(input.launcherPath, 'Worker sandbox launcher');
  const wrapperPath = launchPath(input.wrapperPath, 'Worker wrapper');
  const configFile = launchPath(input.configFile, 'Worker config');
  return Object.freeze({
    executable: launcherPath,
    args: Object.freeze([
      '--bookmark', bookmarkPath,
      '--workspace', spec.workspaceRoot,
      '--', wrapperPath, 'serve', '--config', configFile,
    ]),
    environment: workspaceSandboxEnvironment(spec),
  });
}

function pair(flag: string, source: string, destination = source): string[] {
  return [flag, source, destination];
}

export function buildLinuxWorkspaceSandboxLaunch(
  spec: WorkspaceSandboxSpec,
  input: WorkspaceSandboxLaunchInput,
): WorkspaceSandboxLaunchCommand {
  const wrapperPath = launchPath(input.wrapperPath, 'Worker wrapper');
  const configFile = launchPath(input.configFile, 'Worker config');
  const env = workspaceSandboxEnvironment(spec);
  const args: string[] = [
    '--die-with-parent',
    '--new-session',
    '--unshare-all',
    '--share-net',
    '--clearenv',
    '--proc', '/proc',
    '--dev', '/dev',
  ];
  for (const root of LINUX_RUNTIME_ROOTS) args.push(...pair('--ro-bind-try', root));
  for (const path of LINUX_RUNTIME_FILES) args.push(...pair('--ro-bind-try', path));
  for (const root of unique(spec.runtimeReadRoots)) args.push(...pair('--ro-bind', root));
  args.push(
    ...pair('--bind', spec.workspaceRoot),
    ...pair('--bind', spec.privateRoot),
    ...pair('--bind', spec.environment.providerTempRoot, '/tmp'),
  );
  for (const [key, value] of Object.entries(env)) args.push('--setenv', key, value);
  args.push('--chdir', spec.workspaceRoot, '--', wrapperPath, 'serve', '--config', configFile);
  return Object.freeze({
    executable: LINUX_BWRAP_EXECUTABLE,
    args: Object.freeze(args),
    environment: env,
  });
}
