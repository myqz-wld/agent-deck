import type {
  FileChangePage,
  FileChangePayload,
  FileChangeSummary,
  FileFinalDiffResult,
  LoadImageBlobResult,
  SessionRecord,
  StoredAgentEvent,
  SummaryRecord,
  TaskRecord,
} from '@shared/types';

export interface ServerCoreSessionDetailRuntimeOptions {
  readonly eventImages?: {
    authorized(sessionId: string, imageId: string): boolean;
    load(sessionId: string, imageId: string): Promise<LoadImageBlobResult>;
  };
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
