/**
 * 跨进程共享：文件改动 / Diff payload / Image 工具结果类型。
 */

export interface FileChangeRecord {
  id: number;
  sessionId: string;
  filePath: string;
  kind: string; // 'text' | 'image' | 'pdf' | ...
  beforeBlob: string | null;
  afterBlob: string | null;
  /** Best-effort full text snapshot captured when the change was recorded. */
  beforeSnapshot?: string | null;
  /** Best-effort full text snapshot captured when the change was recorded. */
  afterSnapshot?: string | null;
  metadata: Record<string, unknown>;
  toolCallId: string | null;
  ts: number;
}

/** Lightweight list item. Large blobs, snapshots, and metadata stay behind payload lookup. */
export interface FileChangeSummary {
  id: number;
  sessionId: string;
  filePath: string;
  kind: string;
  toolCallId: string | null;
  hasBeforeBlob: boolean;
  hasAfterBlob: boolean;
  hasBeforeSnapshot: boolean;
  hasAfterSnapshot: boolean;
  /** Internal ingestion-time authority. Never include this field in renderer/Core DTOs. */
  pathAuthority?: string | null;
  ts: number;
}

/** Full data for one selected change, loaded only after a session-bound id lookup. */
export type FileChangePayload = FileChangeRecord;

export interface FileChangePage {
  items: FileChangeSummary[];
  /** Opaque keyset cursor based on the last raw row scanned. */
  nextCursor: string | null;
}

export type FileFinalDiffReason =
  | 'not_in_session'
  | 'unchanged'
  | 'too_large'
  | 'snapshot_unavailable';

export interface FileFinalDiffResult {
  ok: boolean;
  filePath: string;
  diff: string | null;
  source: 'recorded-snapshot' | 'recorded-patch-fallback';
  reason?: FileFinalDiffReason;
  message?: string;
}

export interface DiffPayload<T = unknown> {
  kind: string;
  filePath: string;
  before: T | null;
  after: T | null;
  metadata?: Record<string, unknown>;
  toolCallId?: string;
  ts: number;
}

// ───────────────────────────────────────────────────────── Image file changes

/**
 * 图片在事件流 / DiffPayload 里的承载形态。图片二进制不进入事件，只记录本地授权路径
 * 或不暴露 Worker 路径的 Remote opaque handle。
 */
export type ImageSource =
  | { kind: 'path'; path: string }
  /** Opaque Remote handle. It never contains a Worker path or asset credential. */
  | { kind: 'remote-file-change'; changeId: number; side: 'before' | 'after' };

/**
 * window.api.loadImageBlob 的返回结构。
 * 失败不抛错，由 UI 显示「图片不可读」灰底。
 */
export type LoadImageBlobResult =
  | { ok: true; dataUrl: string; mime: string; bytes: number }
  | {
      ok: false;
      reason: 'changed' | 'enoent' | 'too_big' | 'denied' | 'invalid_ext' | 'io_error' | 'unsupported_source';
      detail?: string;
    };
