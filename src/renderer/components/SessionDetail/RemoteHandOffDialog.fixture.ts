import { vi } from 'vitest';
import {
  sessionConsoleCapabilitiesFixture,
  sessionConsoleCreateOptionsFixture,
} from '@contracts/session-console-capabilities.fixture';
import type { SessionHandOffPreviewResult } from '@contracts/index';
import type { RemoteSessionSourceView } from '@renderer/remote-host/source-types';

export function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

export function preview(): SessionHandOffPreviewResult {
  return {
    bindingDigest: `sha256:${'b'.repeat(64)}`,
    preview: 'remote continuation preview',
    previewTruncated: false,
    quality: 'full',
    source: { eventRevision: 8, rebuildAfterRevision: 0 },
    checkpoint: { id: 1, throughRevision: 8, formatVersion: 2, refreshed: false },
    metrics: {
      estimatedPromptTokens: 120,
      checkpointTokens: 60,
      rawTailTokens: 60,
      includedUserMessages: 4,
      truncatedBoundaryMessages: 0,
      rawRetentionCeilingTokens: 1_000,
      elapsedMs: 4,
    },
    warnings: [],
    target: {
      adapterId: 'codex-cli',
      workingDirectory: 'repo',
      capabilityRevision: `sha256:${'a'.repeat(64)}`,
      options: sessionConsoleCreateOptionsFixture(),
    },
    revision: 9,
  };
}

export function source(overrides: Partial<RemoteSessionSourceView> = {}): RemoteSessionSourceView {
  const descriptor = sessionConsoleCapabilitiesFixture('codex-cli', '.');
  return {
    identity: 'remote-a:core-a:1',
    usable: true,
    busy: false,
    capabilities: new Set(['session-console.read', 'sessions.handoff']),
    getSessionCapabilities: vi.fn(async () => descriptor),
    previewHandOff: vi.fn(async () => preview()),
    commitHandOff: vi.fn(async () => ({
      successorSessionId: 'session-successor',
      cutoverEventRevision: 9,
      lateMessagesDelivered: 0,
      usedLowerBudgetRetry: false,
      sourceFinalizationWarning: null,
      revision: 10,
    })),
    ...overrides,
  } as unknown as RemoteSessionSourceView;
}
