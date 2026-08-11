import { useCallback, useEffect, useRef } from 'react';
import { useSessionStore } from '@renderer/stores/session-store';
import {
  composerSessionFor,
  EMPTY_COMPOSER_SESSION,
} from '@renderer/stores/session-store-composer';
import {
  attachmentInputs,
  attachmentPreviewDataUrl,
  releaseAttachmentPayloads,
  storeAttachmentPayload,
} from './image-attachments/payload-sidecar';
import {
  MAX_TOTAL_ATTACHMENT_BYTES,
  processImageFile,
  validateImageFile,
} from './image-attachments/processing';
import type {
  AttachmentSendSnapshot,
  ImageAttachmentLimits,
  UploadedAttachmentEntry,
  UseImageAttachmentsResult,
} from './image-attachments/types';

export type {
  AttachmentSendSnapshot,
  ImageAttachmentLimits,
  UploadedAttachmentEntry,
  UseImageAttachmentsResult,
} from './image-attachments/types';
export {
  detectAnimatedWebp,
  isAnimatedWebpHeader,
} from './image-attachments/processing';

let attachmentIdSequence = 0;
let ephemeralSessionSequence = 0;

function nextAttachmentId(): string {
  attachmentIdSequence += 1;
  return `att-${Date.now()}-${attachmentIdSequence}`;
}

function currentComposer(sessionId: string) {
  const state = useSessionStore.getState();
  return composerSessionFor(state.composerBySession, state.composerAliases, sessionId);
}

const DEFAULT_LIMITS: ImageAttachmentLimits = Object.freeze({
  maxBytesEach: 20 * 1024 * 1024,
  maxBytesTotal: MAX_TOTAL_ATTACHMENT_BYTES,
  maxCount: 20,
  mimeTypes: Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
});

export function useImageAttachments(
  sessionId?: string,
  limits: ImageAttachmentLimits = DEFAULT_LIMITS,
): UseImageAttachmentsResult {
  const ephemeralKeyRef = useRef<string | null>(null);
  if (!sessionId && !ephemeralKeyRef.current) {
    ephemeralSessionSequence += 1;
    ephemeralKeyRef.current = `new-session-composer-${ephemeralSessionSequence}`;
  }
  const logicalSessionId = sessionId ?? ephemeralKeyRef.current!;
  const ephemeral = sessionId === undefined;
  const composer = useSessionStore((state) =>
    composerSessionFor(state.composerBySession, state.composerAliases, logicalSessionId));
  const ensureComposerSession = useSessionStore((state) => state.ensureComposerSession);
  const removeComposerState = useSessionStore((state) => state.removeComposerState);
  const updateComposer = useSessionStore((state) => state.updateComposer);

  useEffect(() => {
    ensureComposerSession(logicalSessionId, ephemeral);
    if (!ephemeral) return;
    return () => removeComposerState(logicalSessionId);
  }, [ensureComposerSession, ephemeral, logicalSessionId, removeComposerState]);

  const add = useCallback(async (
    filesIn: FileList | File[] | null | undefined,
  ): Promise<void> => {
    if (!filesIn) return;
    const files = Array.from(filesIn).filter((file): file is File => file instanceof File);
    if (files.length === 0) return;
    ensureComposerSession(logicalSessionId, ephemeral);
    const generation = currentComposer(logicalSessionId).attachmentGeneration;
    const errors: string[] = [];
    let added = false;

    for (const file of files) {
      const validationError = validateImageFile(file);
      if (validationError) {
        errors.push(`${file.name || '(未命名)'}：${validationError}`);
        continue;
      }
      if (!limits.mimeTypes.includes(file.type)) {
        errors.push(`${file.name || '(未命名)'}：当前会话不支持 ${file.type || '此图片格式'}`);
        continue;
      }
      try {
        const processed = await processImageFile(file, limits.maxBytesEach);
        const active = currentComposer(logicalSessionId);
        if (active === EMPTY_COMPOSER_SESSION || active.attachmentGeneration !== generation) {
          processed.disposePreview?.();
          continue;
        }
        if (processed.bytes > limits.maxBytesEach) {
          processed.disposePreview?.();
          errors.push(
            `${file.name}：单图超过 ${limits.maxBytesEach / 1024 / 1024}MB 上限`,
          );
          continue;
        }
        const id = nextAttachmentId();
        const entry: UploadedAttachmentEntry = {
          id,
          thumbnailDataUrl: processed.thumbnailDataUrl,
          mime: processed.mime,
          bytes: processed.bytes,
          name: processed.name,
          ...(processed.originalBytes ? { originalBytes: processed.originalBytes } : {}),
        };
        const stored = storeAttachmentPayload(logicalSessionId, id, {
          base64: processed.base64,
          mime: processed.mime,
          bytes: processed.bytes,
          disposePreview: processed.disposePreview,
        });
        if (!stored) {
          processed.disposePreview?.();
          errors.push(`${file.name}：图片暂存空间已满，请先发送或移除部分附件`);
          continue;
        }
        let committed = false;
        let rejection: string | null = null;
        updateComposer(logicalSessionId, (current) => {
          if (current.attachmentGeneration !== generation) return current;
          if (current.attachments.length >= limits.maxCount) {
            rejection = `图片数量超过 ${limits.maxCount} 张上限`;
            return current;
          }
          const currentBytes = current.attachments.reduce(
            (total, attachment) => total + attachment.bytes,
            0,
          );
          if (currentBytes + processed.bytes > limits.maxBytesTotal) {
            rejection = `总附件超过 ${limits.maxBytesTotal / 1024 / 1024}MB 上限`;
            return current;
          }
          committed = true;
          return {
            ...current,
            attachments: [...current.attachments, entry],
          };
        });
        if (!committed) {
          releaseAttachmentPayloads(logicalSessionId, [id]);
          if (rejection) errors.push(`${file.name}：${rejection}`);
          continue;
        }
        added = true;
      } catch (error) {
        errors.push(`${file.name}：${(error as Error).message}`);
      }
    }

    updateComposer(logicalSessionId, (current) => {
      if (current.attachmentGeneration !== generation) return current;
      return {
        ...current,
        attachmentError: errors.length > 0
          ? errors.join('；')
          : added
            ? null
            : current.attachmentError,
      };
    });
  }, [
    ensureComposerSession,
    ephemeral,
    limits.maxBytesEach,
    limits.maxBytesTotal,
    limits.maxCount,
    limits.mimeTypes,
    logicalSessionId,
    updateComposer,
  ]);

  const remove = useCallback((id: string): void => {
    updateComposer(logicalSessionId, (current) => ({
      ...current,
      attachments: current.attachments.filter((attachment) => attachment.id !== id),
    }));
    releaseAttachmentPayloads(logicalSessionId, [id]);
  }, [logicalSessionId, updateComposer]);

  const clear = useCallback((): void => {
    const ids = currentComposer(logicalSessionId).attachments.map((attachment) => attachment.id);
    updateComposer(logicalSessionId, (current) => ({
      ...current,
      attachments: [],
      attachmentError: null,
      attachmentGeneration: current.attachmentGeneration + 1,
    }));
    releaseAttachmentPayloads(logicalSessionId, ids);
  }, [logicalSessionId, updateComposer]);

  const toIpcInputs = useCallback(
    () => attachmentInputs(logicalSessionId, composer.attachments),
    [composer.attachments, logicalSessionId],
  );

  const snapshotForSend = useCallback((): AttachmentSendSnapshot => ({
    attachments: composer.attachments,
    inputs: attachmentInputs(logicalSessionId, composer.attachments),
  }), [composer.attachments, logicalSessionId]);

  const releasePayloads = useCallback((ids: readonly string[]): void => {
    releaseAttachmentPayloads(logicalSessionId, ids);
  }, [logicalSessionId]);

  const getPreviewDataUrl = useCallback((id: string): string | null =>
    attachmentPreviewDataUrl(logicalSessionId, id), [logicalSessionId]);

  const dismissError = useCallback((): void => {
    updateComposer(logicalSessionId, (current) => ({ ...current, attachmentError: null }));
  }, [logicalSessionId, updateComposer]);

  const onPaste = useCallback((event: React.ClipboardEvent): void => {
    const items = event.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const item of items) {
      if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
      const file = item.getAsFile();
      if (file) files.push(file);
    }
    if (files.length > 0) {
      event.preventDefault();
      void add(files);
    }
  }, [add]);

  const onDrop = useCallback((event: React.DragEvent): void => {
    const files = Array.from(event.dataTransfer?.files ?? [])
      .filter((file) => file.type.startsWith('image/'));
    if (files.length > 0) {
      event.preventDefault();
      void add(files);
    }
  }, [add]);

  const onDragOver = useCallback((event: React.DragEvent): void => {
    if (event.dataTransfer && Array.from(event.dataTransfer.types).includes('Files')) {
      event.preventDefault();
    }
  }, []);

  return {
    attachments: composer.attachments,
    error: composer.attachmentError,
    add,
    remove,
    clear,
    onPaste,
    onDrop,
    onDragOver,
    toIpcInputs,
    snapshotForSend,
    releasePayloads,
    getPreviewDataUrl,
    dismissError,
  };
}
