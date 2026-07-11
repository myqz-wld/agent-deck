import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTrustedContinuationInitialTurn } from '@main/session/continuation-context/initial-turn';
import type { PreparedHandOffContinuation } from '@main/session/continuation-context/handoff';
import type { ResolvedSuccessorSpec } from '@main/session/continuation-context/types';
import { sessionRepo } from '@main/store/session-repo';
import type { SessionRecord } from '@shared/types';
import { handOffSessionHandler } from '../tools/handlers/hand-off-session';
import type { HandOffSessionHandlerDeps } from '../tools/handlers/hand-off-session/_deps';
import type { HandlerContext, HandlerResult } from '../tools/helpers';

const SPOOL_ID = 'cutover-spool';

function source(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'caller-sid',
    agentId: 'codex-cli',
    cwd: '/repo',
    title: 'caller',
    source: 'sdk',
    lifecycle: 'active',
    activity: 'idle',
    startedAt: 1,
    lastEventAt: 1,
    endedAt: null,
    archivedAt: null,
    model: 'gpt-source',
    thinking: 'high',
    codexSandbox: 'read-only',
    ...overrides,
  };
}

function context(): HandlerContext {
  return {
    caller: { callerSessionId: 'caller-sid', transport: 'in-process' },
  };
}

function preparedHandOff(target: ResolvedSuccessorSpec): PreparedHandOffContinuation {
  const prepared = {
    version: 1 as const,
    providerPrompt: 'private provider context',
    persistedUserText: 'continue',
    source: { eventRevision: 77, rebuildAfterRevision: 3, maxEventId: 88 },
    checkpoint: { id: 12, throughRevision: 77, formatVersion: 1, refreshed: true },
    projection: { canonicalHash: 'canonical', omittedFacts: 0 },
    quality: 'full' as const,
    metrics: {
      rawRetentionCeilingTokens: 64_000,
      targetPromptCapacityTokens: 104_000,
      checkpointProjectionBudgetTokens: 12_000,
      generatorFoldInputBudgetTokens: 32_000,
      estimatedPromptTokens: 9_000,
      checkpointTokens: 4_000,
      rawTailTokens: 4_500,
      includedUserMessages: 2,
      truncatedBoundaryMessages: 0,
      foldCalls: 1,
      repairCalls: 0,
      elapsedMs: 10,
      uncoveredRevisionRange: null,
    },
    warnings: [],
    preparationHash: 'a'.repeat(64),
    spoolId: SPOOL_ID,
  };
  return {
    prepared,
    turn: createTrustedContinuationInitialTurn(prepared, 'caller-sid'),
    generator: {
      adapter: 'claude-code',
      model: 'checkpoint-generator',
      thinking: 'medium',
      contextWindowTokens: 128_000,
      configFingerprint: 'generator-config',
    },
    target,
    settingsFingerprint: 'settings',
  };
}

function successfulTransfer() {
  return {
    tasks: { status: 'ok' as const, count: 1 },
    teams: { status: 'ok' as const, transferred: [], skipped: [], failed: [] },
    worktreeMarker: { status: 'ok' as const, marker: '/repo' },
  };
}

function dependencies(
  overrides: Partial<HandOffSessionHandlerDeps> = {},
): HandOffSessionHandlerDeps {
  return {
    cwdIsDirectory: () => true,
    sourceMaxEventId: () => 88,
    sourceRuntimeFingerprint: () => 'source-runtime-v1',
    validateTargetAdapter: () => null,
    prepareContinuation: vi.fn(async (input) => preparedHandOff(input.target)),
    spoolMetadata: () => ({
      spoolId: SPOOL_ID,
      sessionId: 'caller-sid',
      createdAt: 1,
      expiresAt: 2,
      lastAccessedAt: 1,
      captureRevision: 77,
      rebuildAfterRevision: 3,
      maxEventId: 88,
      runtimeFingerprint: 'source-runtime-v1',
      checkpoint: null,
      checkpointThroughRevision: 77,
      materializedThroughRevision: 77,
      uncoveredRevisionRange: null,
      spoolBytes: 1_000,
      rawTailTokens: 500,
      rawWarnings: [],
      rawScanTruncated: false,
      consumed: false,
    }),
    sourcePreconditionMatches: () => true,
    createSuccessor: vi.fn(async () => 'successor-sid'),
    transferResources: vi.fn(() => successfulTransfer()),
    closeSuccessor: vi.fn(async () => undefined),
    finalizeSource: vi.fn(async () => undefined),
    cleanupSpool: vi.fn(),
    ...overrides,
  };
}

function parsed(result: HandlerResult): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('hand_off_session cutover exclusion and freshness', () => {
  it.each(['runtime', 'lineage boundary'] as const)(
    'rejects %s drift between target resolution and immutable capture',
    async (drift) => {
      vi.spyOn(sessionRepo, 'get').mockReturnValue(source());
      const createSuccessor = vi.fn();
      const cleanupSpool = vi.fn();
      const deps = dependencies({ createSuccessor, cleanupSpool });
      if (drift === 'runtime') {
        const baseMetadata = deps.spoolMetadata?.(SPOOL_ID);
        deps.spoolMetadata = () => ({
          ...baseMetadata!,
          runtimeFingerprint: 'source-runtime-v2',
        });
      } else {
        deps.sourceMaxEventId = () => 87;
      }

      const result = await handOffSessionHandler({ prompt: 'continue' }, context(), deps);

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('failed to freeze handoff source boundary');
      expect(createSuccessor).not.toHaveBeenCalled();
      expect(cleanupSpool).toHaveBeenCalledWith(SPOOL_ID);
    },
  );

  it('rejects stale inherited target options from a mismatched source-row/runtime pair', async () => {
    vi.spyOn(sessionRepo, 'get')
      .mockReturnValueOnce(source())
      .mockReturnValue(source({ model: 'gpt-changed-after-row-read' }));
    const createSuccessor = vi.fn();
    const cleanupSpool = vi.fn();

    const result = await handOffSessionHandler(
      { prompt: 'continue' },
      context(),
      dependencies({ createSuccessor, cleanupSpool }),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('handoff target changed while preparing');
    expect(createSuccessor).not.toHaveBeenCalled();
    expect(cleanupSpool).toHaveBeenCalledWith(SPOOL_ID);
  });

  it('allows only one concurrent handoff to prepare or create for one source', async () => {
    vi.spyOn(sessionRepo, 'get').mockReturnValue(source());
    let finishPrepare!: (value: PreparedHandOffContinuation) => void;
    let signalStarted!: () => void;
    let frozenTarget: ResolvedSuccessorSpec | null = null;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const prepareContinuation = vi.fn(
      (input: Parameters<NonNullable<HandOffSessionHandlerDeps['prepareContinuation']>>[0]) => {
        frozenTarget = input.target;
        signalStarted();
        return new Promise<PreparedHandOffContinuation>((resolve) => {
          finishPrepare = resolve;
        });
      },
    );
    const createSuccessor = vi.fn(async () => 'only-successor');
    const transferResources = vi.fn(() => successfulTransfer());
    const deps = dependencies({ prepareContinuation, createSuccessor, transferResources });

    const first = handOffSessionHandler({ prompt: 'first' }, context(), deps);
    await started;
    const duplicate = await handOffSessionHandler({ prompt: 'duplicate' }, context(), deps);

    expect(duplicate.isError).toBe(true);
    expect(duplicate.content[0]?.text).toContain('handoff already in progress');
    expect(prepareContinuation).toHaveBeenCalledTimes(1);
    expect(createSuccessor).not.toHaveBeenCalled();

    finishPrepare(preparedHandOff(frozenTarget!));
    expect((await first).isError).toBeFalsy();
    expect(createSuccessor).toHaveBeenCalledTimes(1);
    expect(transferResources).toHaveBeenCalledTimes(1);
  });

  it('closes the orphan and moves no resources when source drifts during create', async () => {
    vi.spyOn(sessionRepo, 'get').mockReturnValue(source());
    const closeSuccessor = vi.fn(async () => undefined);
    const transferResources = vi.fn(() => successfulTransfer());
    const finalizeSource = vi.fn();
    const sourcePreconditionMatches = vi
      .fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    const result = await handOffSessionHandler(
      { prompt: 'continue' },
      context(),
      dependencies({
        closeSuccessor,
        transferResources,
        finalizeSource,
        sourcePreconditionMatches,
      }),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('source session changed while creating');
    expect(sourcePreconditionMatches).toHaveBeenCalledTimes(2);
    expect(closeSuccessor).toHaveBeenCalledWith('successor-sid');
    expect(transferResources).not.toHaveBeenCalled();
    expect(finalizeSource).not.toHaveBeenCalled();
    expect(parsed(result)).toMatchObject({
      successorSessionId: 'successor-sid',
      successorClosed: 'ok',
      resourceTransfer: null,
    });
  });
});
