import { randomUUID } from 'node:crypto';
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync,
  realpathSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { isJsonObject, parseFeishuAssistantSessionIds } from '@contracts/index';

export const MAX_FEISHU_ASSISTANT_IDENTITIES = 4_096;
const MAX_FILE_BYTES = 1_100_000;
export interface FeishuAssistantStore { read(): string[]; write(sessionIds: readonly string[]): void }

/** Owner-attested session purpose only: no prompts, messages, credentials or native permissions. */
export class FileFeishuAssistantStore implements FeishuAssistantStore {
  private readonly path: string;
  constructor(private readonly directory: string) { this.path = join(directory, 'feishu-assistant-identities.json'); }

  private trustedDirectory(): void {
    const stat = lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(this.directory) !== this.directory ||
      stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) throw new Error('Untrusted assistant identity directory');
  }

  read(): string[] {
    this.trustedDirectory();
    const stat = lstatSync(this.path, { throwIfNoEntry: false });
    if (!stat) return [];
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 || stat.size > MAX_FILE_BYTES) throw new Error('Untrusted assistant identity file');
    const fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd);
      if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size > MAX_FILE_BYTES ||
        opened.uid !== stat.uid || (opened.mode & 0o777) !== 0o600) throw new Error('Assistant identity file changed');
      const value: unknown = JSON.parse(readFileSync(fd, 'utf8'));
      if (!isJsonObject(value) || value.version !== 1 ||
        Object.keys(value).sort().join(',') !== 'sessionIds,version') throw new Error('Invalid assistant identity file');
      return parseFeishuAssistantSessionIds(value.sessionIds, MAX_FEISHU_ASSISTANT_IDENTITIES);
    } finally { closeSync(fd); }
  }

  write(sessionIds: readonly string[]): void {
    this.trustedDirectory();
    const ids = parseFeishuAssistantSessionIds(sessionIds, MAX_FEISHU_ASSISTANT_IDENTITIES).sort();
    const temporary = join(this.directory, `.feishu-assistant-identities-${randomUUID()}`);
    try {
      const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try { writeFileSync(fd, `${JSON.stringify({ version: 1, sessionIds: ids })}\n`); fsyncSync(fd); }
      finally { closeSync(fd); }
      renameSync(temporary, this.path);
      const parent = openSync(this.directory, constants.O_RDONLY);
      try { fsyncSync(parent); } finally { closeSync(parent); }
    } finally { try { unlinkSync(temporary); } catch { /* Renamed on success. */ } }
  }
}
