import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
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

function fingerprint(path: string): string {
  const stat = statSync(path);
  return [
    stat.dev,
    stat.ino,
    stat.size,
    stat.mtimeMs,
    stat.mode & 0o777,
  ].join(':');
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
  if (!existsSync(path)) {
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

  const linkStat = lstatSync(path);
  if (!linkStat.isFile() && !linkStat.isSymbolicLink()) {
    throw new Error(`${path} is not a regular file. Aborted without changing it.`);
  }
  const text = readFileSync(path, 'utf8');
  return {
    path,
    exists: true,
    isSymbolicLink: linkStat.isSymbolicLink(),
    text,
    data: parseDocument(path, text),
    mode: statSync(path).mode & 0o777,
    fingerprint: fingerprint(path),
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
  if (!document.exists) {
    if (existsSync(document.path)) {
      throw new Error(
        `${document.path} changed while Agent Deck was preparing hooks. No update was committed.`,
      );
    }
    return;
  }
  if (!existsSync(document.path)) {
    throw new Error(
      `${document.path} changed while Agent Deck was preparing hooks. No update was committed.`,
    );
  }
  const current = lstatSync(document.path);
  if (!current.isFile() || current.isSymbolicLink()) {
    throw new Error(
      `${document.path} changed type while Agent Deck was preparing hooks. No update was committed.`,
    );
  }
  if (
    fingerprint(document.path) !== document.fingerprint ||
    readFileSync(document.path, 'utf8') !== document.text
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
    if (document.isSymbolicLink) {
      throw new Error(
        `${path} is a symbolic link. Agent Deck refuses to replace or follow hook-config links.`,
      );
    }
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
