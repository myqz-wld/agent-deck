import { getBrowserEngine } from './engine/registry';
import type {
  BrowserStateProjectionEvent,
  BrowserStateSnapshot,
  BrowserStateSource,
} from '@shared/browser-view';
import { sanitizedBrowserUrl } from '@shared/browser-view';

export type {
  BrowserStateProjectionEvent,
  BrowserStateSnapshot,
  BrowserStateSource,
  LocalBrowserStateSource,
  ProjectedBrowserTab,
  RemoteBrowserStateSource,
} from '@shared/browser-view';

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
  private readonly owners = new Map<string, string>();
  private readonly revisions = new Map<string, number>();
  private readonly listeners = new Set<(event: BrowserStateProjectionEvent) => void>();

  publish(source: BrowserStateSource, ownerId: string): BrowserStateProjectionEvent {
    const handle = getBrowserEngine().peek({ kind: 'session', id: ownerId });
    const tabs = handle?.listTabs().map((tab) => {
      const info = tab.info(handle.isActive(tab.id));
      return {
        ...info,
        url: sanitizedBrowserUrl(info.url),
        viewportRevision: tab.viewportRevision(),
      };
    }) ?? [];
    if (tabs.length === 0) return this.clear(source);
    const key = browserStateSourceKey(source);
    const existing = this.snapshots.get(key);
    if (existing && sameTabs(existing.tabs, tabs)) {
      this.owners.set(key, ownerId);
      return Object.freeze({
        source: existing.source,
        revision: existing.revision,
        snapshot: existing,
      });
    }
    const revision = this.nextRevision(key);
    const snapshot: BrowserStateSnapshot = Object.freeze({
      protocolVersion: 1,
      source: copySource(source),
      revision,
      tabs: Object.freeze(tabs.map((tab) => Object.freeze(tab))),
    });
    this.snapshots.set(key, snapshot);
    this.owners.set(key, ownerId);
    const event = Object.freeze({ source: snapshot.source, revision, snapshot });
    this.emit(event);
    return event;
  }

  clear(source: BrowserStateSource): BrowserStateProjectionEvent {
    const key = browserStateSourceKey(source);
    const existing = this.snapshots.get(key);
    if (!existing) {
      return Object.freeze({
        source: copySource(source),
        revision: this.revisions.get(key) ?? 0,
        snapshot: null,
      });
    }
    const revision = this.nextRevision(key);
    this.snapshots.delete(key);
    this.owners.delete(key);
    const event = Object.freeze({ source: copySource(source), revision, snapshot: null });
    this.emit(event);
    return event;
  }

  get(source: BrowserStateSource): BrowserStateSnapshot | null {
    return this.snapshots.get(browserStateSourceKey(source)) ?? null;
  }

  owner(source: BrowserStateSource): string | null {
    return this.owners.get(browserStateSourceKey(source)) ?? null;
  }

  clearOwner(ownerId: string): void {
    for (const [key, candidate] of [...this.owners]) {
      if (candidate !== ownerId) continue;
      const snapshot = this.snapshots.get(key);
      if (snapshot != null) this.clear(snapshot.source);
      else this.owners.delete(key);
    }
  }

  subscribe(listener: (event: BrowserStateProjectionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  reset(): void {
    this.snapshots.clear();
    this.owners.clear();
    this.revisions.clear();
    this.listeners.clear();
  }

  private nextRevision(key: string): number {
    if (!this.revisions.has(key) && this.revisions.size >= MAX_STATE_KEYS) {
      const oldest = this.revisions.keys().next().value as string | undefined;
      if (oldest != null) {
        this.revisions.delete(oldest);
        this.snapshots.delete(oldest);
        this.owners.delete(oldest);
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

function sameTabs(
  left: BrowserStateSnapshot['tabs'],
  right: BrowserStateSnapshot['tabs'],
): boolean {
  return left.length === right.length && left.every((tab, index) => {
    const candidate = right[index];
    return candidate != null && tab.id === candidate.id && tab.title === candidate.title &&
      tab.url === candidate.url && tab.active === candidate.active &&
      tab.viewportRevision === candidate.viewportRevision;
  });
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
