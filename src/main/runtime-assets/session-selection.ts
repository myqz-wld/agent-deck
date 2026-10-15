import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { SNAPSHOT_MANIFEST } from './snapshot-store';

interface Selection { version: 1; current: string[]; history: string[]; aliasOf?: string; view?: string }
const stores = new Map<string, SessionAssetSelections>();
const key = (id: string): string => createHash('sha256').update(id).digest('hex');

/** References survive close/restart. Only permanent history deletion releases them. */
export class SessionAssetSelections {
  constructor(readonly root: string) {}
  private file(id: string): string { return join(this.root, `${key(id)}.json`); }
  private read(id: string): Selection | null {
    try {
      const value = JSON.parse(readFileSync(this.file(id), 'utf8')) as Selection;
      if (value.version !== 1 || !Array.isArray(value.current) || !Array.isArray(value.history)
        || ![...value.current, ...value.history].every(p => typeof p === 'string')) {
        throw new Error('Invalid runtime asset selection');
      }
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error; // Never silently select new assets for corrupt recoverable history.
    }
  }
  get(id: string): string[] | null { return this.read(id)?.current ?? null; }
  select(id: string, prepare: () => string[]): string[] {
    const prior = this.get(id);
    if (prior) {
      if (!prior.every(existsSync)) throw new Error('会话所选扩展版本不可读，请恢复资产后重试。');
      return prior;
    }
    return this.replace(id, prepare());
  }
  replace(id: string, current: string[]): string[] {
    const prior = this.read(id);
    this.write(id, { ...(prior?.view ? { view: prior.view } : {}), version: 1, current, history: [...new Set([...(prior?.history ?? []), ...current])] });
    return current;
  }
  getView(id: string): string | null { return this.read(id)?.view ?? null; }
  setView(id: string, view: string): void {
    const previous = this.read(id);
    if (!previous) throw new Error('Missing asset selection for plugin view');
    this.write(id, { ...previous, view, history: [...new Set([...previous.history, view])] });
  }
  private write(id: string, value: Selection): void {
    mkdirSync(this.root, { recursive: true });
    const staging = `${this.file(id)}.${randomUUID()}.tmp`;
    try {
      writeFileSync(staging, JSON.stringify(value), { mode: 0o600 });
      renameSync(staging, this.file(id));
    } finally { rmSync(staging, { force: true }); }
  }
  rename(from: string, to: string): void {
    const previous = this.read(from);
    if (!previous) return;
    const target = this.read(to);
    this.write(to, { ...previous, history: [...new Set([...previous.history, ...(target?.history ?? [])])] });
    // The old record remains recoverable if the database rename fails.
    this.write(from, { ...previous, aliasOf: key(to) });
  }
  retire(paths: string[]): void {
    this.write('released-snapshots', { version: 1, current: [], history: [...new Set([
      ...(this.read('released-snapshots')?.history ?? []), ...paths,
    ])] });
  }
  release(id: string): void {
    const previous = this.read(id);
    if (!previous) return;
    // Inspect every surviving record before releasing anything. Unknown/corrupt records fail closed.
    const aliases: string[] = [];
    for (const file of readdirSync(this.root)) {
      if (!file.endsWith('.json') || join(this.root, file) === this.file(id)) continue;
      const value = JSON.parse(readFileSync(join(this.root, file), 'utf8')) as Selection;
      if (value.version !== 1 || !Array.isArray(value.history)) throw new Error('Unknown snapshot owner');
      if (value.aliasOf === key(id)) aliases.push(join(this.root, file));
    }
    this.retire(previous.history);
    rmSync(this.file(id), { force: true });
    for (const alias of aliases) rmSync(alias, { force: true });
  }
  /** Called only during owning-host startup, before any provider runtime can use the store. */
  collectReleased(): void {
    const previous = this.read('released-snapshots');
    if (!previous) return;
    const retained = new Set<string>();
    for (const file of readdirSync(this.root)) {
      if (!file.endsWith('.json') || join(this.root, file) === this.file('released-snapshots')) continue;
      const value = JSON.parse(readFileSync(join(this.root, file), 'utf8')) as Selection;
      if (value.version !== 1 || !Array.isArray(value.history)) throw new Error('Unknown snapshot owner');
      for (const path of value.history) retained.add(path);
    }
    for (const path of previous.history) {
      // Only digest-addressed snapshots in this store's sibling directory are collectable.
      const versions = this.root.replace(/\.sessions$/, '.versions');
      const name = path.split(/[\\/]/).at(-1) ?? '';
      const ownedSnapshot = dirname(resolve(path)) === resolve(versions) && /^[a-f0-9]{64}$/.test(name);
      const ownedView = dirname(resolve(path)) === resolve(this.root.replace(/\.sessions$/, '.views'))
        && /^[a-f0-9-]{36}$/.test(name);
      if (!retained.has(path) && (ownedSnapshot || ownedView)
        && existsSync(join(path, SNAPSHOT_MANIFEST))) rmSync(path, { recursive: true, force: true });
    }
    rmSync(this.file('released-snapshots'), { force: true });
  }
}

export function sessionAssetSelections(destination: string): SessionAssetSelections {
  const root = `${destination}.sessions`;
  let store = stores.get(root);
  if (!store) { store = new SessionAssetSelections(root); stores.set(root, store); }
  return store;
}

// Host-owned stores register on preparation. Unknown legacy stores/paths are retained conservatively.
export function renameSessionAssetSelections(from: string, to: string): void {
  for (const store of stores.values()) store.rename(from, to);
}
export function releaseSessionAssetSelections(id: string): void {
  for (const store of stores.values()) {
    try { store.release(id); } catch { /* A failed collection retains assets; never blocks history deletion. */ }
  }
}
