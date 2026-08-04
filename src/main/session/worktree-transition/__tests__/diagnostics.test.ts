import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@shared/types';
import type { WorktreeTransitionRecord } from '../types';

const mocks = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));

vi.mock('@main/utils/logger', () => ({
  default: { scope: () => mocks.logger },
}));
vi.mock('@main/utils/run-context', () => ({ getProcessRunId: () => 'worktree-test-run' }));
vi.mock('@main/utils/runtime-correlation', () => ({
  runScopedCorrelationId: () => 'worktree-correlation',
}));

import { WorktreeTransitionDiagnostics } from '../diagnostics';

function transition(
  overrides: Partial<WorktreeTransitionRecord> = {},
): WorktreeTransitionRecord {
  return {
    sessionId: 'session /Users/private token=secret',
    generation: 2,
    direction: 'enter',
    phase: 'interrupting_enter_turn',
    originalCwd: '/repo',
    targetCwd: '/repo/worktree',
    mainRepo: '/repo',
    worktreePath: '/repo/worktree',
    baseCommit: 'a'.repeat(40),
    toolUseId: 'tool-secret',
    continuationKey: 'continuation-secret',
    continuationDelivered: false,
    discardChanges: false,
    requestedAt: 100,
    updatedAt: 150,
    lastError: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('WorktreeTransitionDiagnostics', () => {
  it('records content-free transition stages and continuation latency', () => {
    let now = 175;
    const diagnostics = new WorktreeTransitionDiagnostics(() => now);
    const record = transition();

    diagnostics.observeToolResult(record, true);
    expect(mocks.logger.info).toHaveBeenCalledWith(
      'worktree cwd transition tool result observed',
      expect.objectContaining({
        sessionRef: 'worktree-correlation',
        stage: 'tool-result-observed',
        requestedToToolResultMs: 75,
      }),
    );

    now = 200;
    const trace = diagnostics.start(record);
    now = 250;
    trace.markCwdSwitched();
    now = 260;
    trace.markCwdPersisted();
    now = 270;
    trace.markContinuationReady();
    now = 350;
    trace.complete(
      transition({ phase: 'active', continuationDelivered: true, updatedAt: 340 }),
      'codex-cli',
      true,
    );

    expect(mocks.logger.info).toHaveBeenCalledWith(
      'worktree cwd transition completed',
      expect.objectContaining({
        requestedToCompletedMs: 250,
        toolResultToCompletedMs: 200,
        finalizeDurationMs: 150,
        cwdSwitchDurationMs: 50,
        cwdPersistenceDurationMs: 10,
        cwdPersistedToCompletionMs: 90,
      }),
    );

    now = 400;
    diagnostics.observeEvent({
      sessionId: record.sessionId,
      agentId: 'codex-cli',
      kind: 'thinking',
      payload: { text: 'provider content' },
      ts: now,
      source: 'sdk',
    } satisfies AgentEvent);
    expect(mocks.logger.info).toHaveBeenCalledWith(
      'worktree cwd continuation produced provider activity',
      expect.objectContaining({
        stage: 'first-provider-event',
        eventKind: 'thinking',
        continuationToFirstEventMs: 130,
      }),
    );

    const emitted = JSON.stringify(mocks.logger.info.mock.calls);
    for (const forbidden of [record.sessionId, '/repo', 'tool-secret', 'continuation-secret']) {
      expect(emitted).not.toContain(forbidden);
    }
  });

  it('keeps rejected tool results and finalize failures actionable warnings', () => {
    let now = 200;
    const diagnostics = new WorktreeTransitionDiagnostics(() => now);
    const record = transition();

    diagnostics.observeToolResult(record, false);
    const trace = diagnostics.start(record);
    trace.markContinuationReady();
    now = 240;
    trace.fail(new Error('failed in /Users/private token=secret'));

    diagnostics.observeEvent({
      sessionId: record.sessionId,
      agentId: 'codex-cli',
      kind: 'thinking',
      payload: {},
      ts: now,
      source: 'sdk',
    } satisfies AgentEvent);

    expect(mocks.logger.warn.mock.calls.map((call) => call[0])).toEqual([
      'worktree cwd transition tool result rejected',
      'worktree cwd transition failed',
    ]);
    expect(mocks.logger.info).not.toHaveBeenCalledWith(
      'worktree cwd continuation produced provider activity',
      expect.anything(),
    );
    expect(JSON.stringify(mocks.logger.warn.mock.calls)).not.toContain('/Users/private');
    expect(JSON.stringify(mocks.logger.warn.mock.calls)).not.toContain('token=secret');
  });
});
