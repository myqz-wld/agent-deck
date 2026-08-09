import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const HELPER_OUTPUT_BYTES = 64 * 1024;
const HELPER_EXIT_GRACE_MS = 5_000;
const HELPER_CLEAN_FAILURE_EXIT = 1;

function childExitCode(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'number' ? code : null;
}

export class ServerCorePinnedMutationError extends Error {
  constructor(readonly cleanupProven: boolean) {
    super(cleanupProven
      ? 'Pinned filesystem mutation failed without retained state'
      : 'Pinned filesystem mutation cleanup could not be proven');
    this.name = 'ServerCorePinnedMutationError';
  }
}

const PINNED_DIRECTORY_HELPER = String.raw`
const { lstatSync, mkdirSync, realpathSync, rmdirSync } = require('node:fs');
const path = require('node:path');

const CLEAN_FAILURE = 1;
const CLEANUP_UNPROVED = 86;
function stop(code = CLEAN_FAILURE) { process.exit(code); }
function identity(candidate) {
  const entry = lstatSync(candidate);
  const canonical = realpathSync.native(candidate);
  if (!entry.isDirectory() || entry.isSymbolicLink()) stop();
  return { canonical, dev: entry.dev, ino: entry.ino };
}
function removeCreated(name) {
  try { rmdirSync(name); } catch {}
  try {
    lstatSync(name);
    return false;
  } catch (error) {
    return error && error.code === 'ENOENT';
  }
}

let payload;
let created = false;
try {
  payload = JSON.parse(Buffer.from(process.argv[1], 'base64url').toString('utf8'));
  if (!payload || typeof payload !== 'object') stop();
  if (typeof payload.parent !== 'string' || typeof payload.directoryName !== 'string') stop();
  if (!Number.isSafeInteger(payload.parentDev) || !Number.isSafeInteger(payload.parentIno)) stop();
  if (
    payload.directoryName.length === 0 || payload.directoryName === '.' ||
    payload.directoryName === '..' || /[\\/\u0000]/u.test(payload.directoryName)
  ) stop();

  const parent = identity('.');
  if (
    parent.canonical !== payload.parent || parent.dev !== payload.parentDev ||
    parent.ino !== payload.parentIno
  ) stop();

  mkdirSync(payload.directoryName);
  created = true;
  const child = identity(payload.directoryName);
  const finalParent = identity('.');
  if (
    finalParent.canonical !== payload.parent || finalParent.dev !== payload.parentDev ||
    finalParent.ino !== payload.parentIno ||
    child.canonical !== path.join(payload.parent, payload.directoryName)
  ) stop(removeCreated(payload.directoryName) ? CLEAN_FAILURE : CLEANUP_UNPROVED);
} catch {
  if (created) stop(removeCreated(payload.directoryName) ? CLEAN_FAILURE : CLEANUP_UNPROVED);
  stop();
}
`;

const PINNED_WORKTREE_HELPER = String.raw`
const { lstatSync, realpathSync, rmSync } = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLEAN_FAILURE = 1;
const CLEANUP_UNPROVED = 86;
const GIT_MUTATION_OUTPUT_BYTES = 64 * 1024;
// The snapshot supports 2,048 registrations with paths up to 16 KiB each, plus
// bounded porcelain metadata. Larger repositories fail closed before mutation.
const MAX_REGISTRATION_COUNT = 2_048;
const MAX_REGISTRATION_PATH_BYTES = 16 * 1024;
const GIT_LIST_OUTPUT_BYTES = 64 * 1024 * 1024;
function stop(code = CLEAN_FAILURE) { process.exit(code); }
function identity(candidate) {
  const entry = lstatSync(candidate);
  const canonical = realpathSync.native(candidate);
  if (!entry.isDirectory() || entry.isSymbolicLink()) stop();
  return { canonical, dev: entry.dev, ino: entry.ino };
}
let deadline = 0;
function git(payload, args) {
  // No cwd option: Git inherits the helper's already-open process cwd directory object.
  const isRegistrationList = args[0] === 'list';
  return spawnSync('git', [
    '--git-dir=' + payload.gitCommonDir,
    'worktree',
    ...args,
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    killSignal: 'SIGKILL',
    maxBuffer: isRegistrationList ? GIT_LIST_OUTPUT_BYTES : GIT_MUTATION_OUTPUT_BYTES,
    timeout: Math.max(1, deadline - Date.now()),
  });
}
function targetAbsent(name) {
  try {
    lstatSync(name);
    return false;
  } catch (error) {
    return error && error.code === 'ENOENT';
  }
}
function registrations(result) {
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') return null;
  const fields = result.stdout.split('\u0000')
    .filter((field) => field.startsWith('worktree '));
  if (fields.length > MAX_REGISTRATION_COUNT) return null;
  const resolved = [];
  for (const field of fields) {
    const candidate = field.slice('worktree '.length);
    if (
      candidate.length === 0 ||
      Buffer.byteLength(candidate, 'utf8') > MAX_REGISTRATION_PATH_BYTES
    ) return null;
    resolved.push(path.resolve(candidate));
  }
  return resolved;
}
function sameRegistrations(expected, actual) {
  if (expected.length !== actual.length) return false;
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  return expectedSet.size === expected.length && actualSet.size === actual.length &&
    actual.every((candidate) => expectedSet.has(candidate));
}
function cleanupParent(payload) {
  try {
    const entry = lstatSync('.');
    const canonical = realpathSync.native('.');
    if (!entry.isDirectory() || entry.isSymbolicLink()) return null;
    if (entry.dev !== payload.parentDev || entry.ino !== payload.parentIno) return null;
    return canonical;
  } catch {
    return null;
  }
}
function cleanup(payload, registrationBaseline) {
  const finalParent = cleanupParent(payload);
  git(payload, ['remove', '--force', payload.worktreeName]);
  try { rmSync(payload.worktreeName, { recursive: true, force: true }); } catch {}
  const listed = registrations(git(payload, ['list', '--porcelain', '-z']));
  if (
    finalParent === null || !targetAbsent(payload.worktreeName) || listed === null ||
    !Array.isArray(registrationBaseline)
  ) return false;
  // A path candidate cannot identify registrations created while this pinned object had
  // an intermediate name. Require the complete trusted Git registration set to return
  // to its pre-mutation baseline instead.
  return sameRegistrations(registrationBaseline, listed);
}

let payload;
let mutationStarted = false;
let registrationBaseline = null;
try {
  payload = JSON.parse(Buffer.from(process.argv[1], 'base64url').toString('utf8'));
  if (!payload || typeof payload !== 'object') stop();
  if (typeof payload.parent !== 'string' || typeof payload.gitCommonDir !== 'string') stop();
  if (typeof payload.worktreeName !== 'string' || typeof payload.startCommit !== 'string') stop();
  if (!Number.isSafeInteger(payload.parentDev) || !Number.isSafeInteger(payload.parentIno)) stop();
  if (!Number.isSafeInteger(payload.gitDev) || !Number.isSafeInteger(payload.gitIno)) stop();
  if (!Number.isSafeInteger(payload.timeoutMs) || payload.timeoutMs <= 0) stop();
  if (
    payload.worktreeName.length === 0 || payload.worktreeName === '.' ||
    payload.worktreeName === '..' || /[\\/\u0000]/u.test(payload.worktreeName)
  ) stop();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(payload.startCommit)) stop();
  deadline = Date.now() + payload.timeoutMs;

  const parent = identity('.');
  const gitCommon = identity(payload.gitCommonDir);
  if (
    parent.canonical !== payload.parent || parent.dev !== payload.parentDev ||
    parent.ino !== payload.parentIno || gitCommon.canonical !== payload.gitCommonDir ||
    gitCommon.dev !== payload.gitDev || gitCommon.ino !== payload.gitIno
  ) stop();

  // Capture trusted Git metadata before crossing the mutation boundary. Cleanup may
  // prove completion only by restoring this exact registration set.
  registrationBaseline = registrations(git(payload, ['list', '--porcelain', '-z']));
  if (registrationBaseline === null) stop();
  mutationStarted = true;
  const created = git(payload, ['add', '--detach', payload.worktreeName, payload.startCommit]);
  if (created.error || created.status !== 0) {
    stop(cleanup(payload, registrationBaseline) ? CLEAN_FAILURE : CLEANUP_UNPROVED);
  }

  const finalParent = identity('.');
  const finalTarget = realpathSync.native(payload.worktreeName);
  if (
    finalParent.canonical !== payload.parent || finalParent.dev !== payload.parentDev ||
    finalParent.ino !== payload.parentIno ||
    finalTarget !== path.join(payload.parent, payload.worktreeName)
  ) {
    stop(cleanup(payload, registrationBaseline) ? CLEAN_FAILURE : CLEANUP_UNPROVED);
  }
} catch {
  if (mutationStarted) {
    stop(cleanup(payload, registrationBaseline) ? CLEAN_FAILURE : CLEANUP_UNPROVED);
  }
  stop();
}
`;

export interface ServerCorePinnedDirectoryCreateInput {
  readonly parent: string;
  readonly parentIdentity: { readonly dev: number; readonly ino: number };
  readonly directoryName: string;
  readonly timeoutMs: number;
  readonly environment?: NodeJS.ProcessEnv;
}

export type ServerCorePinnedDirectoryCreator = (
  input: ServerCorePinnedDirectoryCreateInput,
) => Promise<void>;

/** Creates one child relative to a verified, kernel-pinned parent directory object. */
export const createServerCorePinnedDirectory: ServerCorePinnedDirectoryCreator = async (input) => {
  const payload = Buffer.from(JSON.stringify({
    parent: input.parent,
    parentDev: input.parentIdentity.dev,
    parentIno: input.parentIdentity.ino,
    directoryName: input.directoryName,
  }), 'utf8').toString('base64url');
  const environment = { ...(input.environment ?? process.env) };
  delete environment.NODE_OPTIONS;
  environment.ELECTRON_RUN_AS_NODE = '1';
  try {
    await execFileAsync(process.execPath, ['-e', PINNED_DIRECTORY_HELPER, payload], {
      cwd: input.parent,
      env: environment,
      maxBuffer: HELPER_OUTPUT_BYTES,
      timeout: input.timeoutMs + HELPER_EXIT_GRACE_MS,
    });
  } catch (error) {
    throw new ServerCorePinnedMutationError(
      childExitCode(error) === HELPER_CLEAN_FAILURE_EXIT,
    );
  }
};

export interface ServerCorePinnedWorktreeCreateInput {
  readonly parent: string;
  readonly parentIdentity: { readonly dev: number; readonly ino: number };
  readonly gitCommonDir: string;
  readonly gitCommonIdentity: { readonly dev: number; readonly ino: number };
  readonly worktreeName: string;
  readonly startCommit: string;
  readonly timeoutMs: number;
  readonly environment?: NodeJS.ProcessEnv;
}

export type ServerCorePinnedWorktreeCreator = (
  input: ServerCorePinnedWorktreeCreateInput,
) => Promise<void>;

/**
 * Spawns a Node helper with its cwd set to the verified parent before any Git mutation.
 * The helper validates that kernel-pinned directory object, then gives Git only a relative target.
 */
export const createServerCorePinnedWorktree: ServerCorePinnedWorktreeCreator = async (input) => {
  const payload = Buffer.from(JSON.stringify({
    parent: input.parent,
    parentDev: input.parentIdentity.dev,
    parentIno: input.parentIdentity.ino,
    gitCommonDir: input.gitCommonDir,
    gitDev: input.gitCommonIdentity.dev,
    gitIno: input.gitCommonIdentity.ino,
    worktreeName: input.worktreeName,
    startCommit: input.startCommit,
    timeoutMs: input.timeoutMs,
  }), 'utf8').toString('base64url');
  const environment = { ...(input.environment ?? process.env) };
  delete environment.NODE_OPTIONS;
  environment.ELECTRON_RUN_AS_NODE = '1';
  try {
    await execFileAsync(process.execPath, ['-e', PINNED_WORKTREE_HELPER, payload], {
      cwd: input.parent,
      env: environment,
      maxBuffer: HELPER_OUTPUT_BYTES,
      timeout: input.timeoutMs + HELPER_EXIT_GRACE_MS,
    });
  } catch (error) {
    const code = childExitCode(error);
    throw new ServerCorePinnedMutationError(
      code === HELPER_CLEAN_FAILURE_EXIT,
    );
  }
};
