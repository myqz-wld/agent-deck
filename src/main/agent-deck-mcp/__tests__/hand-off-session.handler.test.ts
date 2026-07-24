import { afterEach, describe, expect, it, vi } from 'vitest';
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
import { handOffCutoverCoordinator } from '@main/session/hand-off/cutover-coordinator';
import { sessionRepo } from '@main/store/session-repo';
import type { SessionRecord } from '@shared/types';
import { handOffSessionHandler } from '../tools/handlers/hand-off-session';
import type { HandOffSessionHandlerDeps } from '../tools/handlers/hand-off-session/_deps';
import type { HandlerContext, HandlerResult } from '../tools/helpers';

const PRIVATE_PROVIDER_CONTEXT = 'PRIVATE_PROVIDER_CONTEXT_SHOULD_NEVER_LEAK';
const PRIVATE_SPOOL_ID = 'PRIVATE_SPOOL_ID_SHOULD_NEVER_LEAK';

function parseResult(result: HandlerResult): Record<string, any> {
  return JSON.parse(result.content[0]?.text ?? '{}') as Record<string, any>;
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
    version: 1,
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

function preparedHandOff(target: ResolvedSuccessorSpec): PreparedHandOffContinuation {
  const prepared = preparedContext();
  const generator: ResolvedContinuationGenerator = {
    adapter: 'claude-code',
    model: 'checkpoint-generator',
    thinking: 'medium',
    contextWindowTokens: null,
    configFingerprint: 'PRIVATE_GENERATOR_FINGERPRINT',
  };
  return {
    prepared,
    turn: createTrustedContinuationInitialTurn(prepared, 'caller-sid'),
    generator,
    target,
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
    worktreeMarker: { status: 'ok' as const, marker: '/repo' },
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
    createSuccessor: vi.fn(async () => 'successor-sid'),
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
      { caller: { callerSessionId: '__external__', transport: 'stdio' } },
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
      return 'successor-sid';
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
      callerRow: expect.objectContaining({ id: 'caller-sid' }),
      newSessionId: 'successor-sid',
    });
  });

  it('always releases ingress ownership when the final source probe throws', async () => {
    vi.spyOn(sessionRepo, 'get')
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
      return 'successor-sid';
    });
    const deps = testDeps({ createSuccessor });

    const success = await handOffSessionHandler(
      {
        prompt: 'continue',
        adapter: 'claude-code',
        provider: 'deepseek',
        cwd: '/repo',
      },
      ctx(),
      deps,
    );

    expect(success.isError).toBeFalsy();
    expect(seenTargets[0]).toMatchObject({
      agentId: 'claude-code',
      provider: 'deepseek',
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
      worktreeMarker: { status: 'skipped' as const, marker: null },
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
    expect(result.content[0]?.text).not.toContain('source close secret detail');
  });

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
      cwd: '/repo',
      callerClosed: 'ok',
      continuationContext: {
        version: 1,
        quality: 'projected',
        sourceEventRevision: 77,
        cutoverEventRevision: 77,
        lateMessagesDelivered: 0,
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
