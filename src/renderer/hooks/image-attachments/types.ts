import type { UploadedAttachmentInput } from '@shared/types';

export interface UploadedAttachmentEntry {
  id: string;
  /** A small thumbnail data URL or a revocable blob URL, never the full base64 payload. */
  thumbnailDataUrl: string;
  mime: string;
  bytes: number;
  name?: string;
  originalBytes?: number;
}

export interface AttachmentSendSnapshot {
  attachments: UploadedAttachmentEntry[];
  inputs: UploadedAttachmentInput[];
}

export interface ImageAttachmentLimits {
  maxBytesEach: number;
  maxBytesTotal: number;
  maxCount: number;
  mimeTypes: readonly string[];
}

export interface UseImageAttachmentsResult {
  attachments: UploadedAttachmentEntry[];
  error: string | null;
  add: (files: FileList | File[] | null | undefined) => Promise<void>;
  remove: (id: string) => void;
  clear: () => void;
  onPaste: (event: React.ClipboardEvent) => void;
  onDrop: (event: React.DragEvent) => void;
  onDragOver: (event: React.DragEvent) => void;
  toIpcInputs: () => UploadedAttachmentInput[];
  snapshotForSend: () => AttachmentSendSnapshot;
  releasePayloads: (ids: readonly string[]) => void;
  getPreviewDataUrl: (id: string) => string | null;
  dismissError: () => void;
}
