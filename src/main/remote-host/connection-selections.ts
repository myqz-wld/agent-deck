import { constants, closeSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';

import {
  parseRemoteConnectionCredential,
  type RemoteConnectionCredential,
  type RemoteHostConnectionSelectionDto,
} from '@shared/remote-host';

const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_SELECTIONS = 16;
const MAX_CREDENTIAL_BYTES = 128 * 1024;

interface ConnectionSelection {
  credential: RemoteConnectionCredential;
  expiresAt: number;
}

export interface ConnectionSelectionOptions {
  createId: () => string;
  now?: () => number;
  ttlMs?: number;
  maxSelections?: number;
  readFile?: (path: string) => unknown;
}

function sameFile(left: ReturnType<typeof fstatSync>, right: ReturnType<typeof fstatSync>): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.mode === right.mode && left.uid === right.uid;
}

function readCredentialFile(path: string): unknown {
  if (!isAbsolute(path) || path.length > 4096 || path.includes('%') || path.includes('${')) {
    throw new Error('所选连接凭证文件无效');
  }
  let descriptor: number | null = null;
  let bytes: Buffer | null = null;
  try {
    if (realpathSync(path) !== path) throw new Error('连接凭证路径必须是规范路径');
    descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size < 1 || before.size > MAX_CREDENTIAL_BYTES ||
        (before.mode & 0o022) !== 0) {
      throw new Error('连接凭证文件权限或大小无效');
    }
    bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(descriptor, bytes, offset, bytes.byteLength - offset, null);
      if (count <= 0) break;
      offset += count;
    }
    const after = fstatSync(descriptor);
    if (offset !== bytes.byteLength || !sameFile(before, after) || realpathSync(path) !== path) {
      throw new Error('读取期间连接凭证文件发生变化');
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error('无法安全读取连接凭证', { cause: error });
  } finally {
    bytes?.fill(0);
    if (descriptor !== null) closeSync(descriptor);
  }
}

export class RemoteHostConnectionSelections {
  private readonly entries = new Map<string, ConnectionSelection>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxSelections: number;
  private readonly readFile: (path: string) => unknown;

  constructor(private readonly options: ConnectionSelectionOptions) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxSelections = options.maxSelections ?? DEFAULT_MAX_SELECTIONS;
    this.readFile = options.readFile ?? readCredentialFile;
  }

  capture(path: string): RemoteHostConnectionSelectionDto {
    const credential = parseRemoteConnectionCredential(this.readFile(path));
    this.prune();
    while (this.entries.size >= this.maxSelections) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
    const selectionId = this.options.createId();
    if (!selectionId || this.entries.has(selectionId)) {
      throw new Error('无法创建连接凭证选择标识');
    }
    this.entries.set(selectionId, {
      credential: structuredClone(credential),
      expiresAt: this.now() + this.ttlMs,
    });
    return {
      selectionId,
      label: credential.label,
      endpoint: {
        ...structuredClone(credential.endpoint),
        hostKeyFingerprint: connectionHostKeyFingerprint(credential),
      },
    };
  }

  resolve(selectionId: string): RemoteConnectionCredential {
    this.prune();
    const selection = this.entries.get(selectionId);
    if (!selection) throw new Error('连接凭证选择已失效，请重新导入');
    return structuredClone(selection.credential);
  }

  consume(selectionId: string): void {
    this.entries.delete(selectionId);
  }

  clear(): void {
    this.entries.clear();
  }

  private prune(): void {
    const now = this.now();
    for (const [id, selection] of this.entries) {
      if (selection.expiresAt <= now) this.entries.delete(id);
    }
  }
}

export function connectionHostKeyFingerprint(credential: RemoteConnectionCredential): string {
  const first = credential.hostKeys[0]!;
  return `SHA256:${createHash('sha256')
    .update(Buffer.from(first.publicKey, 'base64'))
    .digest('base64')
    .replace(/=+$/u, '')}`;
}
