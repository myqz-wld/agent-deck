import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { BrowserScreenshotStore } from '@main/browser-use/screenshot-store';

export interface ServerCoreBrowserArtifactSession {
  readonly id: string;
  readonly cwd: string;
}

export interface ServerCoreBrowserArtifactStoreOptions {
  readonly workspaceRoot: string;
  readonly getSession: (sessionId: string) => ServerCoreBrowserArtifactSession | null;
}

function within(parent: string, child: string): boolean {
  const relation = relative(parent, child);
  return relation === '' || (
    relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation)
  );
}

function canonicalDirectory(path: string, field: string): string {
  if (!isAbsolute(path) || resolve(path) !== path || path === '/' || path.includes('\0')) {
    throw new Error(`${field} is invalid`);
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) {
    throw new Error(`${field} is unavailable`);
  }
  return path;
}

function ensureRealDirectory(path: string): void {
  mkdirSync(path, { recursive: false, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) {
    throw new Error('Browser artifact directory is unavailable');
  }
}

function sessionScope(sessionId: string): string {
  return `session-${createHash('sha256').update(sessionId).digest('hex').slice(0, 24)}`;
}

/** Writes only beneath the authoritative session cwd and never returns a Core-private path. */
export class ServerCoreBrowserArtifactStore {
  private readonly workspaceRoot: string;
  private readonly stores = new Map<string, BrowserScreenshotStore>();

  constructor(private readonly options: ServerCoreBrowserArtifactStoreOptions) {
    this.workspaceRoot = canonicalDirectory(options.workspaceRoot, 'Browser Workspace root');
  }

  async persist(input: {
    readonly applicationSessionId: string;
    readonly tabId: number;
    readonly png: Buffer;
  }): Promise<string> {
    const session = this.options.getSession(input.applicationSessionId);
    if (!session || session.id !== input.applicationSessionId) {
      throw new Error('Browser artifact session is unavailable');
    }
    const cwd = canonicalDirectory(session.cwd, 'Browser session directory');
    if (!within(this.workspaceRoot, cwd)) {
      throw new Error('Browser session directory escapes the Workspace');
    }
    const agentDeck = join(cwd, '.agent-deck');
    const root = join(agentDeck, 'browser-artifacts');
    if (!lstatSync(agentDeck, { throwIfNoEntry: false })) ensureRealDirectory(agentDeck);
    else canonicalDirectory(agentDeck, 'Browser artifact parent');
    if (!lstatSync(root, { throwIfNoEntry: false })) ensureRealDirectory(root);
    else canonicalDirectory(root, 'Browser artifact root');
    const store = this.stores.get(root) ?? new BrowserScreenshotStore({ rootDir: root });
    this.stores.set(root, store);
    const path = await store.persist(
      sessionScope(input.applicationSessionId),
      input.tabId,
      input.png,
    );
    if (!within(cwd, path)) throw new Error('Browser artifact escaped the session directory');
    return path;
  }
}
