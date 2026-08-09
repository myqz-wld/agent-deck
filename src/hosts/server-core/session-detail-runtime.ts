import { isAbsolute, relative, resolve, sep } from 'node:path';

import {
  AgentDeckClientErrorCode,
  isCoreMethodAllowed,
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
import { ServerCoreSessionImageAssetReader } from './session-image-asset';

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
    getPayload(sessionId: string, id: number): FileChangePayload | null;
  };
  readonly getFinalDiff: (sessionId: string, filePath: string) => Promise<FileFinalDiffResult>;
  readonly privateRoots?: readonly string[];
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

  constructor(
    private readonly base: DaemonCoreRuntime,
    private readonly options: ServerCoreSessionDetailRuntimeOptions,
  ) {
    this.supportedMethods = supportedMethods(base);
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.imageAssets = new ServerCoreSessionImageAssetReader(
      this.workspaceRoot,
      options.fileChanges,
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
    if (!isCoreMethodAllowed(input.access.surface, input.method)) {
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
    const cwd = resolve(session.cwd);
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
        content: truncateUtf8(record.content, SESSION_DETAIL_MAX_SUMMARY_BYTES),
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
      tasks: this.options.tasks.listForSession(params.sessionId, params.limit),
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
    const items = page.items
      .filter((item) => item.kind === 'text' || item.kind === 'image')
      .map((item): SessionFileChangeSummaryDto => ({
        ...item,
        filePath: this.publicPath(session, item.filePath),
      }));
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
    const stored = this.options.fileChanges.getPayload(params.sessionId, params.changeId);
    const revision = await this.revision(input);
    const change = stored?.kind === 'text'
      ? this.publicPayload(session, stored)
      : stored?.kind === 'image'
        ? this.publicImagePayload(session, stored)
        : null;
    const result = parseSessionFileChangeGetResult(
      { change, revision }, params.sessionId, params.changeId,
    );
    return this.result(result, revision);
  }

  private async getFinalDiff(input: DaemonRequestInput): Promise<DaemonRequestResult> {
    const params = parseSessionFileFinalDiffParams(input.params);
    this.requireSession(params.sessionId);
    const absolutePath = resolve(this.workspaceRoot, params.filePath);
    if (!inside(this.workspaceRoot, absolutePath)) {
      throw new DaemonRequestError(AgentDeckClientErrorCode.AccessDenied, 'File is outside Workspace');
    }
    const stored = await this.options.getFinalDiff(params.sessionId, absolutePath);
    const revision = await this.revision(input);
    const fileDiff = this.publicFinalDiff(params.filePath, stored);
    const result = parseSessionFileFinalDiffResult({ fileDiff, revision }, params.filePath);
    return this.result(result, revision);
  }

  private publicPath(session: SessionRecord, value: string): string {
    const target = resolve(isAbsolute(value) ? value : resolve(session.cwd, value));
    if (!inside(this.workspaceRoot, target)) {
      throw new DaemonRequestError(AgentDeckClientErrorCode.AccessDenied, 'File is outside Workspace');
    }
    const projected = relative(this.workspaceRoot, target).split(sep).join('/');
    if (!projected) {
      throw new DaemonRequestError(AgentDeckClientErrorCode.InvalidRequest, 'File path is invalid');
    }
    return projected;
  }

  private publicPayload(
    session: SessionRecord,
    stored: FileChangePayload,
  ): SessionFileChangePayloadDto {
    return {
      id: stored.id,
      sessionId: stored.sessionId,
      filePath: this.publicPath(session, stored.filePath),
      kind: stored.kind,
      beforeBlob: stored.beforeBlob,
      afterBlob: stored.afterBlob,
      beforeSnapshot: stored.beforeSnapshot ?? null,
      afterSnapshot: stored.afterSnapshot ?? null,
      metadata: this.publicMetadata(stored.metadata),
      toolCallId: stored.toolCallId,
      ts: stored.ts,
    };
  }

  private publicImagePayload(
    session: SessionRecord,
    stored: FileChangePayload,
  ): SessionFileChangePayloadDto {
    return {
      id: stored.id,
      sessionId: stored.sessionId,
      filePath: this.publicPath(session, stored.filePath),
      kind: 'image',
      beforeBlob: this.imageAssets.publicHandle(stored, 'before'),
      afterBlob: this.imageAssets.publicHandle(stored, 'after'),
      beforeSnapshot: null,
      afterSnapshot: null,
      metadata: this.publicMetadata(stored.metadata),
      toolCallId: stored.toolCallId,
      ts: stored.ts,
    };
  }

  private async readImageAsset(input: DaemonRequestInput): Promise<DaemonRequestResult> {
    const params = parseSessionImageAssetReadParams(input.params);
    this.requireSession(params.sessionId);
    const payload = await this.imageAssets.read(params, input.signal);
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
