import { createHash } from 'node:crypto';
import { join } from 'node:path';

export interface SnapshotFilesystem {
  cpSync: typeof import('node:fs').cpSync;
  existsSync: typeof import('node:fs').existsSync;
  mkdirSync: typeof import('node:fs').mkdirSync;
  mkdtempSync: typeof import('node:fs').mkdtempSync;
  readdirSync: typeof import('node:fs').readdirSync;
  readFileSync: typeof import('node:fs').readFileSync;
  renameSync: typeof import('node:fs').renameSync;
  rmSync: typeof import('node:fs').rmSync;
  writeFileSync: typeof import('node:fs').writeFileSync;
}

export const SNAPSHOT_MANIFEST = '.agent-deck-snapshot.json';
interface Entry { path: string; kind: 'directory' | 'file'; sha256?: string }
export interface AssetSnapshot { path: string; digest: string; entries: Entry[] }
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

function entries(root: string, fs: SnapshotFilesystem, prefix = '', transform?: (text: string) => string, omit: string[] = []): Entry[] {
  const result: Entry[] = [];
  for (const entry of fs.readdirSync(join(root, prefix), { withFileTypes: true })
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    if (!prefix && (entry.name === SNAPSHOT_MANIFEST || omit.includes(entry.name))) continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      result.push({ path, kind: 'directory' }, ...entries(root, fs, path, transform, omit));
    } else if (entry.isFile()) {
      result.push({ path, kind: 'file', sha256: hash(transform && path.endsWith('.md')
        ? transform(fs.readFileSync(join(root, path), 'utf8')) : fs.readFileSync(join(root, path))) });
    } else {
      throw new Error('Bundled snapshots cannot contain links or special files');
    }
  }
  return result;
}

/** Stage the effective tree, validate it, then publish once. Existing versions are never replaced. */
export function publishAssetSnapshot(input: {
  source: string;
  destination: string;
  identity: Record<string, string | boolean>;
  omit?: string[];
  transformMarkdown?: (content: string) => string;
  validate?: (path: string) => void;
}, fs: SnapshotFilesystem): AssetSnapshot {
  entries(input.source, fs); // Reject symlinks before copying the bundled source.
  if (fs.existsSync(join(input.source, SNAPSHOT_MANIFEST))) throw new Error('Reserved snapshot manifest');
  const root = `${input.destination}.versions`;
  fs.mkdirSync(root, { recursive: true });
  for (const name of input.omit ?? []) {
    if (!/^[a-z][a-z-]*$/.test(name)) throw new Error('Invalid snapshot exclusion');
  }
  const tree = entries(input.source, fs, '', input.transformMarkdown, input.omit);
  const manifest = JSON.stringify({ version: 1, identity: input.identity, entries: tree });
  const digest = hash(manifest);
  const path = join(root, digest);
  const valid = (): boolean => {
    try {
      return fs.readFileSync(join(path, SNAPSHOT_MANIFEST), 'utf8') === manifest
        && JSON.stringify(entries(path, fs)) === JSON.stringify(tree);
    } catch { return false; }
  };
  if (fs.existsSync(path)) {
    if (!valid()) throw new Error('Immutable snapshot validation failed');
    return { path, digest, entries: tree };
  }
  const staging = fs.mkdtempSync(join(root, '.staging-'));
  try {
    fs.cpSync(input.source, staging, { recursive: true });
    for (const name of input.omit ?? []) fs.rmSync(join(staging, name), { recursive: true, force: true });
    for (const entry of entries(staging, fs)) {
      if (entry.kind !== 'file' || !entry.path.endsWith('.md') || !input.transformMarkdown) continue;
      const file = join(staging, entry.path);
      fs.writeFileSync(file, input.transformMarkdown(fs.readFileSync(file, 'utf8')), 'utf8');
    }
    input.validate?.(staging);
    if (JSON.stringify(entries(staging, fs)) !== JSON.stringify(tree)) {
      throw new Error('Bundled source changed while publishing');
    }
    fs.writeFileSync(join(staging, SNAPSHOT_MANIFEST), manifest, 'utf8');
    if (!fs.existsSync(path)) {
      try { fs.renameSync(staging, path); }
      catch (error) { if (!valid()) throw error; } // Concurrent publisher may have won.
    }
    if (!valid()) throw new Error('Immutable snapshot validation failed');
    return { path, digest, entries: tree };
  } finally {
    // Only this operation's private staging area is disposable.
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

export function snapshotContentsMatch(path: string, snapshot: string, fs: SnapshotFilesystem): boolean {
  try {
    const manifest = fs.readFileSync(join(snapshot, SNAPSHOT_MANIFEST), 'utf8');
    const expected = JSON.parse(manifest) as { entries: Entry[] };
    return fs.readFileSync(join(path, SNAPSHOT_MANIFEST), 'utf8') === manifest
      && JSON.stringify(entries(path, fs)) === JSON.stringify(expected.entries);
  } catch { return false; }
}
