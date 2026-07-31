import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  applyEdits,
  modify,
  parse,
  printParseErrorCode,
  type FormattingOptions,
  type ParseError,
} from 'jsonc-parser';
import { lockSync } from 'proper-lockfile';

export type JsonObject = Record<string, unknown>;

export interface HookEntry extends JsonObject {
  type?: string;
  command?: string;
}

export interface HookGroup extends JsonObject {
  hooks: HookEntry[];
}

export interface HookConfigDocument {
  path: string;
  exists: boolean;
  isSymbolicLink: boolean;
  text: string;
  data: JsonObject;
  mode: number | null;
  fingerprint: string | null;
}

export interface HookConfigChange {
  path: string[];
  value: unknown;
}

export interface HookConfigUpdate {
  changes: HookConfigChange[];
  deleteFileIfRootEmpty?: boolean;
}

export interface HookConfigUpdateOptions {
  modeForNew: number;
  directoryMode: number;
  beforeCommit?: () => void;
}

function isJsonObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function lstatIfPresent(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

function fingerprint(stat: Stats): string {
  return [
    stat.dev,
    stat.ino,
    stat.size,
    stat.mtimeMs,
    stat.ctimeMs,
    stat.mode & 0o777,
  ].join(':');
}

function assertRegularHookConfig(path: string, stat: Stats): void {
  if (stat.isSymbolicLink()) {
    throw new Error(
      `${path} is a symbolic link. Agent Deck refuses to replace or follow hook-config links.`,
    );
  }
  if (!stat.isFile()) {
    throw new Error(`${path} is not a regular file. Aborted without changing it.`);
  }
}

function readRegularSnapshot(
  path: string,
  linkStat: Stats,
  changedMessage: string,
): { fingerprint: string; mode: number; text: string } {
  let fd: number | null = null;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        constants.O_NONBLOCK,
    );
    const openedStat = fstatSync(fd);
    if (
      !openedStat.isFile() ||
      fingerprint(openedStat) !== fingerprint(linkStat)
    ) {
      throw new Error(changedMessage);
    }
    const text = readFileSync(fd, 'utf8');
    const afterReadStat = fstatSync(fd);
    if (fingerprint(afterReadStat) !== fingerprint(openedStat)) {
      throw new Error(changedMessage);
    }
    return {
      fingerprint: fingerprint(afterReadStat),
      mode: afterReadStat.mode & 0o777,
      text,
    };
  } catch (error) {
    if (error instanceof Error && error.message === changedMessage) throw error;
    throw new Error(changedMessage);
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function parseDocument(path: string, text: string): JsonObject {
  const errors: ParseError[] = [];
  const value = parse(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  }) as unknown;
  if (errors.length > 0) {
    const first = errors[0];
    throw new Error(
      `${path} parse failed (${printParseErrorCode(first.error)} at offset ${first.offset}). ` +
        'Aborted to avoid overwriting existing hook configuration.',
    );
  }
  if (!isJsonObject(value)) {
    throw new Error(`${path} must contain a JSON object. Aborted without changing the file.`);
  }
  return value;
}

export function readHookConfig(path: string): HookConfigDocument {
  const linkStat = lstatIfPresent(path);
  if (!linkStat) {
    return {
      path,
      exists: false,
      isSymbolicLink: false,
      text: '{}\n',
      data: {},
      mode: null,
      fingerprint: null,
    };
  }

  assertRegularHookConfig(path, linkStat);
  const snapshot = readRegularSnapshot(
    path,
    linkStat,
    `${path} changed while Agent Deck was reading hooks. Aborted without changing it.`,
  );
  return {
    path,
    exists: true,
    isSymbolicLink: false,
    text: snapshot.text,
    data: parseDocument(path, snapshot.text),
    mode: snapshot.mode,
    fingerprint: snapshot.fingerprint,
  };
}

export function hooksObject(
  document: HookConfigDocument,
): JsonObject | undefined {
  const hooks = document.data.hooks;
  if (hooks === undefined) return undefined;
  if (!isJsonObject(hooks)) {
    throw new Error(
      `${document.path} field "hooks" must be an object. Aborted without changing the file.`,
    );
  }
  return hooks;
}

export function strictHookGroups(
  document: HookConfigDocument,
  hooks: JsonObject | undefined,
  event: string,
): HookGroup[] {
  const value = hooks?.[event];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(
      `${document.path} hook event "${event}" must be an array. Aborted without changing the file.`,
    );
  }
  return value.map((group, groupIndex) => {
    if (!isJsonObject(group)) {
      throw new Error(
        `${document.path} hook event "${event}" group ${groupIndex} must be an object. ` +
          'Aborted without changing the file.',
      );
    }
    if (!Array.isArray(group.hooks)) {
      throw new Error(
        `${document.path} hook event "${event}" group ${groupIndex} must contain a hooks array. ` +
          'Aborted without changing the file.',
      );
    }
    const entries = group.hooks.map((entry, hookIndex) => {
      if (!isJsonObject(entry)) {
        throw new Error(
          `${document.path} hook event "${event}" group ${groupIndex} hook ${hookIndex} ` +
            'must be an object. Aborted without changing the file.',
        );
      }
      return entry as HookEntry;
    });
    return { ...group, hooks: entries };
  });
}

export function changedHookEvent(
  event: string,
  before: HookGroup[],
  after: HookGroup[],
): HookConfigChange | null {
  return isDeepStrictEqual(before, after)
    ? null
    : { path: ['hooks', event], value: after.length > 0 ? after : undefined };
}

function formattingOptions(text: string): FormattingOptions {
  const indent = /\r?\n([ \t]+)"/.exec(text)?.[1] ?? '  ';
  return {
    insertSpaces: !indent.includes('\t'),
    tabSize: indent.includes('\t') ? 1 : Math.max(1, indent.length),
    eol: text.includes('\r\n') ? '\r\n' : '\n',
  };
}

function applyChanges(document: HookConfigDocument, changes: HookConfigChange[]): string {
  let text = document.text;
  const options = formattingOptions(text);
  for (const change of changes) {
    text = applyEdits(
      text,
      modify(text, change.path, change.value, { formattingOptions: options }),
    );
  }
  parseDocument(document.path, text);
  return text;
}

function assertUnchanged(document: HookConfigDocument): void {
  const current = lstatIfPresent(document.path);
  if (!document.exists) {
    if (current) {
      if (current.isSymbolicLink() || !current.isFile()) {
        throw new Error(
          `${document.path} changed type while Agent Deck was preparing hooks. No update was committed.`,
        );
      }
      throw new Error(
        `${document.path} changed while Agent Deck was preparing hooks. No update was committed.`,
      );
    }
    return;
  }
  if (!current) {
    throw new Error(
      `${document.path} changed while Agent Deck was preparing hooks. No update was committed.`,
    );
  }
  if (!current.isFile() || current.isSymbolicLink()) {
    throw new Error(
      `${document.path} changed type while Agent Deck was preparing hooks. No update was committed.`,
    );
  }
  const snapshot = readRegularSnapshot(
    document.path,
    current,
    `${document.path} changed while Agent Deck was preparing hooks. No update was committed.`,
  );
  if (
    snapshot.fingerprint !== document.fingerprint ||
    snapshot.text !== document.text
  ) {
    throw new Error(
      `${document.path} changed while Agent Deck was preparing hooks. No update was committed.`,
    );
  }
}

function fsyncDirectory(path: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY);
    fsyncSync(fd);
  } catch {
    // Directory fsync is not supported on every platform. The file itself was already fsynced.
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function writeAtomic(
  document: HookConfigDocument,
  text: string,
  modeForNew: number,
  beforeCommit?: () => void,
): void {
  const targetMode = document.mode ?? modeForNew;
  const temporaryPath = `${document.path}.tmp.${process.pid}.${randomBytes(8).toString('hex')}`;
  let temporaryExists = false;
  try {
    const fd = openSync(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      targetMode,
    );
    temporaryExists = true;
    try {
      writeFileSync(fd, text, { encoding: 'utf8' });
      fchmodSync(fd, targetMode);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    beforeCommit?.();
    assertUnchanged(document);
    renameSync(temporaryPath, document.path);
    temporaryExists = false;
    fsyncDirectory(dirname(document.path));
  } finally {
    if (temporaryExists) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // Best effort: never mask the original write/concurrency error.
      }
    }
  }
}

function deleteUnchanged(
  document: HookConfigDocument,
  beforeCommit?: () => void,
): void {
  if (!document.exists) return;
  beforeCommit?.();
  assertUnchanged(document);
  unlinkSync(document.path);
  fsyncDirectory(dirname(document.path));
}

export function updateHookConfig(
  path: string,
  updater: (document: HookConfigDocument) => HookConfigUpdate,
  options: HookConfigUpdateOptions,
): boolean {
  mkdirSync(dirname(path), {
    recursive: true,
    mode: options.directoryMode,
  });
  const release = lockSync(path, {
    realpath: false,
    stale: 10_000,
    lockfilePath: `${path}.agent-deck.lock`,
  });
  try {
    const document = readHookConfig(path);
    const update = updater(document);
    if (update.changes.length === 0) return false;
    const nextText = applyChanges(document, update.changes);
    if (nextText === document.text) return false;
    const nextData = parseDocument(path, nextText);
    if (update.deleteFileIfRootEmpty && Object.keys(nextData).length === 0) {
      deleteUnchanged(document, options.beforeCommit);
    } else {
      writeAtomic(document, nextText, options.modeForNew, options.beforeCommit);
    }
    return true;
  } finally {
    release();
  }
}
