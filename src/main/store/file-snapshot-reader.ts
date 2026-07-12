import {
  decodeFileSnapshotBlob,
  snapshotDigestKey,
  type StoredFileSnapshotBlob,
} from './file-snapshot-codec';

interface SnapshotSelection extends StoredFileSnapshotBlob {
  hash: unknown;
}

type CacheEntry = { ok: true; value: string } | { ok: false };

/** One instance per list query so repeated snapshots inflate and warn at most once per digest. */
export class FileSnapshotReader {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly warn: (message: string, err?: unknown) => void) {}

  read(
    selection: SnapshotSelection,
    legacy: string | null | undefined,
    context: string,
  ): string | null {
    if (selection.hash == null) return legacy ?? null;

    const key = snapshotDigestKey(selection.hash);
    if (key === null) {
      this.warn(`[file-change-repo] malformed snapshot digest (${context})`);
      return legacy ?? null;
    }
    const cached = this.cache.get(key);
    if (cached) return cached.ok ? cached.value : (legacy ?? null);

    try {
      const value = decodeFileSnapshotBlob(selection.hash as Buffer, selection);
      this.cache.set(key, { ok: true, value });
      return value;
    } catch (err) {
      this.cache.set(key, { ok: false });
      this.warn(`[file-change-repo] snapshot blob decode failed (${context}, digest=${key})`, err);
      return legacy ?? null;
    }
  }
}
