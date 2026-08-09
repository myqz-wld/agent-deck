import { isAbsolute, relative, resolve, sep } from 'node:path';

import {
  SESSION_EVENT_MAX_JSON_DEPTH,
  SESSION_EVENT_MAX_JSON_NODES,
  SESSION_EVENT_MAX_PAYLOAD_BYTES,
  SESSION_EVENT_MAX_RESPONSE_BYTES,
  type JsonValue,
  type SessionEventDto,
} from '@contracts/index';
import type { SessionRecord, StoredAgentEvent } from '@shared/types';

const OMITTED_BINARY = '[远程视图已省略二进制内容]';
const OMITTED_DEPTH = '[远程视图已省略过深内容]';
const OMITTED_SIZE = '活动详情过大，远程视图已省略。';
const BINARY_KEY = /^(?:base64|blob|dataUrl|imageBytes|imageData)$/i;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/u;
const ABSOLUTE_HEADER_TOKEN =
  /(^|\s)(?:"((?:[ab]\/)?\/(?:\\.|[^"\\\r\n])*)"|((?:[ab]\/)?\/[^\s"']+))/gu;
const HUNK_HEADER = /^@@ -(?:\d+)(?:,(\d+))? \+(?:\d+)(?:,(\d+))? @@/u;

export interface SessionEventProjectionOptions {
  readonly workspaceRoot: string;
  readonly privateRoots: readonly string[];
}

interface ProjectionState {
  nodes: number;
  readonly privateRoots: readonly string[];
  readonly workspaceRoot: string;
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function truncateUtf8(value: string, maximum: number): string {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.byteLength <= maximum) return value;
  const marker = '…[truncated]';
  let cut = Math.max(0, maximum - Buffer.byteLength(marker));
  while (cut > 0 && (encoded[cut] & 0xc0) === 0x80) cut -= 1;
  return `${encoded.subarray(0, cut).toString('utf8')}${marker}`;
}

function replaceRoots(value: string, state: ProjectionState): string {
  let projected = value;
  for (const root of state.privateRoots) projected = projected.split(root).join('[private]');
  return projected.split(state.workspaceRoot).join('Workspace');
}

function projectPath(value: string, state: ProjectionState): string {
  if (value === '/dev/null') return value;
  if (!isAbsolute(value)) return replaceRoots(value, state);
  const target = resolve(value);
  if (inside(state.workspaceRoot, target)) {
    const suffix = relative(state.workspaceRoot, target).split(sep).join('/');
    return suffix ? `Workspace/${suffix}` : 'Workspace';
  }
  if (state.privateRoots.some((root) => inside(root, target))) return '[private]';
  return '[outside Workspace]';
}

function projectHeaderPath(value: string, state: ProjectionState): string {
  const tab = value.indexOf('\t');
  const path = tab < 0 ? value : value.slice(0, tab);
  const suffix = tab < 0 ? '' : value.slice(tab);
  const projected = path.startsWith('"') && path.endsWith('"')
    ? `"${projectDiffHeaderToken(path.slice(1, -1), state)}"`
    : projectDiffHeaderToken(path, state);
  return `${projected}${suffix}`;
}

function projectDiffHeaderToken(value: string, state: ProjectionState): string {
  const prefix = /^(?:a|b)\/\//u.test(value) ? value.slice(0, 2) : '';
  const path = prefix ? value.slice(2) : value;
  const projected = projectPath(path, state);
  return prefix ? `${prefix}${projected}` : projected;
}

function projectAbsoluteHeaderTokens(value: string, state: ProjectionState): string {
  return value.replace(
    ABSOLUTE_HEADER_TOKEN,
    (_match, prefix: string, quotedPath: string | undefined, barePath: string | undefined) => {
      const path = quotedPath ?? barePath!;
      const projected = projectDiffHeaderToken(path, state);
      return `${prefix}${quotedPath === undefined ? projected : `"${projected}"`}`;
    },
  );
}

function projectDiffText(value: string, state: ProjectionState): string {
  const parts = value.split(/(\r?\n)/u);
  let hunk: { old: number; next: number } | 'opaque' | null = null;
  let expectNewHeader = false;
  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index] ?? '';
    const nextLine = parts[index + 2] ?? '';
    if (line.startsWith('diff --git ')) {
      hunk = null;
      parts[index] = projectAbsoluteHeaderTokens(line, state);
      expectNewHeader = false;
      continue;
    }
    const singlePathPrefix = [
      'diff --cc ', 'diff --combined ', 'Index: ',
      'rename from ', 'rename to ', 'copy from ', 'copy to ',
    ].find((prefix) => line.startsWith(prefix));
    if (singlePathPrefix) {
      hunk = null;
      parts[index] = `${singlePathPrefix}${projectHeaderPath(line.slice(singlePathPrefix.length), state)}`;
      expectNewHeader = false;
      continue;
    }
    if (/^(?:Binary files|Files|Only in) /u.test(line)) {
      hunk = null;
      parts[index] = projectAbsoluteHeaderTokens(line, state);
      expectNewHeader = false;
      continue;
    }
    const hunkHeader = HUNK_HEADER.exec(line);
    if (hunkHeader) {
      hunk = {
        old: hunkHeader[1] === undefined ? 1 : Number(hunkHeader[1]),
        next: hunkHeader[2] === undefined ? 1 : Number(hunkHeader[2]),
      };
      expectNewHeader = false;
      continue;
    }
    if (line.startsWith('@@@ ')) {
      hunk = 'opaque';
      expectNewHeader = false;
      continue;
    }
    if (hunk) {
      if (hunk !== 'opaque' && line !== '\\ No newline at end of file') {
        if (line.startsWith(' ')) { hunk.old -= 1; hunk.next -= 1; }
        else if (line.startsWith('-')) hunk.old -= 1;
        else if (line.startsWith('+')) hunk.next -= 1;
        if (hunk.old <= 0 && hunk.next <= 0) hunk = null;
      }
      continue;
    }
    if (line === 'GIT binary patch') {
      hunk = 'opaque';
      expectNewHeader = false;
      continue;
    }
    if (line.startsWith('--- ') && nextLine.startsWith('+++ ')) {
      parts[index] = `--- ${projectHeaderPath(line.slice(4), state)}`;
      expectNewHeader = true;
      continue;
    }
    if (expectNewHeader && line.startsWith('+++ ')) {
      parts[index] = `+++ ${projectHeaderPath(line.slice(4), state)}`;
      expectNewHeader = false;
      continue;
    }
    expectNewHeader = false;
  }
  return replaceRoots(parts.join(''), state);
}

function isPathKey(key: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  return /(?:^|_)(?:cwd|directory|file|path|root)$/.test(normalized);
}

function isDiffKey(key: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  return /(?:^|_)(?:diff|patch)$/.test(normalized);
}

function projectValue(
  value: unknown,
  state: ProjectionState,
  depth: number,
  key: string | null,
): JsonValue {
  state.nodes += 1;
  if (state.nodes > SESSION_EVENT_MAX_JSON_NODES || depth > SESSION_EVENT_MAX_JSON_DEPTH) {
    return OMITTED_DEPTH;
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    if (key && BINARY_KEY.test(key)) return OMITTED_BINARY;
    const projected = key && isPathKey(key)
      ? projectPath(value, state)
      : key && isDiffKey(key) ? projectDiffText(value, state) : replaceRoots(value, state);
    return truncateUtf8(projected, 128 * 1024);
  }
  if (Array.isArray(value)) {
    return value.map((item) => projectValue(item, state, depth + 1, null));
  }
  if (typeof value !== 'object') return null;
  const output: Record<string, JsonValue> = {};
  for (const [entryKey, item] of Object.entries(value)) {
    if (CONTROL.test(entryKey) || Buffer.byteLength(entryKey, 'utf8') > 256) continue;
    if (entryKey === 'attachments') {
      output[entryKey] = [];
    } else {
      output[entryKey] = projectValue(item, state, depth + 1, entryKey);
    }
  }
  return output;
}

export function projectSessionJson(
  value: unknown,
  options: SessionEventProjectionOptions,
): JsonValue {
  const state: ProjectionState = {
    nodes: 0,
    workspaceRoot: resolve(options.workspaceRoot),
    privateRoots: options.privateRoots.map((root) => resolve(root))
      .filter((root) => root !== resolve(options.workspaceRoot))
      .sort((left, right) => right.length - left.length),
  };
  const projected = projectValue(value, state, 0, null);
  if (Buffer.byteLength(JSON.stringify(projected), 'utf8') > SESSION_EVENT_MAX_PAYLOAD_BYTES) {
    return { notice: OMITTED_SIZE };
  }
  return projected;
}

export function projectSessionText(
  value: string,
  options: SessionEventProjectionOptions,
): string {
  return projectDiffText(value, {
    nodes: 0,
    workspaceRoot: resolve(options.workspaceRoot),
    privateRoots: options.privateRoots.map((root) => resolve(root))
      .filter((root) => root !== resolve(options.workspaceRoot))
      .sort((left, right) => right.length - left.length),
  });
}

export function projectSessionEvents(
  records: readonly StoredAgentEvent[],
  session: SessionRecord,
  limit: number,
  options: SessionEventProjectionOptions,
): { events: SessionEventDto[]; truncated: boolean } {
  const events: SessionEventDto[] = [];
  let usedBytes = 64;
  let truncated = records.length > limit;
  for (const record of records.slice(0, limit)) {
    const projected: SessionEventDto = {
      id: record.id,
      sessionId: session.id,
      agentId: session.agentId,
      kind: record.kind,
      payload: projectSessionJson(record.payload, options),
      ts: record.ts,
    };
    const eventBytes = Buffer.byteLength(JSON.stringify(projected), 'utf8') + 1;
    if (usedBytes + eventBytes > SESSION_EVENT_MAX_RESPONSE_BYTES) {
      truncated = true;
      break;
    }
    usedBytes += eventBytes;
    events.push(projected);
  }
  return { events, truncated };
}
