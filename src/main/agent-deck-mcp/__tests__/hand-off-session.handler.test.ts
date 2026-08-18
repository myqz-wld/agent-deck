import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@main/store/session-handoff-alias-repo', () => ({
  findSessionHandOffSuccessor: () => null,
}));
import { adapterRegistry } from '@main/adapters/registry';
import * as mcpSessionTokenMap from '@main/agent-deck-mcp/mcp-session-token-map';
import { createTrustedContinuationInitialTurn } from '@main/session/continuation-context/initial-turn';
import type { PreparedHandOffContinuation } from '@main/session/continuation-context/handoff';
import type {
  PreparedContinuationContext,
  ResolvedContinuationGenerator,
  ResolvedSuccessorSpec,
} from '@main/session/continuation-context/types';
import { sessionManager } from '@main/session/manager';
import {
  HandOffCutoverCoordinator,
  handOffCutoverCoordinator,
} from '@main/session/hand-off/cutover-coordinator';
import { resolveHandOffTarget } from '@main/session/hand-off/target-resolver';
import { sessionRepo } from '@main/store/session-repo';
import {
  createAgentDeckTeamRepo,
  transferTeammateMembershipWithDb,
} from '@main/store/agent-deck-team-repo';
import {
  bindingAvailable,
  insertSession,
  makeMemoryDb,
} from '@main/store/__tests__/agent-deck-repos/_setup';
import type { SessionRecord } from '@shared/types';
import { handOffSessionHandler } from '../tools/handlers/hand-off-session';
import { shutdownSessionHandler } from '../tools/handlers/shutdown';
import type { HandOffSessionHandlerDeps } from '../tools/handlers/hand-off-session/_deps';
import type { HandlerContext, HandlerResult } from '../tools/helpers';
import {
  observedContextCapacity,
  unknownContextCapacity,
} from '@main/session/continuation-context/__tests__/capacity-fixtures';
import type { TrustedContinuationSessionCandidate } from '@main/adapters/trusted-continuation';

vi.mock('@main/session/context-window/service', () => ({
  getContextWindowCapacityService: () => ({
    resolve: (identity: { status: string; identity?: unknown; reason?: string }) =>
      identity.status === 'concrete'
        ? { status: 'unknown', identity: identity.identity, windowTokens: null, reason: 'no-observation' }
        : { status: 'unknown', identity: null, windowTokens: null, reason: identity.reason },
    observe: vi.fn(),
  }),
}));

const PRIVATE_PROVIDER_CONTEXT = 'PRIVATE_PROVIDER_CONTEXT_SHOULD_NEVER_LEAK';
const PRIVATE_SPOOL_ID = 'PRIVATE_SPOOL_ID_SHOULD_NEVER_LEAK';

function acceptedCandidate(sessionId: string): TrustedContinuationSessionCandidate {
  return {
    sessionId,
    acceptance: Promise.resolve({ status: 'accepted', boundary: 'model-activity' }),
  };
}

function parseResult(result: HandlerResult): Record<string, any> {
  if (result.isError) {
    return JSON.parse(result.content[0]?.text ?? '{}') as Record<string, any>;
  }
  expect(result.content).toEqual([]);
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent as Record<string, any>;
}

function callerRow(overrides: Partial<SessionRecord> = {}): SessionRecord {
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
    extraAllowWrite: ['/extra'],
    networkAccessEnabled: true,
    additionalDirectories: ['/tmp'],
    ...overrides,
  };
}

function ctx(): HandlerContext {
  return {
    caller: {
      callerSessionId: 'caller-sid',
      transport: 'in-process',
    },
  };
}

function preparedContext(): PreparedContinuationContext {
  return {
    version: 2,
    providerPrompt: PRIVATE_PROVIDER_CONTEXT,
    persistedUserText: 'PRIVATE_CURRENT_INSTRUCTION_SHOULD_NEVER_BE_ECHOED',
    source: { eventRevision: 77, rebuildAfterRevision: 3, maxEventId: 88 },
    checkpoint: { id: 12, throughRevision: 77, formatVersion: 1, refreshed: true },
    projection: { canonicalHash: 'canonical-secret', omittedFacts: 2 },
    quality: 'projected',
    metrics: {
      rawRetentionCeilingTokens: 64_000,
      targetPromptCapacityTokens: 104_000,
      checkpointProjectionBudgetTokens: 12_000,
      generatorFoldInputBudgetTokens: 32_000,
      estimatedPromptTokens: 9_000,
      checkpointTokens: 4_000,
      rawTailTokens: 4_500,
      includedUserMessages: 45,
      truncatedBoundaryMessages: 1,
      foldCalls: 2,
      repairCalls: 1,
      elapsedMs: 25,
      uncoveredRevisionRange: null,
    },
    warnings: [
      {
        code: 'target-capacity-fallback',
        message: 'PRIVATE_WARNING_DETAIL_SHOULD_NEVER_BE_ECHOED',
      },
    ],
    preparationHash: 'a'.repeat(64),
    spoolId: PRIVATE_SPOOL_ID,
  };
}

function lowerPreparedContext(): PreparedContinuationContext {
  const primary = preparedContext();
  return {
    ...primary,
    providerPrompt: `${PRIVATE_PROVIDER_CONTEXT}_LOWER`,
    metrics: {
      ...primary.metrics,
      targetPromptCapacityTokens: 8_000,
      estimatedPromptTokens: 7_000,
      rawTailTokens: 2_500,
      includedUserMessages: 21,
    },
    warnings: [],
    preparationHash: 'b'.repeat(64),
  };
}

function preparedHandOff(target: ResolvedSuccessorSpec): PreparedHandOffContinuation {
  const prepared = preparedContext();
  const generator: ResolvedContinuationGenerator = {
    adapter: 'claude-code',
    model: 'checkpoint-generator',
    thinking: 'medium',
    contextCapacity: unknownContextCapacity(),
    configFingerprint: 'PRIVATE_GENERATOR_FINGERPRINT',
  };
  return {
    prepared,
    turn: createTrustedContinuationInitialTurn(prepared, 'caller-sid'),
    generator,
    target,
    lowerBudgetRetry: null,
    settingsFingerprint: 'PRIVATE_SETTINGS_FINGERPRINT',
  };
}

function successfulTransfer() {
  return {
    tasks: { status: 'ok' as const, count: 2 },
    teams: {
      status: 'ok' as const,
      transferred: [{ teamId: 'team-a', role: 'lead' as const }],
      skipped: [],
      failed: [],
    },
    worktreeLease: { status: 'ok' as const, worktreePath: '/repo' },
  };
}

function preparedSpoolMetadata() {
  return {
    spoolId: PRIVATE_SPOOL_ID,
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
    spoolBytes: 4_096,
    rawTailTokens: 4_500,
    rawWarnings: [],
    rawScanTruncated: false,
    consumed: false,
  };
}

function testDeps(overrides: Partial<HandOffSessionHandlerDeps> = {}): HandOffSessionHandlerDeps {
  return {
    cutoverCoordinator: new HandOffCutoverCoordinator(() => null),
    cwdIsDirectory: () => true,
    sourceMaxEventId: () => 88,
    sourceRuntimeFingerprint: () => 'source-runtime-v1',
    validateTargetAdapter: () => null,
    prepareContinuation: vi.fn(async (input) => preparedHandOff(input.target)),
    spoolMetadata: () => preparedSpoolMetadata(),
    sourcePreconditionCheck: () => ({
      ok: true,
      currentEventRevision: 77,
      compatibleEventRows: 0,
      lateMessages: [],
    }),
    createSuccessor: vi.fn(async () => acceptedCandidate('successor-sid')),
    transferResources: vi.fn(() => successfulTransfer()),
    closeSuccessor: vi.fn(async () => undefined),
    finalizeSource: vi.fn(async () => undefined),
    cleanupSpool: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handOffSessionHandler unified continuation pipeline', () => {
  it('rejects external callers before target resolution or paid preparation', async () => {
    const prepareContinuation = vi.fn();
    const result = await handOffSessionHandler(
      { prompt: 'continue from /tmp/handoff.md', adapter: 'claude-code' },
      { caller: { callerSessionId: '__external__', transport: 'http' } },
      testDeps({ prepareContinuation }),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('not allowed for external caller');
    expect(prepareContinuation).not.toHaveBeenCalled();
  });

  it('freezes complete same-adapter options before preparing one trusted continuation turn', async () => {
    vi.spyOn(sessionRepo, 'get').mockReturnValue(callerRow());
    const order: string[] = [];
    const prepareContinuation = vi.fn(async (input) => {
      order.push('prepare');
      return preparedHandOff(input.target);
    });
    const createSuccessor = vi.fn(async (target, turn) => {
      order.push('create');
      expect(target).toMatchObject({
        agentId: 'codex-cli',
        cwd: '/next',
        model: 'gpt-target',
        modelReasoningEffort: 'xhigh',
        codexSandbox: 'read-only',
        extraAllowWrite: ['/extra'],
        networkAccessEnabled: true,
        additionalDirectories: ['/tmp'],
        awaitCanonicalId: true,
        handOff: {
          mode: 'session',
          fromCallerSid: 'caller-sid',
          sourceMaxEventId: 88,
        },
      });
      expect(target).not.toHaveProperty('prompt');
      expect(turn.providerPrompt).toBe(PRIVATE_PROVIDER_CONTEXT);
      return acceptedCandidate('successor-sid');
    });
    const transferResources = vi.fn(() => {
      order.push('transfer');
      return successfulTransfer();
    });
    const finalizeSource = vi.fn(async () => {
      order.push('finalize');
    });

    const result = await handOffSessionHandler(
      {
        prompt: 'Read /tmp/handoff.md, then continue.',
        cwd: '/next',
        model: 'gpt-target',
        thinking: 'xhigh',
      },
      ctx(),
      testDeps({
        prepareContinuation,
        createSuccessor,
        transferResources,
        finalizeSource,
      }),
    );

    expect(result.isError).toBeFalsy();
    expect(order).toEqual(['prepare', 'create', 'transfer', 'finalize']);
    expect(prepareContinuation).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceSessionId: 'caller-sid',
        continuationInstruction: 'Read /tmp/handoff.md, then continue.',
        target: expect.objectContaining({
          adapter: 'codex-cli',
          model: 'gpt-target',
          thinking: 'xhigh',
          networkAccessEnabled: true,
          additionalDirectories: ['/tmp'],
        }),
      }),
    );
    expect(transferResources).toHaveBeenCalledWith({
      callerSessionId: 'caller-sid',
      newSessionId: 'successor-sid',
    });
  });

  it('does not reject its own preparation when only the refreshed capacity snapshot changes', async () => {
    const source = callerRow();
    vi.spyOn(sessionRepo, 'get').mockReturnValue(source);
    const first = resolveHandOffTarget({
      source,
      request: { adapter: 'codex-cli', cwd: '/repo' },
      sourceMaxEventId: 88,
    });
    const second = {
      ...first,
      spec: {
        ...first.spec,
        contextCapacity: observedContextCapacity(64_000, {
          adapter: 'codex-cli', runtimeProvider: 'openai', model: 'gpt-source',
        }),
      },
    };
    const resolveTarget = vi.fn().mockReturnValue(first);
    const revalidateTarget = vi.fn().mockReturnValue(second);

    const result = await handOffSessionHandler(
      { prompt: 'continue' },
      ctx(),
      testDeps({ resolveTarget, revalidateTarget }),
    );

    expect(result.isError).toBeFalsy();
    expect(resolveTarget).toHaveBeenCalledOnce();
    expect(revalidateTarget).toHaveBeenCalledWith(
      expect.any(Object),
      first.spec.contextCapacity,
    );
    expect(first.spec.runtimeFingerprint).toBe(second.spec.runtimeFingerprint);
  });

  it('reports the preparation and metrics of the accepted lower-budget candidate', async () => {
    vi.spyOn(sessionRepo, 'get').mockReturnValue(callerRow());
    const createSuccessor = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: 'rejected-primary',
        acceptance: Promise.resolve({
          status: 'rejected',
          reason: 'context-window-exceeded',
        }),
      })
      .mockResolvedValueOnce(acceptedCandidate('accepted-retry'));
    const prepareContinuation = vi.fn(async (input) => {
      const result = preparedHandOff(input.target);
      const lower = lowerPreparedContext();
      return {
        ...result,
        lowerBudgetRetry: {
          prepared: lower,
          turn: createTrustedContinuationInitialTurn(lower, 'caller-sid'),
        },
      };
    });

    const result = await handOffSessionHandler(
      { prompt: 'continue' },
      ctx(),
      testDeps({
        prepareContinuation,
        createSuccessor,
        rollbackRejectedSuccessor: vi.fn(async () => undefined),
      }),
    );

    expect(result.isError).toBeFalsy();
    expect(parseResult(result).continuationContext).toMatchObject({
      preparationHash: 'b'.repeat(64),
      usedLowerBudgetRetry: true,
      includedUserMessages: 21,
      tokenStats: {
        targetPromptCapacity: 8_000,
        estimatedPrompt: 7_000,
        rawTail: 2_500,
      },
    });
  });

  it('returns a terminal structured diagnostic when candidate startup has no stable id', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(sessionRepo, 'get').mockReturnValue(callerRow());
      let resolveCreation!: (value: TrustedContinuationSessionCandidate) => void;
      const creation = new Promise<TrustedContinuationSessionCandidate>((resolve) => {
        resolveCreation = resolve;
      });
      const closeSuccessor = vi.fn(async () => undefined);
      const work = handOffSessionHandler(
        { prompt: 'continue' },
        ctx(),
        testDeps({
          createSuccessor: vi.fn(() => creation),
          closeSuccessor,
          readinessDeadlineMs: 25,
        }),
      );

      await vi.advanceTimersByTimeAsync(25);
      const result = await work;
      expect(result.isError).toBe(true);
      expect(parseResult(result)).toMatchObject({
        successorSessionId: null,
        successorClosed: 'pending',
        usedLowerBudgetRetry: false,
      });
      expect(result.content[0]?.text).toContain('startup exceeded');

      resolveCreation(acceptedCandidate('late-successor'));
      await vi.waitFor(() => expect(closeSuccessor).toHaveBeenCalledWith('late-successor'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports no cleanup when readiness expires before candidate creation begins', async () => {
    vi.spyOn(sessionRepo, 'get').mockReturnValue(callerRow());
    const createSuccessor = vi.fn(async () => acceptedCandidate('must-not-start'));

    const result = await handOffSessionHandler(
      { prompt: 'continue' },
      ctx(),
      testDeps({ createSuccessor, readinessDeadlineMs: 0 }),
    );

    expect(result.isError).toBe(true);
    expect(parseResult(result)).toMatchObject({
      successorSessionId: null,
      successorClosed: 'ok',
      usedLowerBudgetRetry: false,
    });
    expect(result.content[0]?.text).toContain(
      'did not produce a stable session before the readiness deadline',
    );
    expect(result.content[0]?.text).toContain('No successor remains');
    expect(result.content[0]?.text).not.toContain('late candidate');
    expect(createSuccessor).not.toHaveBeenCalled();
  });

  it('returns a terminal diagnostic when lower-budget startup rejects before a stable id', async () => {
    vi.spyOn(sessionRepo, 'get').mockReturnValue(callerRow());
    const privateFailure = 'PRIVATE_RETRY_STARTUP_DETAIL_SHOULD_NOT_LEAK';
    const createSuccessor = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: 'rejected-primary',
        acceptance: Promise.resolve({
          status: 'rejected',
          reason: 'context-window-exceeded',
        }),
      })
      .mockRejectedValueOnce(new Error(privateFailure));
    const prepareContinuation = vi.fn(async (input) => {
      const result = preparedHandOff(input.target);
      const lower = lowerPreparedContext();
      return {
        ...result,
        lowerBudgetRetry: {
          prepared: lower,
          turn: createTrustedContinuationInitialTurn(lower, 'caller-sid'),
        },
      };
    });

    const result = await handOffSessionHandler(
      { prompt: 'continue' },
      ctx(),
      testDeps({
        prepareContinuation,
        createSuccessor,
        rollbackRejectedSuccessor: vi.fn(async () => undefined),
      }),
    );

    expect(result.isError).toBe(true);
    expect(parseResult(result)).toMatchObject({
      successorSessionId: null,
      successorClosed: 'ok',
      usedLowerBudgetRetry: true,
    });
    expect(result.content[0]?.text).toContain('lower-budget successor failed to start');
    expect(result.content[0]?.text).not.toContain(privateFailure);
    expect(createSuccessor).toHaveBeenCalledTimes(2);
  });

  it('always releases ingress ownership when the final source probe throws', async () => {
    vi.spyOn(sessionRepo, 'get')
      .mockReturnValueOnce(callerRow())
      .mockReturnValueOnce(callerRow())
      .mockReturnValueOnce(callerRow())
      .mockImplementationOnce(() => {
        throw new Error('database unavailable during final probe');
      });

    const result = await handOffSessionHandler(
      { prompt: 'continue' },
      ctx(),
      testDeps(),
    );

    expect(result.isError).toBeFalsy();
    const nextLease = handOffCutoverCoordinator.tryAcquire('caller-sid');
    expect(nextLease).not.toBeNull();
    nextLease?.release();
  });

  it('uses target defaults for cross-adapter options and validates thinking before preparation', async () => {
    vi.spyOn(sessionRepo, 'get').mockReturnValue(callerRow());
    const seenTargets: unknown[] = [];
    const createSuccessor = vi.fn(async (target) => {
      seenTargets.push(target);
      return acceptedCandidate('successor-sid');
    });
    const deps = testDeps({ createSuccessor });

    const success = await handOffSessionHandler(
      {
        prompt: 'continue',
        adapter: 'claude-code',
        gateway: 'deepseek',
        cwd: '/repo',
      },
      ctx(),
      deps,
    );

    expect(success.isError).toBeFalsy();
    expect(seenTargets[0]).toMatchObject({
      agentId: 'claude-code',
      gateway: 'deepseek',
      cwd: '/repo',
      permissionMode: 'bypassPermissions',
      awaitCanonicalId: true,
    });
    expect(seenTargets[0]).not.toHaveProperty('model');
    expect(seenTargets[0]).not.toHaveProperty('codexSandbox');
    expect(seenTargets[0]).not.toHaveProperty('extraAllowWrite');
    expect(seenTargets[0]).not.toHaveProperty('networkAccessEnabled');
    expect(seenTargets[0]).not.toHaveProperty('additionalDirectories');

    const prepareContinuation = vi.fn();
    const invalid = await handOffSessionHandler(
      { prompt: 'continue', adapter: 'claude-code', thinking: 'ultra' },
      ctx(),
      testDeps({ prepareContinuation }),
    );
    expect(invalid.isError).toBe(true);
    expect(invalid.content[0]?.text).toContain('handoff target thinking is invalid');
    expect(prepareContinuation).not.toHaveBeenCalled();
  });

  it('closes an orphan and preserves the source when mandatory transfer fails', async () => {
    vi.spyOn(sessionRepo, 'get').mockReturnValue(callerRow());
    const closeSuccessor = vi.fn(async () => undefined);
    const finalizeSource = vi.fn();
    const cleanupSpool = vi.fn();
    const resourceTransfer = {
      tasks: { status: 'failed' as const, count: 0, error: 'task transfer failed' },
      teams: {
        status: 'failed' as const,
        transferred: [],
        skipped: [],
        failed: [{ teamId: 'team-a', role: 'lead' as const, reason: 'swap failed' }],
      },
      worktreeLease: { status: 'skipped' as const, worktreePath: null },
    };

    const result = await handOffSessionHandler(
      { prompt: 'continue' },
      ctx(),
      testDeps({
        transferResources: () => resourceTransfer,
        closeSuccessor,
        finalizeSource,
        cleanupSpool,
      }),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('retrying can duplicate');
    expect(closeSuccessor).toHaveBeenCalledWith('successor-sid');
    expect(finalizeSource).not.toHaveBeenCalled();
    expect(cleanupSpool).toHaveBeenCalledWith(PRIVATE_SPOOL_ID);
    expect(parseResult(result)).toMatchObject({
      successorSessionId: 'successor-sid',
      successorClosed: 'ok',
      resourceTransfer,
    });
  });

  it('classifies a thrown transfer without exposing its internal error detail', async () => {
    vi.spyOn(sessionRepo, 'get').mockReturnValue(callerRow());
    const closeSuccessor = vi.fn(async () => undefined);
    const finalizeSource = vi.fn();
    const result = await handOffSessionHandler(
      { prompt: 'continue' },
      ctx(),
      testDeps({
        transferResources: () => {
          throw new Error('PRIVATE_TRANSFER_ERROR_SHOULD_NEVER_LEAK');
        },
        closeSuccessor,
        finalizeSource,
      }),
    );

    expect(result.isError).toBe(true);
    expect(closeSuccessor).toHaveBeenCalledWith('successor-sid');
    expect(finalizeSource).not.toHaveBeenCalled();
    expect(parseResult(result)).toMatchObject({
      successorSessionId: 'successor-sid',
      successorClosed: 'ok',
      resourceTransfer: null,
      transferFailure: 'exception',
    });
    expect(result.content[0]?.text).not.toContain('PRIVATE_TRANSFER_ERROR');
  });

  it('does not create a successor if the source closes during preparation', async () => {
    vi.spyOn(sessionRepo, 'get')
      .mockReturnValueOnce(callerRow())
      .mockReturnValueOnce(callerRow())
      .mockReturnValueOnce(callerRow({ lifecycle: 'closed', endedAt: 2 }));
    const createSuccessor = vi.fn();
    const cleanupSpool = vi.fn();

    const result = await handOffSessionHandler(
      { prompt: 'continue' },
      ctx(),
      testDeps({ createSuccessor, cleanupSpool }),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('source session changed or closed');
    expect(createSuccessor).not.toHaveBeenCalled();
    expect(cleanupSpool).toHaveBeenCalledWith(PRIVATE_SPOOL_ID);
  });

  it('does not echo provider/spool detail from a preparation failure', async () => {
    vi.spyOn(sessionRepo, 'get').mockReturnValue(callerRow());
    const createSuccessor = vi.fn();
    const result = await handOffSessionHandler(
      { prompt: 'continue' },
      ctx(),
      testDeps({
        prepareContinuation: async () => {
          throw new Error(`${PRIVATE_PROVIDER_CONTEXT} ${PRIVATE_SPOOL_ID}`);
        },
        createSuccessor,
      }),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('failed to prepare continuation context');
    expect(result.content[0]?.text).not.toContain(PRIVATE_PROVIDER_CONTEXT);
    expect(result.content[0]?.text).not.toContain(PRIVATE_SPOOL_ID);
    expect(createSuccessor).not.toHaveBeenCalled();
  });

  it('returns a warning when source finalization fails without invalidating the successor', async () => {
    vi.spyOn(sessionRepo, 'get').mockReturnValue(callerRow());
    const closeSuccessor = vi.fn();
    const result = await handOffSessionHandler(
      { prompt: 'continue' },
      ctx(),
      testDeps({
        closeSuccessor,
        finalizeSource: async () => {
          throw new Error('source close secret detail');
        },
      }),
    );

    expect(result.isError).toBeFalsy();
    expect(closeSuccessor).not.toHaveBeenCalled();
    const data = parseResult(result);
    expect(data.sessionId).toBe('successor-sid');
    expect(data.callerClosed).toBe('failed');
    expect(data.warnings).toEqual(['source-finalization-failed']);
    expect(JSON.stringify(result)).not.toContain('source close secret detail');
  });

  it('rejects a second mutating call from the in-process predecessor after successful handoff', async () => {
    let currentSource = callerRow();
    const successor = callerRow({ id: 'successor-sid', title: 'successor' });
    vi.spyOn(sessionRepo, 'get').mockImplementation((sessionId) => {
      if (sessionId === currentSource.id) return currentSource;
      if (sessionId === successor.id) return successor;
      return null;
    });
    const close = vi.spyOn(sessionManager, 'close').mockImplementation(async () => undefined);

    const handoff = await handOffSessionHandler(
      { prompt: 'continue' },
      ctx(),
      testDeps({
        finalizeSource: () => {
          currentSource = {
            ...currentSource,
            lifecycle: 'closed',
            endedAt: Date.now(),
          };
        },
      }),
    );
    expect(handoff.isError).toBeFalsy();

    const shutdown = await shutdownSessionHandler(
      { sessionId: 'successor-sid', reason: 'predecessor must no longer control successor' },
      ctx(),
    );

    expect(shutdown.isError).toBe(true);
    expect(shutdown.content[0]?.text).toContain('callerSessionId caller-sid is closed');
    expect(close).not.toHaveBeenCalled();
  });

  it.skipIf(!bindingAvailable)(
    'keeps the real SQLite teammate move committed when source finalization fails',
    async () => {
      const db = makeMemoryDb();
      try {
        insertSession(db, 'team-lead');
        insertSession(db, 'caller-sid');
        insertSession(db, 'successor-sid');
        const teamRepo = createAgentDeckTeamRepo(db);
        const team = teamRepo.create({ name: 'handoff-finalization-boundary' });
        teamRepo.addMember({ teamId: team.id, sessionId: 'team-lead', role: 'lead' });
        teamRepo.addMember({
          teamId: team.id,
          sessionId: 'caller-sid',
          role: 'teammate',
          displayName: 'batch-s',
        });
        vi.spyOn(sessionRepo, 'get').mockReturnValue(callerRow());

        const result = await handOffSessionHandler(
          { prompt: 'continue' },
          ctx(),
          testDeps({
            transferResources: () => {
              const membership = transferTeammateMembershipWithDb(
                db,
                team.id,
                'caller-sid',
                'successor-sid',
              );
              if (membership.transferred !== true) throw new Error(membership.reason);
              return {
                tasks: { status: 'ok', count: 0 },
                teams: {
                  status: 'ok',
                  transferred: [{ teamId: team.id, role: 'teammate' }],
                  skipped: [],
                  failed: [],
                },
                worktreeLease: { status: 'skipped', worktreePath: null },
              };
            },
            finalizeSource: () => {
              throw new Error('simulated crash before best-effort finalization');
            },
          }),
        );

        expect(result.isError).toBeFalsy();
        expect(parseResult(result)).toMatchObject({
          callerClosed: 'failed',
          warnings: ['source-finalization-failed'],
        });
        expect(teamRepo.findActiveMembershipIn(team.id, 'caller-sid')).toBeNull();
        expect(teamRepo.findActiveMembershipIn(team.id, 'successor-sid')).toMatchObject({
          role: 'teammate',
          displayName: 'batch-s',
          leftAt: null,
        });
      } finally {
        db.close();
      }
    },
  );

  it('carries provider input queued before the cutover lease into the successor', async () => {
    vi.spyOn(sessionRepo, 'get').mockReturnValue(callerRow());
    const deliverLateMessages = vi.fn(async () => []);

    const result = await handOffSessionHandler(
      { prompt: 'continue' },
      ctx(),
      testDeps({
        snapshotQueuedMessages: () => [{ text: 'queued before handoff' }],
        deliverLateMessages,
      }),
    );

    expect(result.isError).toBeFalsy();
    expect(deliverLateMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        successorSessionId: 'successor-sid',
        messages: [expect.objectContaining({ text: 'queued before handoff' })],
      }),
    );
    expect(parseResult(result).continuationContext.lateMessagesDelivered).toBe(1);
  });

  it('returns compact metadata without provider context, instruction, spool, or runtime fingerprints', async () => {
    vi.spyOn(sessionRepo, 'get').mockReturnValue(callerRow());
    const result = await handOffSessionHandler(
      { prompt: 'PRIVATE_CALLER_INSTRUCTION_SHOULD_NEVER_BE_ECHOED' },
      ctx(),
      testDeps(),
    );

    expect(result.isError).toBeFalsy();
    const data = parseResult(result);
    expect(data).toMatchObject({
      sessionId: 'successor-sid',
      adapter: 'codex-cli',
      gateway: null,
      provider: null,
      cwd: '/repo',
      callerClosed: 'ok',
      continuationContext: {
        version: 2,
        quality: 'projected',
        sourceEventRevision: 77,
        cutoverEventRevision: 77,
        lateMessagesDelivered: 0,
        usedLowerBudgetRetry: false,
        checkpoint: { id: 12, formatVersion: 1, throughRevision: 77 },
        preparationHash: 'a'.repeat(64),
        tokenStats: {
          rawRetentionCeiling: 64_000,
          targetPromptCapacity: 104_000,
          checkpointProjectionBudget: 12_000,
          generatorFoldInputBudget: 32_000,
          estimatedPrompt: 9_000,
        },
        warningCodes: ['target-capacity-fallback'],
      },
    });
    expect(data).not.toHaveProperty('initialPrompt');
    expect(data).not.toHaveProperty('continuationInstruction');
    expect(data).not.toHaveProperty('providerPrompt');
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain(PRIVATE_PROVIDER_CONTEXT);
    expect(serialized).not.toContain('PRIVATE_CALLER_INSTRUCTION');
    expect(serialized).not.toContain('PRIVATE_CURRENT_INSTRUCTION');
    expect(serialized).not.toContain(PRIVATE_SPOOL_ID);
    expect(serialized).not.toContain('PRIVATE_GENERATOR_FINGERPRINT');
    expect(serialized).not.toContain('PRIVATE_SETTINGS_FINGERPRINT');
    expect(serialized).not.toContain('runtimeFingerprint');
    expect(serialized).not.toContain('configFingerprint');
    expect(serialized).not.toContain('PRIVATE_WARNING_DETAIL');
  });

  it('uses the no-self-interrupt source finalizer after transfer', async () => {
    vi.spyOn(sessionRepo, 'get').mockReturnValue(callerRow());
    const markClosed = vi.spyOn(sessionManager, 'markClosed').mockImplementation(() => undefined);
    const close = vi.spyOn(sessionManager, 'close').mockImplementation(async () => undefined);
    const release = vi.spyOn(mcpSessionTokenMap, 'release').mockImplementation(() => undefined);
    const retire = vi.fn();
    vi.spyOn(adapterRegistry, 'get').mockReturnValue({
      retireSessionAfterCurrentTurn: retire,
    } as unknown as ReturnType<typeof adapterRegistry.get>);
    const deps = testDeps();
    delete deps.finalizeSource;

    const result = await handOffSessionHandler({ prompt: 'continue' }, ctx(), deps);

    expect(result.isError).toBeFalsy();
    expect(markClosed).toHaveBeenCalledWith('caller-sid');
    expect(release).toHaveBeenCalledWith('caller-sid');
    expect(retire).toHaveBeenCalledWith('caller-sid');
    expect(markClosed.mock.invocationCallOrder[0]).toBeLessThan(retire.mock.invocationCallOrder[0]);
    expect(release.mock.invocationCallOrder[0]).toBeLessThan(retire.mock.invocationCallOrder[0]);
    expect(close).not.toHaveBeenCalledWith('caller-sid');
  });

  it('attempts token revocation and runtime retirement even when marking the source closed fails', async () => {
    vi.spyOn(sessionRepo, 'get').mockReturnValue(callerRow());
    const markClosed = vi.spyOn(sessionManager, 'markClosed').mockImplementation(() => {
      throw new Error('lifecycle write failed');
    });
    const release = vi.spyOn(mcpSessionTokenMap, 'release').mockImplementation(() => {
      throw new Error('token map failed');
    });
    const retire = vi.fn();
    vi.spyOn(adapterRegistry, 'get').mockReturnValue({
      retireSessionAfterCurrentTurn: retire,
    } as unknown as ReturnType<typeof adapterRegistry.get>);
    const deps = testDeps();
    delete deps.finalizeSource;

    const result = await handOffSessionHandler({ prompt: 'continue' }, ctx(), deps);

    expect(result.isError).toBeFalsy();
    expect(markClosed).toHaveBeenCalledWith('caller-sid');
    expect(release).toHaveBeenCalledWith('caller-sid');
    expect(retire).toHaveBeenCalledWith('caller-sid');
    expect(parseResult(result)).toMatchObject({
      sessionId: 'successor-sid',
      callerClosed: 'failed',
      warnings: ['source-finalization-failed'],
    });
  });
});
