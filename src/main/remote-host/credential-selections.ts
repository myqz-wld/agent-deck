import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import type {
  RemoteHostCredentialKind,
  RemoteHostCredentialSelectionDto,
} from '@shared/remote-host';

const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_SELECTIONS = 16;

interface CredentialSelection {
  id: string;
  kind: RemoteHostCredentialKind;
  path: string;
  expiresAt: number;
}

export interface CredentialSelectionOptions {
  createId: () => string;
  now?: () => number;
  ttlMs?: number;
  maxSelections?: number;
  validateFile?: (path: string) => void;
}

function validateSelectedFile(path: string): void {
  if (
    !isAbsolute(path) ||
    path.length > 4096 ||
    path.includes('%') ||
    path.includes('${')
  ) {
    throw new Error('所选凭据文件无效');
  }
  if (!statSync(path).isFile()) throw new Error('所选凭据必须是普通文件');
}

export class RemoteHostCredentialSelections {
  private readonly entries = new Map<string, CredentialSelection>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxSelections: number;
  private readonly validateFile: (path: string) => void;

  constructor(private readonly options: CredentialSelectionOptions) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxSelections = options.maxSelections ?? DEFAULT_MAX_SELECTIONS;
    this.validateFile = options.validateFile ?? validateSelectedFile;
  }

  capture(kind: RemoteHostCredentialKind, path: string): RemoteHostCredentialSelectionDto {
    this.validateFile(path);
    this.prune();
    while (this.entries.size >= this.maxSelections) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
    const id = this.options.createId();
    if (!id || this.entries.has(id)) throw new Error('无法创建凭据选择标识');
    this.entries.set(id, {
      id,
      kind,
      path,
      expiresAt: this.now() + this.ttlMs,
    });
    return { selectionId: id, kind };
  }

  resolve(kind: RemoteHostCredentialKind, selectionId: string): string {
    this.prune();
    const selection = this.entries.get(selectionId);
    if (!selection || selection.kind !== kind) {
      throw new Error('凭据选择已失效，请重新选择文件');
    }
    return selection.path;
  }

  consume(selectionIds: readonly string[]): void {
    for (const selectionId of new Set(selectionIds)) this.entries.delete(selectionId);
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
