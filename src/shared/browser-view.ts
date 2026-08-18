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

/** Browser-safe identity used only for renderer memoization and event matching. */
export function browserStateSourceIdentity(source: BrowserStateSource): string {
  return source.kind === 'local'
    ? JSON.stringify(['local', source.sessionId])
    : JSON.stringify([
        'remote', source.profileId, source.coreId, source.generation, source.sessionId,
      ]);
}

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

export interface BrowserViewBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface BrowserPresentationLease {
  readonly leaseId: string;
  readonly source: BrowserStateSource;
  readonly snapshot: BrowserStateSnapshot;
}

export interface BrowserPresentationBeginRequest {
  readonly source: BrowserStateSource;
  readonly expectedRevision: number;
}

export interface BrowserPresentationUpdateRequest {
  readonly leaseId: string;
  readonly tabId: number;
  readonly bounds: BrowserViewBounds;
}

export interface BrowserPresentationTabRequest {
  readonly leaseId: string;
  readonly tabId: number;
}

export interface BrowserPresentationParkRequest {
  readonly leaseId: string;
}

export interface BrowserPresentationResult {
  readonly snapshot: BrowserStateSnapshot | null;
  readonly appliedBounds: BrowserViewBounds | null;
}
