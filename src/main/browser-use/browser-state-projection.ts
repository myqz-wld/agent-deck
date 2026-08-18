import { getBrowserEngine } from './engine/registry';
import { sessionBrowserOwner } from './session-browser';

export interface LocalBrowserStateSource {
  readonly kind: 'local';
  readonly sessionId: string;
}

export interface RemoteBrowserStateSource {
  readonly kind: 'remote';
  readonly profileId: string;
  readonly coreId: string;
  readonly generation: number | null;
  readonly sessionId: string;
}

export type BrowserStateSource = LocalBrowserStateSource | RemoteBrowserStateSource;

export interface ProjectedBrowserTab {
  readonly id: number;
  readonly title: string;
  readonly url: string;
  readonly active: boolean;
  readonly viewportRevision: number;
}

export interface BrowserStateSnapshot {
  readonly protocolVersion: 1;
  readonly source: BrowserStateSource;
  readonly revision: number;
  readonly tabs: readonly ProjectedBrowserTab[];
}

export interface BrowserStateProjectionEvent {
  readonly source: BrowserStateSource;
  readonly revision: number;
  readonly snapshot: BrowserStateSnapshot | null;
}

export interface BrowserStateProjectionPort {
  publish(source: BrowserStateSource, ownerId: string): BrowserStateProjectionEvent;
  clear(source: BrowserStateSource): BrowserStateProjectionEvent;
}

const MAX_STATE_KEYS = 512;

function frame(value: string | number | null): string {
  const text = String(value ?? '');
  return `${Buffer.byteLength(text)}:${text}`;
}

export function browserStateSourceKey(source: BrowserStateSource): string {
  return source.kind === 'local'
    ? ['local', source.sessionId].map(frame).join('|')
    : [
        'remote', source.profileId, source.coreId, source.generation, source.sessionId,
      ].map(frame).join('|');
}

function copySource(source: BrowserStateSource): BrowserStateSource {
  return Object.freeze({ ...source });
}

export class BrowserStateProjectionRegistry implements BrowserStateProjectionPort {
  private readonly snapshots = new Map<string, BrowserStateSnapshot>();
  private readonly revisions = new Map<string, number>();
  private readonly listeners = new Set<(event: BrowserStateProjectionEvent) => void>();

  publish(source: BrowserStateSource, ownerId: string): BrowserStateProjectionEvent {
    const handle = getBrowserEngine().peek(sessionBrowserOwner(ownerId));
    const tabs = handle?.listTabs().map((tab) => ({
      ...tab.info(handle.isActive(tab.id)),
      viewportRevision: tab.viewportRevision(),
    })) ?? [];
    if (tabs.length === 0) return this.clear(source);
    const key = browserStateSourceKey(source);
    const revision = this.nextRevision(key);
    const snapshot: BrowserStateSnapshot = Object.freeze({
      protocolVersion: 1,
      source: copySource(source),
      revision,
      tabs: Object.freeze(tabs.map((tab) => Object.freeze(tab))),
    });
    this.snapshots.set(key, snapshot);
    const event = Object.freeze({ source: snapshot.source, revision, snapshot });
    this.emit(event);
    return event;
  }

  clear(source: BrowserStateSource): BrowserStateProjectionEvent {
    const key = browserStateSourceKey(source);
    const revision = this.nextRevision(key);
    this.snapshots.delete(key);
    const event = Object.freeze({ source: copySource(source), revision, snapshot: null });
    this.emit(event);
    return event;
  }

  get(source: BrowserStateSource): BrowserStateSnapshot | null {
    return this.snapshots.get(browserStateSourceKey(source)) ?? null;
  }

  subscribe(listener: (event: BrowserStateProjectionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  reset(): void {
    this.snapshots.clear();
    this.revisions.clear();
    this.listeners.clear();
  }

  private nextRevision(key: string): number {
    if (!this.revisions.has(key) && this.revisions.size >= MAX_STATE_KEYS) {
      const oldest = this.revisions.keys().next().value as string | undefined;
      if (oldest != null) {
        this.revisions.delete(oldest);
        this.snapshots.delete(oldest);
      }
    }
    const revision = (this.revisions.get(key) ?? 0) + 1;
    this.revisions.delete(key);
    this.revisions.set(key, revision);
    return revision;
  }

  private emit(event: BrowserStateProjectionEvent): void {
    for (const listener of [...this.listeners]) {
      try { listener(event); } catch {}
    }
  }
}

let sharedRegistry: BrowserStateProjectionRegistry | null = null;

export function getBrowserStateProjectionRegistry(): BrowserStateProjectionRegistry {
  sharedRegistry ??= new BrowserStateProjectionRegistry();
  return sharedRegistry;
}

export function setBrowserStateProjectionRegistry(
  value: BrowserStateProjectionRegistry | null,
): void {
  sharedRegistry = value;
}
