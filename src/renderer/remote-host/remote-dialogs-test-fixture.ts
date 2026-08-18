import { vi } from 'vitest';

import { sessionConsoleCapabilitiesFixture } from '@contracts/session-console-capabilities.fixture';
import type { RemoteHostProfileDto } from '@shared/remote-host';
import type { RemoteSessionSourceView } from './source-types';
import type { RemoteHostSnapshotState } from './use-remote-host-snapshot';

const REMOTE_PROFILE: RemoteHostProfileDto = {
  id: 'remote-a',
  label: 'Production Core',
  scope: 'remote',
  endpoint: {
    hostname: 'core.example.test',
    port: 22,
    username: 'agentdeck',
    hostKeyFingerprint: 'SHA256:test',
  },
};

export function source(): RemoteSessionSourceView {
  return {
    addressableIdentityKey: 'remote-a:core-a:1',
    busy: false,
    capabilities: new Set(['session-console.create', 'session-console.read']),
    dataRevision: 0,
    resourceRevisions: {
      'session-list': 0, 'session-detail': 0, pending: 0,
      issues: 0, usage: 0, 'node-configuration': 0, 'node-assets': 0,
    },
    error: null,
    eventLoadError: null,
    events: null,
    historyLoadError: null,
    historyLoading: false,
    historyPaginationBusy: false,
    historyArchivedOnly: false,
    historyQuery: '',
    historySessions: [],
    hasMoreHistorySessions: false,
    hasMoreSessions: false,
    identity: 'remote-a:core-a:1',
    loading: false,
    livePaginationBusy: false,
    pendingBuckets: [],
    pendingBySession: new Map(),
    pendingLoading: false,
    pendingPaginationBusy: false,
    pendingLoadError: null,
    pendingTotal: 0,
    pendingScanTruncated: false,
    hasMorePending: false,
    presentationCounts: null,
    profile: REMOTE_PROFILE,
    recoveringWorker: false,
    runtime: null,
    runtimeLoadError: null,
    context: null,
    contextLoadError: null,
    inputCapabilities: null,
    inputLoadError: null,
    summaryLoadError: null,
    summaries: null,
    taskLoadError: null,
    tasks: null,
    sessionTotal: null,
    selectedPending: null,
    selectedSession: null,
    selectedSessionId: null,
    sessions: [],
    state: null,
    usable: true,
    clearError: vi.fn(),
    archiveHistorySession: vi.fn(),
    createSession: vi.fn(),
    createWorkspaceDirectory: vi.fn(),
    deleteHistorySession: vi.fn(),
    getSessionCapabilities: vi.fn(async (request) =>
      sessionConsoleCapabilitiesFixture('codex-cli', request.workingDirectory)),
    listWorkspaceDirectories: vi.fn(async (directory) => ({
      directory,
      directories: directory === '.'
        ? [{ directory: 'repo', name: 'repo' }]
        : [],
      truncated: false,
      revision: 1,
    })),
    listFileChanges: vi.fn(),
    getFileChange: vi.fn(),
    getFileFinalDiff: vi.fn(),
    loadImageBlob: vi.fn(async () => ({ ok: false as const, reason: 'unsupported_source' as const })),
    planReviewTransport: vi.fn(() => null),
    interrupt: vi.fn(),
    previewHandOff: vi.fn(),
    commitHandOff: vi.fn(),
    loadMoreHistorySessions: vi.fn(),
    listOutgoing: vi.fn(async () => ({
      sessionId: 'session-a', adapterId: 'claude-code', messages: [], revision: 1,
    })),
    loadMorePending: vi.fn(),
    loadMoreSessions: vi.fn(),
    refresh: vi.fn(),
    respondPending: vi.fn(),
    removeOutgoing: vi.fn(async () => true),
    selectSession: vi.fn(),
    setHistoryQuery: vi.fn(),
    setHistoryArchivedOnly: vi.fn(),
    send: vi.fn(),
    steer: vi.fn(),
    updateRuntime: vi.fn(),
    unarchiveHistorySession: vi.fn(),
    reactivateSession: vi.fn(),
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

export function hosts(
  selectProfile: () => Promise<void>,
  error: { code: string; message: string } | null = null,
): RemoteHostSnapshotState {
  return {
    snapshot: {
      revision: 1,
      sourceMode: 'local',
      selectedRemoteProfileId: REMOTE_PROFILE.id,
      profiles: [{
        id: 'local',
        label: 'Standalone',
        scope: 'local',
        endpoint: null,
      }, REMOTE_PROFILE],
      states: [{
        profileId: REMOTE_PROFILE.id,
        status: 'offline',
        recovery: null,
        authoritativeCoreId: null,
        workerGeneration: null,
        capabilities: [],
        eventRevision: 0,
        error,
      }],
    },
    dataRevisionByProfile: new Map(),
    resourceRevisionsByProfile: new Map(),
    mutations: {
      profileRegistry: false,
      sourceSelection: false,
      connectingProfileIds: new Set(),
      disconnectingProfileIds: new Set(),
    },
    busy: false,
    error: null,
    snapshotError: null,
    refresh: vi.fn(),
    addProfile: vi.fn(),
    updateProfile: vi.fn(),
    removeProfile: vi.fn(),
    selectProfile,
    setSourceMode: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    clearError: vi.fn(),
  };
}
