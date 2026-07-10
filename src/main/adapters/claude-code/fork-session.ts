import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join, normalize, resolve } from 'node:path';
import { readFile, readdir, realpath } from 'node:fs/promises';
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ForkedSessionHandle, ForkSessionSource } from '../types';
import { loadSdk } from './sdk-loader';
import { sessionRepo } from '@main/store/session-repo';
import log from '@main/utils/logger';

const logger = log.scope('claude-native-fork');
const MAX_PROJECT_KEY_LENGTH = 200;

type JsonObject = Record<string, unknown>;

export interface ClaudeTranscriptEntry extends JsonObject {
  type?: unknown;
  uuid?: unknown;
  message?: unknown;
}

interface ClaudeForkSdk {
  getSessionMessages(
    sessionId: string,
    options: { dir: string },
  ): Promise<SessionMessage[]>;
  forkSession(
    sessionId: string,
    options: { dir: string; upToMessageId: string; title: string },
  ): Promise<{ sessionId: string }>;
  deleteSession(sessionId: string, options: { dir: string }): Promise<void>;
}

interface ChildSessionStore {
  get(sessionId: string): { cliSessionId?: string | null } | null;
  delete(sessionId: string): void;
}

export interface CreateClaudeFamilyForkArgs {
  source: ForkSessionSource;
  providerName: string;
  createChild(forkedNativeSessionId: string): Promise<string>;
  closeChild(sessionId: string): Promise<void>;
  /** Coordinated application deletion; production uses SessionManager to emit removal events. */
  deleteChild?(sessionId: string): Promise<void>;
  /** Test seam. Production always loads the installed SDK through sdk-loader. */
  sdk?: ClaudeForkSdk;
  /** Test seam for an isolated Claude config root. */
  configRoot?: string;
  /** Test seam for child-only application-row cleanup. */
  childSessionStore?: ChildSessionStore;
}

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

/**
 * Parse only newline-terminated JSONL records. A concurrently appended trailing fragment is
 * deliberately ignored, even if it happens to be temporarily parseable.
 */
export function parseCompleteClaudeJsonl(text: string): ClaudeTranscriptEntry[] {
  const lastNewline = text.lastIndexOf('\n');
  if (lastNewline < 0) return [];

  const entries: ClaudeTranscriptEntry[] = [];
  for (const line of text.slice(0, lastNewline).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const entry = asObject(parsed);
      if (entry) entries.push(entry as ClaudeTranscriptEntry);
    } catch {
      // Match the SDK transcript reader: an isolated malformed record does not poison the chain.
    }
  }
  return entries;
}

function hasOwn(entry: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(entry, key);
}

function hasQueryingOrigin(entry: ClaudeTranscriptEntry): boolean {
  const origin = entry.origin;
  if (origin === undefined || origin === null) return true;
  if (typeof origin === 'string') {
    const kind = origin.trim().toLowerCase();
    return kind === 'human' || kind === 'user' || kind === 'peer' || kind === 'channel' || kind === 'coordinator';
  }
  const originObject = asObject(origin);
  if (!originObject || typeof originObject.kind !== 'string') return false;
  const kind = originObject.kind.trim().toLowerCase();
  return kind === 'human' || kind === 'user' || kind === 'peer' || kind === 'channel' || kind === 'coordinator';
}

function hasNonToolResultContent(entry: ClaudeTranscriptEntry): boolean {
  const message = asObject(entry.message);
  const content = message?.content;
  if (typeof content === 'string') return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    if (typeof block === 'string') return block.trim().length > 0;
    const value = asObject(block);
    return value !== null && typeof value.type === 'string' && value.type !== 'tool_result';
  });
}

function isSafeTopLevelUser(
  activeMessage: SessionMessage,
  entry: ClaudeTranscriptEntry,
): boolean {
  if (activeMessage.type !== 'user' || entry.type !== 'user') return false;
  if (entry.isSynthetic === true || entry.shouldQuery === false) return false;
  if (entry.isMeta === true || entry.isSidechain === true || entry.teamName !== undefined) {
    return false;
  }
  if (!hasQueryingOrigin(entry)) return false;
  if (hasOwn(entry, 'tool_use_result') || hasOwn(entry, 'toolUseResult')) return false;

  const rawParentToolUseId = entry.parent_tool_use_id ?? entry.parentToolUseId;
  if (rawParentToolUseId !== undefined && rawParentToolUseId !== null) return false;
  if (activeMessage.parent_tool_use_id !== null) return false;
  return hasNonToolResultContent(entry);
}

/** Select the latest safe user UUID from SDK active-chain order plus raw provenance. */
export function selectClaudeForkBoundary(
  activeMessages: readonly SessionMessage[],
  rawEntries: readonly ClaudeTranscriptEntry[],
): string | null {
  const rawByUuid = new Map<string, ClaudeTranscriptEntry>();
  for (const entry of rawEntries) {
    if (typeof entry.uuid === 'string') rawByUuid.set(entry.uuid, entry);
  }

  for (let index = activeMessages.length - 1; index >= 0; index -= 1) {
    const activeMessage = activeMessages[index];
    if (activeMessage.type !== 'user') continue;
    const entry = rawByUuid.get(activeMessage.uuid);
    // A newer active user without complete raw provenance may be the current request. Falling
    // through to an older user would silently lose it, so fail closed instead.
    if (!entry) return null;
    if (isSafeTopLevelUser(activeMessage, entry)) return activeMessage.uuid;
  }
  return null;
}

export function getClaudeConfigRoot(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return (env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')).normalize('NFC');
}

function projectKeyHash(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

/** Mirrors the installed SDK's project-bucket sanitization, including long-path hashing. */
export function encodeClaudeSdkProjectKey(cwd: string): string {
  const sanitized = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  if (sanitized.length <= MAX_PROJECT_KEY_LENGTH) return sanitized;
  return `${sanitized.slice(0, MAX_PROJECT_KEY_LENGTH)}-${projectKeyHash(cwd)}`;
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return normalize(await realpath(path));
  } catch {
    return normalize(resolve(path));
  }
}

function listGitWorktrees(cwd: string): Promise<string[]> {
  return new Promise((done) => {
    execFile(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.fsmonitor=',
        'worktree',
        'list',
        '--porcelain',
      ],
      { cwd, encoding: 'utf8', timeout: 5_000, windowsHide: true },
      (error, stdout) => {
        if (error) {
          done([]);
          return;
        }
        done(
          String(stdout)
            .split('\n')
            .filter((line) => line.startsWith('worktree '))
            .map((line) => normalize(line.slice('worktree '.length))),
        );
      },
    );
  });
}

async function projectDirectoriesForPath(projectsRoot: string, cwd: string): Promise<string[]> {
  const key = encodeClaudeSdkProjectKey(cwd);
  const exact = join(projectsRoot, key);
  const directories = [exact];
  if (key.length <= MAX_PROJECT_KEY_LENGTH) return directories;

  const prefix = `${key.slice(0, MAX_PROJECT_KEY_LENGTH)}-`;
  try {
    for (const entry of await readdir(projectsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
      const candidate = join(projectsRoot, entry.name);
      if (candidate !== exact) directories.push(candidate);
    }
  } catch {
    // The caller reports a provider-specific transcript error below.
  }
  return directories;
}

async function orderedTranscriptPaths(
  configRoot: string,
  cwd: string,
  nativeSessionId: string,
): Promise<string[]> {
  const projectsRoot = join(configRoot, 'projects');
  const canonicalCwd = await canonicalPath(cwd);
  const relatedPaths = [canonicalCwd, ...(await listGitWorktrees(canonicalCwd))];
  const seen = new Set<string>();
  const paths: string[] = [];

  for (const relatedPath of relatedPaths) {
    const normalizedPath = await canonicalPath(relatedPath);
    for (const projectDirectory of await projectDirectoriesForPath(projectsRoot, normalizedPath)) {
      const transcriptPath = join(projectDirectory, `${nativeSessionId}.jsonl`);
      if (seen.has(transcriptPath)) continue;
      seen.add(transcriptPath);
      paths.push(transcriptPath);
    }
  }
  return paths;
}

async function readCorrespondingTranscript(
  configRoot: string,
  source: ForkSessionSource,
  activeMessages: readonly SessionMessage[],
): Promise<ClaudeTranscriptEntry[]> {
  // Raw provenance is required through every active user frame. The assistant/tool tail may be
  // concurrently appended and intentionally absent from the last complete JSONL record.
  const activeUserUuids = new Set(
    activeMessages.filter((message) => message.type === 'user').map((message) => message.uuid),
  );
  const orderedPaths = await orderedTranscriptPaths(
    configRoot,
    source.cwd,
    source.nativeSessionId,
  );
  for (const transcriptPath of orderedPaths) {
    let text: string;
    try {
      text = await readFile(transcriptPath, 'utf8');
    } catch {
      continue;
    }
    if (text.length === 0) continue;
    const entries = parseCompleteClaudeJsonl(text);
    if (countActiveUuidMatches(entries, activeUserUuids) === activeUserUuids.size) return entries;
    throw new Error(
      'Cannot fork the Claude-family session: the SDK-selected raw transcript does not contain ' +
        'the complete active conversation chain. Use contextMode "fresh".',
    );
  }

  // If git discovery is unavailable, find the SDK-selected transcript by active UUID overlap.
  const projectsRoot = join(configRoot, 'projects');
  const completeCandidates: ClaudeTranscriptEntry[][] = [];
  let partialCandidateSeen = false;
  try {
    for (const entry of await readdir(projectsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const transcriptPath = join(projectsRoot, entry.name, `${source.nativeSessionId}.jsonl`);
      let transcript: string;
      try {
        transcript = await readFile(transcriptPath, 'utf8');
      } catch {
        continue;
      }
      const entries = parseCompleteClaudeJsonl(transcript);
      const matches = countActiveUuidMatches(entries, activeUserUuids);
      if (matches === activeUserUuids.size) completeCandidates.push(entries);
      else if (matches > 0) partialCandidateSeen = true;
    }
  } catch {
    // Fall through to the provider-specific error below.
  }
  if (completeCandidates.length === 1) return completeCandidates[0];
  if (completeCandidates.length > 1) {
    throw new Error(
      'Cannot fork the Claude-family session: multiple raw transcripts match the complete active ' +
        'chain, so the SDK-selected provenance is ambiguous. Use contextMode "fresh".',
    );
  }
  if (partialCandidateSeen) {
    throw new Error(
      'Cannot fork the Claude-family session: only partial raw-transcript matches were found for ' +
        'the active chain. Use contextMode "fresh".',
    );
  }
  throw new Error(
    'Cannot fork the Claude-family session: the raw transcript was not found under ' +
      `${join(configRoot, 'projects')}. Use contextMode "fresh".`,
  );
}

function countActiveUuidMatches(
  entries: readonly ClaudeTranscriptEntry[],
  activeUuids: ReadonlySet<string>,
): number {
  const matched = new Set<string>();
  for (const entry of entries) {
    if (typeof entry.uuid === 'string' && activeUuids.has(entry.uuid)) matched.add(entry.uuid);
  }
  return matched.size;
}

async function resolveForkBoundary(
  sdk: ClaudeForkSdk,
  source: ForkSessionSource,
  configRoot: string,
  providerName: string,
): Promise<string> {
  const activeMessages = await sdk.getSessionMessages(source.nativeSessionId, { dir: source.cwd });
  if (activeMessages.length === 0) {
    throw new Error(
      `Cannot fork ${providerName}: the provider returned no active conversation chain. ` +
        'Use contextMode "fresh".',
    );
  }
  const rawEntries = await readCorrespondingTranscript(configRoot, source, activeMessages);
  const boundary = selectClaudeForkBoundary(activeMessages, rawEntries);
  if (!boundary) {
    throw new Error(
      `Cannot fork ${providerName}: no safe real top-level user message exists before the ` +
        'active assistant/tool frame. Use contextMode "fresh".',
    );
  }
  return boundary;
}

/** Materialize, resume, and own a Claude-family native child with child-only rollback. */
export async function createClaudeFamilyForkedSession(
  args: CreateClaudeFamilyForkArgs,
): Promise<ForkedSessionHandle> {
  const sdk: ClaudeForkSdk = args.sdk ?? (await loadSdk());
  const store = args.childSessionStore ?? sessionRepo;
  const configRoot = args.configRoot ?? getClaudeConfigRoot();
  const boundary = await resolveForkBoundary(sdk, args.source, configRoot, args.providerName);
  const forked = await sdk.forkSession(args.source.nativeSessionId, {
    dir: args.source.cwd,
    upToMessageId: boundary,
    title: 'Agent Deck fork',
  });
  const forkedNativeId = forked.sessionId;
  if (
    typeof forkedNativeId !== 'string' ||
    forkedNativeId.trim().length === 0 ||
    forkedNativeId === args.source.nativeSessionId ||
    forkedNativeId === args.source.applicationSessionId
  ) {
    throw new Error(
      `${args.providerName} native fork returned an invalid or source identity; refusing to ` +
        'resume or mutate it.',
    );
  }

  const applicationChildIds = new Set([forkedNativeId]);
  const nativeChildIds = new Set([forkedNativeId]);
  const sourceIds = new Set([
    args.source.applicationSessionId,
    args.source.nativeSessionId,
  ]);
  let cleanupPromise: Promise<void> | null = null;
  const cleanup = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      for (const childId of applicationChildIds) {
        if (childId === args.source.applicationSessionId) continue;
        try {
          const record = store.get(childId);
          if (
            record?.cliSessionId &&
            !sourceIds.has(record.cliSessionId)
          ) {
            nativeChildIds.add(record.cliSessionId);
          }
        } catch (error) {
          logger.warn(`[${args.providerName}] failed to inspect fork child row ${childId}`, error);
        }
      }
      for (const childId of applicationChildIds) {
        if (childId === args.source.applicationSessionId) continue;
        try {
          await args.closeChild(childId);
        } catch (error) {
          logger.warn(`[${args.providerName}] failed to close fork child ${childId}`, error);
        }
      }
      for (const childId of applicationChildIds) {
        if (childId === args.source.applicationSessionId) continue;
        try {
          if (args.deleteChild) {
            await args.deleteChild(childId);
          } else {
            store.delete(childId);
          }
        } catch (error) {
          logger.warn(`[${args.providerName}] failed to delete fork child row ${childId}`, error);
        }
      }
      for (const nativeId of nativeChildIds) {
        if (sourceIds.has(nativeId)) continue;
        try {
          await sdk.deleteSession(nativeId, { dir: args.source.cwd });
        } catch (error) {
          logger.warn(`[${args.providerName}] failed to delete fork transcript ${nativeId}`, error);
        }
      }
    })();
    return cleanupPromise;
  };

  try {
    const childId = await args.createChild(forkedNativeId);
    if (
      typeof childId !== 'string' ||
      childId.trim().length === 0 ||
      childId === args.source.applicationSessionId ||
      childId === args.source.nativeSessionId
    ) {
      throw new Error(
        `${args.providerName} fork resumed as the source identity; refusing to mutate it.`,
      );
    }
    applicationChildIds.add(childId);
    const childRecord = store.get(childId);
    if (
      childRecord?.cliSessionId &&
      !sourceIds.has(childRecord.cliSessionId)
    ) {
      nativeChildIds.add(childRecord.cliSessionId);
    }
    return { sessionId: childId, discard: cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
