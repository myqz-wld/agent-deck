import { describe, expect, it } from 'vitest';

import { sessionConsoleCreateOptionsFixture } from './session-console-capabilities.fixture';
import {
  parseSessionHandOffCommitParams,
  parseSessionHandOffCommitResult,
  parseSessionHandOffPreviewParams,
  parseSessionHandOffPreviewResult,
} from './session-handoff';

const digest = `sha256:${'a'.repeat(64)}`;

describe('session handoff contract', () => {
  it('accepts inherited source cwd in requests and a resolved relative cwd in previews', () => {
    const request = {
      sessionId: 'session-a',
      continuationInstruction: 'Continue the current work.',
      target: {
        adapterId: 'codex-cli',
        workingDirectory: null,
        capabilityRevision: null,
        options: sessionConsoleCreateOptionsFixture(),
      },
    };
    expect(parseSessionHandOffPreviewParams(request)).toEqual(request);
    expect(parseSessionHandOffCommitParams({ ...request, expectedBindingDigest: digest }))
      .toEqual({ ...request, expectedBindingDigest: digest });
    expect(() => parseSessionHandOffPreviewParams({
      ...request,
      target: { ...request.target, capabilityRevision: 'directory-mismatch' },
    })).toThrow('Core-owned capability revision');
  });

  it('round-trips bounded preview and commit results', () => {
    const preview = {
      bindingDigest: digest,
      preview: 'bounded continuation',
      previewTruncated: false,
      quality: 'full',
      source: { eventRevision: 4, rebuildAfterRevision: 0 },
      checkpoint: { id: 1, throughRevision: 4, formatVersion: 2, refreshed: false },
      metrics: {
        estimatedPromptTokens: 100,
        checkpointTokens: 40,
        rawTailTokens: 60,
        includedUserMessages: 3,
        truncatedBoundaryMessages: 0,
        rawRetentionCeilingTokens: 1_000,
        elapsedMs: 5,
      },
      warnings: [],
      target: {
        adapterId: 'codex-cli',
        workingDirectory: 'repo',
        capabilityRevision: 'capability-a',
        options: sessionConsoleCreateOptionsFixture(),
      },
      revision: 8,
    } as const;
    expect(parseSessionHandOffPreviewResult(preview)).toEqual(preview);
    const commit = {
      successorSessionId: 'session-b',
      cutoverEventRevision: 5,
      lateMessagesDelivered: 1,
      usedLowerBudgetRetry: false,
      sourceFinalizationWarning: null,
      revision: 9,
    };
    expect(parseSessionHandOffCommitResult(commit)).toEqual(commit);
  });

  it('rejects absolute target paths, widened target options, and stale digest shapes', () => {
    const target = {
      adapterId: 'codex-cli',
      workingDirectory: '/private/repo',
      capabilityRevision: 'capability-a',
      options: sessionConsoleCreateOptionsFixture(),
    };
    expect(() => parseSessionHandOffPreviewParams({
      sessionId: 'session-a', continuationInstruction: 'Continue', target,
    })).toThrow('workingDirectory');
    expect(() => parseSessionHandOffCommitParams({
      sessionId: 'session-a', continuationInstruction: 'Continue',
      target: { ...target, workingDirectory: null, capabilityRevision: null },
      expectedBindingDigest: 'bad',
    })).toThrow('digest');
  });
});
