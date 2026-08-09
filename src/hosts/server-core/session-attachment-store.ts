import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import type { SessionConsoleAttachmentInput } from '@contracts/index';
import type { UploadedAttachmentRef } from '@shared/types';

const DEFAULT_MAX_RETAINED_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_RETAINED_FILES = 4_096;
const EXTENSION = Object.freeze({
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
} as const);
const STORED_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:gif|jpg|png|webp)$/;
const ATTACHMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface ServerCoreSessionAttachmentStoreOptions {
  rootDirectory: string;
  createId?: () => string;
  maxRetainedBytes?: number;
  maxRetainedFiles?: number;
}

/** Private, quota-bounded storage for inline Remote creation images. */
export class ServerCoreSessionAttachmentStore {
  private readonly rootIdentity: { dev: bigint; ino: bigint; canonical: string };
  private readonly createId: () => string;
  private readonly maxRetainedBytes: number;
  private readonly maxRetainedFiles: number;

  constructor(private readonly options: ServerCoreSessionAttachmentStoreOptions) {
    this.createId = options.createId ?? randomUUID;
    this.maxRetainedBytes = options.maxRetainedBytes ?? DEFAULT_MAX_RETAINED_BYTES;
    this.maxRetainedFiles = options.maxRetainedFiles ?? DEFAULT_MAX_RETAINED_FILES;
    if (
      !Number.isSafeInteger(this.maxRetainedBytes) || this.maxRetainedBytes <= 0 ||
      !Number.isSafeInteger(this.maxRetainedFiles) || this.maxRetainedFiles <= 0
    ) throw new Error('Remote attachment storage limits are invalid');
    mkdirSync(options.rootDirectory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(options.rootDirectory, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077n) !== 0n) {
      throw new Error('Remote attachment storage root is unsafe');
    }
    this.rootIdentity = {
      canonical: realpathSync(options.rootDirectory),
      dev: stat.dev,
      ino: stat.ino,
    };
  }

  async persist(inputs: readonly SessionConsoleAttachmentInput[]): Promise<UploadedAttachmentRef[]> {
    if (inputs.length === 0) return [];
    this.assertStableRoot();
    const retained = this.retainedUsage();
    const incomingBytes = inputs.reduce((total, input) => total + input.bytes, 0);
    if (
      retained.files + inputs.length > this.maxRetainedFiles ||
      retained.bytes + incomingBytes > this.maxRetainedBytes
    ) throw new Error('Remote attachment private storage quota is full');

    const written: UploadedAttachmentRef[] = [];
    try {
      for (const input of inputs) written.push(this.write(input));
      this.assertStableRoot();
      return written;
    } catch (error) {
      await this.remove(written);
      throw error;
    }
  }

  async remove(refs: readonly UploadedAttachmentRef[]): Promise<void> {
    this.assertStableRoot();
    for (const ref of refs) {
      if (!this.isOwnedPath(ref.path)) continue;
      try { unlinkSync(ref.path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    this.assertStableRoot();
  }

  private write(input: SessionConsoleAttachmentInput): UploadedAttachmentRef {
    const id = this.createId();
    if (!ATTACHMENT_ID.test(id)) throw new Error('Remote attachment id is invalid');
    const extension = EXTENSION[input.mime];
    const path = join(this.rootIdentity.canonical, `${id}${extension}`);
    const decoded = Buffer.from(input.base64, 'base64');
    if (decoded.byteLength !== input.bytes) throw new Error('Remote attachment byte count changed');
    let descriptor: number | null = null;
    try {
      descriptor = openSync(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      writeFileSync(descriptor, decoded);
      fsyncSync(descriptor);
    } finally {
      decoded.fill(0);
      if (descriptor !== null) closeSync(descriptor);
    }
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
      try { unlinkSync(path); } catch {}
      throw new Error('Remote attachment storage write was not private');
    }
    return { kind: 'uploaded', path, mime: input.mime, bytes: input.bytes };
  }

  private retainedUsage(): { bytes: number; files: number } {
    let bytes = 0;
    let files = 0;
    for (const entry of readdirSync(this.rootIdentity.canonical, { withFileTypes: true })) {
      if (++files > this.maxRetainedFiles) throw new Error('Remote attachment file ceiling exceeded');
      if (!entry.isFile() || entry.isSymbolicLink() || !STORED_NAME.test(entry.name)) {
        throw new Error('Remote attachment storage contains an unexpected entry');
      }
      const stat = lstatSync(join(this.rootIdentity.canonical, entry.name));
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error('Remote attachment storage entry is unsafe');
      }
      bytes += stat.size;
      if (bytes > this.maxRetainedBytes) throw new Error('Remote attachment byte ceiling exceeded');
    }
    return { bytes, files };
  }

  private assertStableRoot(): void {
    const stat = lstatSync(this.options.rootDirectory, { bigint: true });
    if (
      !stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== this.rootIdentity.dev ||
      stat.ino !== this.rootIdentity.ino || realpathSync(this.options.rootDirectory) !== this.rootIdentity.canonical
    ) throw new Error('Remote attachment storage identity changed');
  }

  private isOwnedPath(path: string): boolean {
    const prefix = `${this.rootIdentity.canonical}/`;
    return path.startsWith(prefix) && STORED_NAME.test(path.slice(prefix.length));
  }
}
