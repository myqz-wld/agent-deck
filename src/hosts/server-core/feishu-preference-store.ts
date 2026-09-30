import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultFeishuModelPreference, parseFeishuPreferences, type FeishuPreferences } from '@contracts/index';

export interface FeishuPreferenceStore { read(): FeishuPreferences; write(value: FeishuPreferences): void }

/** Small, non-secret configuration owned by Core; it does not modify the Feishu gateway database. */
export class FileFeishuPreferenceStore implements FeishuPreferenceStore {
  private readonly path: string;
  constructor(private readonly directory: string) { this.path = join(directory, 'feishu-model-preferences.json'); }

  private trustedDirectory(): void {
    const stat = lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(this.directory) !== this.directory ||
      stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) throw new Error('Untrusted preference directory');
  }

  read(): FeishuPreferences {
    this.trustedDirectory();
    const stat = lstatSync(this.path, { throwIfNoEntry: false });
    if (!stat) return { conversation: defaultFeishuModelPreference(), session: defaultFeishuModelPreference(), settingsRevision: 0 };
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 || stat.size > 8_192) throw new Error('Untrusted preference file');
    const fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd);
      if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size > 8_192 ||
        opened.uid !== stat.uid || (opened.mode & 0o777) !== 0o600) throw new Error('Preference file changed');
      return parseFeishuPreferences(JSON.parse(readFileSync(fd, 'utf8')));
    }
    finally { closeSync(fd); }
  }

  write(value: FeishuPreferences): void {
    this.trustedDirectory();
    const next = parseFeishuPreferences(value);
    const temporary = join(this.directory, `.feishu-model-preferences-${randomUUID()}`);
    try {
      const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try { writeFileSync(fd, `${JSON.stringify(next)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, this.path);
      const parent = openSync(this.directory, constants.O_RDONLY);
      try { fsyncSync(parent); } finally { closeSync(parent); }
    } finally { try { unlinkSync(temporary); } catch { /* Renamed on success. */ } }
  }
}
