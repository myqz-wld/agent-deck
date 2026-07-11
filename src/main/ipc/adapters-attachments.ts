import type { UploadedAttachmentInput, UploadedAttachmentRef } from '@shared/types';
import {
  deleteUploadIfExists,
  writeUploadedImage,
} from '@main/store/image-uploads';
import { MAX_TOTAL_ATTACHMENTS_BYTES } from './_image-constants';
import { IpcInputError } from './_helpers';

/** Validate untrusted attachment envelopes and persist them with sibling rollback on failure. */
export async function persistAdapterAttachments(
  raw: unknown,
  fieldName: string,
): Promise<UploadedAttachmentRef[]> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new IpcInputError(fieldName, 'must be array');
  if (raw.length === 0) return [];
  if (raw.length > 20) {
    throw new IpcInputError(fieldName, `> 20 attachments (got ${raw.length})`);
  }

  let totalBytes = 0;
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      throw new IpcInputError(fieldName, 'each item must be object');
    }
    const input = item as Partial<UploadedAttachmentInput>;
    if (
      input.kind !== 'image' ||
      typeof input.base64 !== 'string' ||
      typeof input.mime !== 'string'
    ) {
      throw new IpcInputError(fieldName, 'each item must be UploadedAttachmentInput');
    }
    if (typeof input.bytes !== 'number' || !Number.isFinite(input.bytes) || input.bytes < 0) {
      throw new IpcInputError(fieldName, 'each item.bytes must be non-negative number');
    }
    totalBytes += input.bytes;
  }
  if (totalBytes > MAX_TOTAL_ATTACHMENTS_BYTES) {
    throw new IpcInputError(
      fieldName,
      `total ${(totalBytes / 1024 / 1024).toFixed(1)}MB > ${MAX_TOTAL_ATTACHMENTS_BYTES / 1024 / 1024}MB limit`,
    );
  }

  const written: UploadedAttachmentRef[] = [];
  try {
    for (const item of raw as UploadedAttachmentInput[]) {
      written.push(await writeUploadedImage(item));
    }
    return written;
  } catch (error) {
    await Promise.all(written.map((item) => deleteUploadIfExists(item.path)));
    throw error;
  }
}
