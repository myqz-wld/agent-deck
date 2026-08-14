import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import {
  AgentDeckClientErrorCode,
  isCoreMethodGranted,
  isJsonObject,
  isJsonValue,
  parseSessionFileChangeGetParams,
  parseSessionFileChangeGetResult,
  parseSessionFileChangeListParams,
  parseSessionFileChangeListResult,
  parseSessionFileFinalDiffParams,
  parseSessionFileFinalDiffResult,
  parseSessionImageAssetReadParams,
  parseSessionImageAssetReadResult,
  parseSessionEventListParams,
  parseSessionEventListResult,
  parseSessionSummaryListParams,
  parseSessionSummaryListResult,
  parseSessionTaskListParams,
  parseSessionTaskListResult,
  SESSION_DETAIL_MAX_FINAL_DIFF_BYTES,
  SESSION_DETAIL_MAX_SUMMARY_BYTES,
  SessionConsoleContractError,
  type CoreMethod,
  type JsonObject,
  type SessionFileChangePayloadDto,
  type SessionFileChangeSummaryDto,
  type SessionFileFinalDiffDto,
  type SessionSummaryDto,
} from '@contracts/index';
import {
  DaemonRequestError,
  type DaemonCoreRuntime,
  type DaemonEventSubscriptionInput,
  type DaemonRequestInput,
  type DaemonRequestResult,
} from '@hosts/daemon';
import type {
  FileChangePage,
  FileChangePayload,
  FileChangeSummary,
  FileFinalDiffResult,
  SessionRecord,
  SummaryRecord,
  TaskRecord,
  StoredAgentEvent,
} from '@shared/types';
import {
  projectSessionEvents,
  projectSessionJson,
  projectSessionText,
} from './session-event-projection';
import {
  fileChangePayloadMatchesDescriptor,
  ServerCoreSessionImageAssetReader,
} from './session-image-asset';
import { projectSessionFilePath } from './session-file-path-authority';
import { withoutStoredFileChangePathAuthority } from '@shared/file-change-path-authority';

export const SERVER_CORE_SESSION_DETAIL_METHODS = Object.freeze([
  'session.summaries.list',
  'session.events.list',
  'session.file-changes.list',
  'session.file-changes.get',
  'session.file-changes.final-diff',
  'session.assets.image-chunk.read',
  'session.tasks.list',
] as const satisfies readonly CoreMethod[]);

type SessionDetailMethod = (typeof SERVER_CORE_SESSION_DETAIL_METHODS)[number];

export interface ServerCoreSessionDetailRuntimeOptions {
  readonly workspaceRoot: string;
  readonly sessions: { get(sessionId: string): SessionRecord | null };
  readonly summaries: { listForSession(sessionId: string, limit: number): SummaryRecord[] };
  readonly events: {
    listValidForSession(sessionId: string, limit: number, offset: number): StoredAgentEvent[];
  };
  readonly tasks: { listForSession(sessionId: string, limit: number): TaskRecord[] };
  readonly fileChanges: {
    listSummaryPage(
      sessionId: string,
      options: { cursor?: string | null; limit: number },
    ): FileChangePage;
    getDescriptor(sessionId: string, id: number): FileChangeSummary | null;
    getPathDescriptor(sessionId: string, candidates: string[]): FileChangeSummary | null;
    getPayload(sessionId: string, id: number): FileChangePayload | null;
  };
  readonly getFinalDiff: (
    sessionId: string,
    filePath: string,
    pathAuthority: string,
  ) => Promise<FileFinalDiffResult>;
  readonly privateRoots?: readonly string[];
  readonly canonicalizePath?: (path: string) => string;
}

function isSessionDetailMethod(method: CoreMethod): method is SessionDetailMethod {
  return (SERVER_CORE_SESSION_DETAIL_METHODS as readonly CoreMethod[]).includes(method);
}

function supportedMethods(base: DaemonCoreRuntime): readonly CoreMethod[] {
  return Object.freeze([...new Set([...base.supportedMethods, ...SERVER_CORE_SESSION_DETAIL_METHODS])]);
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function isMissingPath(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    'code' in error && error.code === 'ENOENT';
}

function truncateUtf8(value: string, maximum: number): string {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.byteLength <= maximum) return value;
  const marker = '\n…[remote view truncated]';
  const markerBytes = Buffer.byteLength(marker);
  let cut = Math.max(0, maximum - markerBytes);
  while (cut > 0 && (encoded[cut] & 0xc0) === 0x80) cut -= 1;
  return `${encoded.subarray(0, cut).toString('utf8')}${marker}`;
}

/** Adds bounded, cwd-free detail reads around the authoritative Core repositories. */
export class ServerCoreSessionDetailRuntime implements DaemonCoreRuntime {
  readonly supportedMethods: readonly CoreMethod[];
  readonly subscribe?: DaemonCoreRuntime['subscribe'];
  private readonly workspaceRoot: string;
  private readonly imageAssets: ServerCoreSessionImageAssetReader;
  private readonly canonicalizePath: (path: string) => string;

  constructor(
    private readonly base: DaemonCoreRuntime,
    private readonly options: ServerCoreSessionDetailRuntimeOptions,
  ) {
    this.supportedMethods = supportedMethods(base);
    this.canonicalizePath = options.canonicalizePath ?? realpathSync;
    const configuredWorkspaceRoot = resolve(options.workspaceRoot);
    try {
      this.workspaceRoot = this.canonicalizePath(configuredWorkspaceRoot);
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      // A newly provisioned Worker may start before its Workspace mount exists. Keep the
      // resolved configured identity so bootstrap succeeds; every actual session read still
      // requires a canonical cwd and therefore fails closed until the root exists unchanged.
      this.workspaceRoot = configuredWorkspaceRoot;
    }
    this.imageAssets = new ServerCoreSessionImageAssetReader(
      this.workspaceRoot,
      options.fileChanges,
      this.canonicalizePath,
    );
    if (base.subscribe) {
      const subscribe = base.subscribe.bind(base);
      this.subscribe = (input: DaemonEventSubscriptionInput) => subscribe(input);
    }
  }

  start(): Promise<void> {
    return this.base.start();
  }

  stop(reason: string): Promise<void> {
    return this.base.stop(reason);
  }

  currentRevision(...args: Parameters<DaemonCoreRuntime['currentRevision']>): Promise<number> | number {
    return this.base.currentRevision(...args);
  }

  async execute(input: DaemonRequestInput): Promise<DaemonRequestResult> {
    if (!isSessionDetailMethod(input.method)) return this.base.execute(input);
    if (!isCoreMethodGranted(input.access, input.method)) {
      throw new DaemonRequestError(AgentDeckClientErrorCode.AccessDenied, 'Request rejected');
    }
    if (input.signal.aborted) {
      throw new DaemonRequestError(AgentDeckClientErrorCode.Cancelled, 'Request was cancelled');
    }
    try {
      switch (input.method) {
        case 'session.summaries.list': return this.listSummaries(input);
        case 'session.events.list': return this.listEvents(input);
        case 'session.file-changes.list': return this.listFileChanges(input);
        case 'session.file-changes.get': return this.getFileChange(input);
        case 'session.file-changes.final-diff': return this.getFinalDiff(input);
        case 'session.assets.image-chunk.read': return this.readImageAsset(input);
        case 'session.tasks.list': return this.listTasks(input);
      }
    } catch (error) {
      if (error instanceof DaemonRequestError) throw error;
      if (error instanceof SessionConsoleContractError) {
        throw new DaemonRequestError(AgentDeckClientErrorCode.InvalidRequest, 'Request rejected');
      }
      throw error;
    }
  }

  private async revision(input: DaemonRequestInput): Promise<number> {
    return await this.base.currentRevision(input.access);
  }

  private result(value: unknown, revision: number): DaemonRequestResult {
    if (!isJsonValue(value)) throw new Error('Session detail result is not JSON-safe');
    return { result: value, revision };
  }

  private requireSession(sessionId: string): SessionRecord {
    const session = this.options.sessions.get(sessionId);
    if (!session) {
      throw new DaemonRequestError(AgentDeckClientErrorCode.NotFound, 'Session was not found');
    }
    let cwd: string;
    try {
      cwd = this.canonicalizePath(resolve(session.cwd));
    } catch {
      throw new DaemonRequestError(AgentDeckClientErrorCode.AccessDenied, 'Session path is unavailable');
    }
    if (!inside(this.workspaceRoot, cwd)) {
      throw new DaemonRequestError(AgentDeckClientErrorCode.AccessDenied, 'Session is outside Workspace');
    }
    return session;
  }

  private async listSummaries(input: DaemonRequestInput): Promise<DaemonRequestResult> {
    const params = parseSessionSummaryListParams(input.params);
    this.requireSession(params.sessionId);
    const revision = await this.revision(input);
    const summaries = this.options.summaries.listForSession(params.sessionId, params.limit)
      .map((record): SessionSummaryDto => ({
        ...record,
        content: truncateUtf8(this.publicText(record.content), SESSION_DETAIL_MAX_SUMMARY_BYTES),
      }));
    const result = parseSessionSummaryListResult(
      { summaries, revision },
      params.sessionId,
      params.limit,
    );
    return this.result(result, revision);
  }

  private async listEvents(input: DaemonRequestInput): Promise<DaemonRequestResult> {
    const params = parseSessionEventListParams(input.params);
    const session = this.requireSession(params.sessionId);
    const rows = this.options.events.listValidForSession(params.sessionId, params.limit + 1, 0);
    const revision = await this.revision(input);
    const projected = projectSessionEvents(rows, session, params.limit, {
      workspaceRoot: this.workspaceRoot,
      privateRoots: this.options.privateRoots ?? [],
    });
    const result = parseSessionEventListResult(
      { ...projected, revision },
      params.sessionId,
      params.limit,
    );
    return this.result(result, revision);
  }

  private async listTasks(input: DaemonRequestInput): Promise<DaemonRequestResult> {
    const params = parseSessionTaskListParams(input.params);
    this.requireSession(params.sessionId);
    const revision = await this.revision(input);
    const result = parseSessionTaskListResult({
      tasks: this.options.tasks.listForSession(params.sessionId, params.limit).map((task) => ({
        ...task,
        subject: this.publicText(task.subject),
        description: task.description === null ? null : this.publicText(task.description),
        activeForm: task.activeForm === null ? null : this.publicText(task.activeForm),
        labels: task.labels.map((label) => this.publicText(label)),
      })),
      revision,
    }, params.limit);
    return this.result(result, revision);
  }

  private async listFileChanges(input: DaemonRequestInput): Promise<DaemonRequestResult> {
    const params = parseSessionFileChangeListParams(input.params);
    const session = this.requireSession(params.sessionId);
    const page = this.options.fileChanges.listSummaryPage(params.sessionId, {
      ...(params.cursor ? { cursor: params.cursor } : {}),
      limit: params.limit,
    });
    const revision = await this.revision(input);
    const items: SessionFileChangeSummaryDto[] = [];
    for (const item of page.items) {
      if (item.kind !== 'text' && item.kind !== 'image') continue;
      const filePath = this.publicPath(session, item.filePath, item.pathAuthority);
      if (filePath === null) continue;
      const { pathAuthority: _authority, ...publicItem } = item;
      items.push({ ...publicItem, filePath });
    }
    const result = parseSessionFileChangeListResult(
      { items, nextCursor: page.nextCursor, revision },
      params.sessionId,
      params.limit,
    );
    return this.result(result, revision);
  }

  private async getFileChange(input: DaemonRequestInput): Promise<DaemonRequestResult> {
    const params = parseSessionFileChangeGetParams(input.params);
    const session = this.requireSession(params.sessionId);
    const descriptor = this.options.fileChanges.getDescriptor(params.sessionId, params.changeId);
    const revision = await this.revision(input);
    if (!descriptor || (descriptor.kind !== 'text' && descriptor.kind !== 'image')) {
      return this.result(parseSessionFileChangeGetResult(
        { change: null, revision }, params.sessionId, params.changeId,
      ), revision);
    }
    const filePath = this.publicPath(session, descriptor.filePath, descriptor.pathAuthority);
    if (filePath === null) {
      return this.result(parseSessionFileChangeGetResult(
        { change: null, revision }, params.sessionId, params.changeId,
      ), revision);
    }
    const stored = this.options.fileChanges.getPayload(params.sessionId, params.changeId);
    if (!stored || !fileChangePayloadMatchesDescriptor(descriptor, stored)) {
      return this.result(parseSessionFileChangeGetResult(
        { change: null, revision }, params.sessionId, params.changeId,
      ), revision);
    }
    const change = descriptor.kind === 'text'
      ? this.publicPayload(filePath, stored)
      : this.publicImagePayload(filePath, descriptor, stored);
    const result = parseSessionFileChangeGetResult(
      { change, revision }, params.sessionId, params.changeId,
    );
    return this.result(result, revision);
  }

  private async getFinalDiff(input: DaemonRequestInput): Promise<DaemonRequestResult> {
    const params = parseSessionFileFinalDiffParams(input.params);
    const session = this.requireSession(params.sessionId);
    const absolutePath = resolve(this.workspaceRoot, params.filePath);
    const cwd = this.canonicalizePath(resolve(session.cwd));
    const descriptor = this.options.fileChanges.getPathDescriptor(params.sessionId, [
      absolutePath,
      params.filePath,
      relative(cwd, absolutePath),
    ]);
    const publicPath = descriptor
      ? this.publicPath(session, descriptor.filePath, descriptor.pathAuthority)
      : null;
    if (
      publicPath === null || publicPath !== params.filePath ||
      typeof descriptor?.pathAuthority !== 'string'
    ) {
      const revision = await this.revision(input);
      const fileDiff: SessionFileFinalDiffDto = {
        ok: false,
        filePath: params.filePath,
        diff: null,
        source: 'recorded-snapshot',
        reason: 'not_in_session',
        message: '此文件不允许在 Remote 中显示。',
      };
      return this.result(
        parseSessionFileFinalDiffResult({ fileDiff, revision }, params.filePath),
        revision,
      );
    }
    const stored = await this.options.getFinalDiff(
      params.sessionId,
      absolutePath,
      descriptor.pathAuthority,
    );
    const revision = await this.revision(input);
    const fileDiff = this.publicFinalDiff(params.filePath, stored);
    const result = parseSessionFileFinalDiffResult({ fileDiff, revision }, params.filePath);
    return this.result(result, revision);
  }

  private publicPath(
    session: SessionRecord,
    value: string,
    pathAuthority: FileChangeSummary['pathAuthority'],
  ): string | null {
    const cwd = this.canonicalizePath(resolve(session.cwd));
    return projectSessionFilePath({
      authority: pathAuthority ?? null,
      canonicalize: this.canonicalizePath,
      cwd,
      filePath: value,
      workspaceRoot: this.workspaceRoot,
    });
  }

  private publicPayload(
    filePath: string,
    stored: FileChangePayload,
  ): SessionFileChangePayloadDto {
    return {
      id: stored.id,
      sessionId: stored.sessionId,
      filePath,
      kind: stored.kind,
      beforeBlob: stored.beforeBlob === null ? null : this.publicText(stored.beforeBlob),
      afterBlob: stored.afterBlob === null ? null : this.publicText(stored.afterBlob),
      beforeSnapshot: stored.beforeSnapshot === undefined || stored.beforeSnapshot === null
        ? null : this.publicText(stored.beforeSnapshot),
      afterSnapshot: stored.afterSnapshot === undefined || stored.afterSnapshot === null
        ? null : this.publicText(stored.afterSnapshot),
      metadata: this.publicMetadata(withoutStoredFileChangePathAuthority(stored.metadata)),
      toolCallId: stored.toolCallId,
      ts: stored.ts,
    };
  }

  private publicImagePayload(
    filePath: string,
    descriptor: FileChangeSummary,
    stored: FileChangePayload,
  ): SessionFileChangePayloadDto {
    return {
      id: stored.id,
      sessionId: stored.sessionId,
      filePath,
      kind: 'image',
      beforeBlob: this.imageAssets.publicHandle(descriptor, stored, 'before'),
      afterBlob: this.imageAssets.publicHandle(descriptor, stored, 'after'),
      beforeSnapshot: null,
      afterSnapshot: null,
      metadata: this.publicMetadata(withoutStoredFileChangePathAuthority(stored.metadata)),
      toolCallId: stored.toolCallId,
      ts: stored.ts,
    };
  }

  private async readImageAsset(input: DaemonRequestInput): Promise<DaemonRequestResult> {
    const params = parseSessionImageAssetReadParams(input.params);
    const session = this.requireSession(params.sessionId);
    const descriptor = this.options.fileChanges.getDescriptor(params.sessionId, params.changeId);
    let payload: Awaited<ReturnType<ServerCoreSessionImageAssetReader['read']>>;
    if (!descriptor || descriptor.kind !== 'image') {
      payload = { ok: false, reason: 'unsupported_source' };
    } else if (this.publicPath(
      session,
      descriptor.filePath,
      descriptor.pathAuthority,
    ) === null) {
      payload = { ok: false, reason: 'denied' };
    } else {
      payload = await this.imageAssets.read(params, input.signal, descriptor);
    }
    const revision = await this.revision(input);
    return this.result(parseSessionImageAssetReadResult(
      { ...payload, revision }, params,
    ), revision);
  }

  private publicMetadata(value: Record<string, unknown>): JsonObject {
    const projected = projectSessionJson(value, {
      workspaceRoot: this.workspaceRoot,
      privateRoots: this.options.privateRoots ?? [],
    });
    return isJsonObject(projected) ? projected : {};
  }

  private publicText(value: string): string {
    return projectSessionText(value, {
      workspaceRoot: this.workspaceRoot,
      privateRoots: this.options.privateRoots ?? [],
    });
  }

  private publicFinalDiff(
    requestedPath: string,
    stored: FileFinalDiffResult,
  ): SessionFileFinalDiffDto {
    const tooLarge = stored.diff !== null &&
      Buffer.byteLength(stored.diff, 'utf8') > SESSION_DETAIL_MAX_FINAL_DIFF_BYTES;
    if (tooLarge) {
      return {
        ok: false,
        filePath: requestedPath,
        diff: null,
        source: stored.source,
        reason: 'too_large',
        message: '记录 diff 过大，超过远程显示上限。',
      };
    }
    return {
      ok: stored.ok,
      filePath: requestedPath,
      diff: stored.diff === null ? null : this.publicText(stored.diff),
      source: stored.source,
      ...(stored.reason ? { reason: stored.reason } : {}),
      ...(stored.message ? { message: this.publicText(stored.message) } : {}),
    };
  }
}
