import { describe, expect, it, vi } from 'vitest';
import type { CreateSessionOptions } from '@main/adapters/types';
import type { SessionEventRevisionState } from '@main/store/event-revision-repo';
import type { SessionHandOffTarget, SessionRecord } from '@shared/types';
import type { PreparedHandOffContinuation } from '../../continuation-context/handoff';
import { createTrustedContinuationInitialTurn } from '../../continuation-context/initial-turn';
import { ContinuationPreparationCache } from '../../continuation-context/preparation-cache';
import { estimateContinuationTokens, utf8ByteLength } from '../../continuation-context/token-estimator';
import type {
  PreparedContinuationContext,
  ResolvedContinuationGenerator,
  ResolvedSuccessorSpec,
} from '../../continuation-context/types';
import { HandOffExecutionError } from '../executor';
import type { ResolvedHandOffTarget } from '../target-resolver';
import {
  boundedContinuationPreview,
  UI_CONTINUATION_PREVIEW_MAX_BYTES,
  UI_CONTINUATION_PREVIEW_MAX_TOKENS,
  UiHandOffCoordinator,
  type UiHandOffExecutionResult,
} from '../ui-coordinator';

const OWNER = 'ui:renderer-1';
const OTHER_OWNER = 'ui:renderer-2';
const SOURCE_ID = 'source-session';

const generator: ResolvedContinuationGenerator = {
  adapter: 'claude-code',
  model: 'checkpoint-model',
  thinking: 'low',
  contextWindowTokens: 128_000,
  configFingerprint: 'generator-config-secret',
};

function makeSource(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: SOURCE_ID,
    agentId: 'claude-code',
    cwd: '/repo',
    title: 'source',
    source: 'sdk',
    lifecycle: 'active',
    activity: 'idle',
    startedAt: 1,
    lastEventAt: 2,
    endedAt: null,
    archivedAt: null,
    permissionMode: 'acceptEdits',
    claudeCodeSandbox: 'workspace-write',
    model: 'source-model',
    thinking: 'medium',
    extraAllowWrite: ['/also-write'],
    ...overrides,
  };
}

function makeTarget(overrides: {
  runtimeFingerprint?: string;
  createOptions?: Partial<CreateSessionOptions>;
} = {}): ResolvedHandOffTarget {
  const createOptions = {
    agentId: 'codex-cli',
    cwd: '/repo',
    model: 'target-model',
    modelReasoningEffort: 'high',
    codexSandbox: 'read-only',
    networkAccessEnabled: true,
    additionalDirectories: ['/tmp'],
    awaitCanonicalId: true,
    handOff: {
      mode: 'session',
      fromCallerSid: SOURCE_ID,
      sourceMaxEventId: 42,
    },
    ...overrides.createOptions,
  } as CreateSessionOptions;
  const spec: ResolvedSuccessorSpec = {
    adapter: 'codex-cli',
    model: 'target-model',
    thinking: 'high',
    sandbox: { kind: 'codex', mode: 'read-only', extraAllowWrite: [] },
    permissionMode: null,
    networkAccessEnabled: true,
    additionalDirectories: ['/tmp'],
    contextWindowTokens: 128_000,
    contextWindowSource: 'observed',
    runtimeFingerprint: overrides.runtimeFingerprint ?? 'target-runtime-secret',
  };
  return { spec, createOptions };
}

function makePrepared(
  sequence: number,
  overrides: Partial<PreparedContinuationContext> = {},
): PreparedContinuationContext {
  const persistedUserText = `authoritative next step ${sequence}`;
  return {
    version: 1,
    providerPrompt: `Agent Deck Continuation Context v1\nsource history ${sequence}\n${persistedUserText}`,
    persistedUserText,
    source: { eventRevision: 7, rebuildAfterRevision: 2, maxEventId: 42 },
    checkpoint: { id: 11, throughRevision: 6, formatVersion: 1, refreshed: true },
    projection: { canonicalHash: 'canonical-secret', omittedFacts: 0 },
    quality: 'full',
    metrics: {
      rawRetentionCeilingTokens: 64_000,
      targetPromptCapacityTokens: 100_000,
      checkpointProjectionBudgetTokens: 12_000,
      generatorFoldInputBudgetTokens: 32_000,
      estimatedPromptTokens: 40,
      checkpointTokens: 20,
      rawTailTokens: 10,
      includedUserMessages: 3,
      truncatedBoundaryMessages: 0,
      foldCalls: 1,
      repairCalls: 0,
      elapsedMs: 5,
      uncoveredRevisionRange: null,
    },
    warnings: [],
    preparationHash: `preparation-hash-secret-${sequence}`,
    spoolId: `spool-secret-${sequence}`,
    ...overrides,
  };
}

interface MutableHarnessState {
  source: SessionRecord | null;
  eventState: SessionEventRevisionState | null;
  sourceRuntimeFingerprint: string | null;
  settingsFingerprint: string;
  target: ResolvedHandOffTarget;
}

function createHarness() {
  const state: MutableHarnessState = {
    source: makeSource(),
    eventState: {
      sessionId: SOURCE_ID,
      revision: 7,
      rebuildAfterRevision: 2,
    },
    sourceRuntimeFingerprint: 'source-runtime-secret',
    settingsFingerprint: 'settings-secret',
    target: makeTarget(),
  };
  const cleanupSpool = vi.fn<(spoolId: string) => void>();
  const cache = new ContinuationPreparationCache({
    onEvict: (entry) => cleanupSpool(entry.prepared.spoolId),
  });
  let sequence = 0;
  const preparedValues: PreparedContinuationContext[] = [];
  const prepare = vi.fn(async (): Promise<PreparedHandOffContinuation> => {
    const prepared = makePrepared(++sequence);
    preparedValues.push(prepared);
    return {
      prepared,
      turn: createTrustedContinuationInitialTurn(prepared, SOURCE_ID),
      generator,
      target: state.target.spec,
      settingsFingerprint: state.settingsFingerprint,
    };
  });
  const resolveTarget = vi.fn(() => state.target);
  const execute = vi.fn(
    async (): Promise<UiHandOffExecutionResult> => ({
      successorSessionId: 'successor-session',
      sourceFinalization: { ok: true, value: undefined },
    }),
  );
  const coordinator = new UiHandOffCoordinator({
    cache,
    getSession: () => state.source,
    eventState: () => state.eventState,
    maxEventId: () => 42,
    sourceRuntimeFingerprint: () => state.sourceRuntimeFingerprint,
    resolveTarget,
    prepare,
    currentSettingsFingerprint: () => state.settingsFingerprint,
    spoolMetadata: (spoolId) => ({
      spoolId,
      sessionId: SOURCE_ID,
      createdAt: 1,
      expiresAt: 2,
      lastAccessedAt: 1,
      captureRevision: 7,
      rebuildAfterRevision: 2,
      maxEventId: 42,
      runtimeFingerprint: 'source-runtime-secret',
      checkpoint: null,
      checkpointThroughRevision: 6,
      materializedThroughRevision: 7,
      uncoveredRevisionRange: null,
      spoolBytes: 4096,
      rawTailTokens: 10,
      rawWarnings: [],
      rawScanTruncated: false,
      consumed: false,
    }),
    cleanupSpool,
    execute,
    isTransferExecutionError: (error): error is HandOffExecutionError<unknown> =>
      error instanceof HandOffExecutionError,
  });
  const selection: SessionHandOffTarget = {
    adapter: 'codex-cli',
    model: 'target-model',
    thinking: 'high',
  };

  return {
    coordinator,
    cache,
    cleanupSpool,
    execute,
    prepare,
    preparedValues,
    resolveTarget,
    selection,
    state,
    prepareOne: () =>
      coordinator.prepare({
        ownerSessionId: OWNER,
        sourceSessionId: SOURCE_ID,
        continuationInstruction: 'authoritative next step',
        target: selection,
      }),
  };
}

describe('boundedContinuationPreview', () => {
  it.each([
    ['ASCII', 'front-ascii\n', 'x'.repeat(200_000), '\nauthoritative-ascii-suffix'],
    ['CJK', '前端出处\n', '历史事实'.repeat(50_000), '\n权威下一步指令'],
    ['emoji', '🧭 provenance\n', '🧩🚀'.repeat(40_000), '\n✅ authoritative suffix'],
  ])('bounds %s text while retaining the front and authoritative suffix', (_name, front, middle, suffix) => {
    const result = boundedContinuationPreview(`${front}${middle}${suffix}`);

    expect(result.truncated).toBe(true);
    expect(utf8ByteLength(result.preview)).toBeLessThanOrEqual(UI_CONTINUATION_PREVIEW_MAX_BYTES);
    expect(estimateContinuationTokens(result.preview)).toBeLessThanOrEqual(UI_CONTINUATION_PREVIEW_MAX_TOKENS);
    expect(result.preview.startsWith(front)).toBe(true);
    expect(result.preview.endsWith(suffix)).toBe(true);
    expect(result.preview).toContain('续接上下文预览已截断');
    expect(result.preview).not.toContain('\ufffd');
  });
});

describe('UiHandOffCoordinator', () => {
  it('freezes all private preparation inputs and exposes only a bounded public projection', async () => {
    const harness = createHarness();
    const publicResult = await harness.prepareOne();
    const entry = harness.cache.peek(publicResult.preparationId, OWNER);

    expect(harness.prepare).toHaveBeenCalledWith({
      sourceSessionId: SOURCE_ID,
      continuationInstruction: 'authoritative next step',
      target: harness.state.target.spec,
    });
    expect(entry.prepared).toBe(harness.preparedValues[0]);
    expect(entry.generator).toBe(generator);
    expect(entry.target).toBe(harness.state.target.spec);
    expect(entry.frozen).toMatchObject({
      sourceRuntimeFingerprint: 'source-runtime-secret',
      settingsFingerprint: 'settings-secret',
      targetSelection: harness.selection,
      createOptions: harness.state.target.createOptions,
      targetRuntimeFingerprint: 'target-runtime-secret',
    });
    expect(entry.frozen?.createOptionsFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(entry.frozen?.preparedIntegrityFingerprint).toMatch(/^[a-f0-9]{64}$/);

    expect(publicResult).toMatchObject({
      preparationId: entry.preparationId,
      previewTruncated: false,
      quality: 'full',
      source: { eventRevision: 7, rebuildAfterRevision: 2 },
      checkpoint: { id: 11, throughRevision: 6, formatVersion: 1, refreshed: true },
      target: { adapter: 'codex-cli', model: 'target-model', thinking: 'high' },
    });
    const publicKeys = JSON.stringify(publicResult);
    expect(publicKeys).not.toContain('providerPrompt');
    expect(publicKeys).not.toContain('persistedUserText');
    expect(publicKeys).not.toContain('spoolId');
    expect(publicKeys).not.toContain('Fingerprint');
    expect(publicKeys).not.toContain('preparationHash');
    expect(publicKeys).not.toContain('source-runtime-secret');
    expect(publicKeys).not.toContain('settings-secret');
    expect(publicKeys).not.toContain('preparation-hash-secret');
    expect(publicKeys).not.toContain('spool-secret');
  });

  it('enforces owner authorization without destroying the owner preparation', async () => {
    const harness = createHarness();
    const preparation = await harness.prepareOne();

    await expect(
      harness.coordinator.commit(OTHER_OWNER, preparation.preparationId),
    ).rejects.toThrow(/not authorized/);
    expect(() => harness.coordinator.cancel(OTHER_OWNER, preparation.preparationId)).toThrow(
      /not authorized/,
    );
    expect(harness.execute).not.toHaveBeenCalled();
    expect(harness.cache.size).toBe(1);
    expect(harness.cleanupSpool).not.toHaveBeenCalled();

    expect(harness.coordinator.cancel(OWNER, preparation.preparationId)).toBe(true);
    expect(harness.cleanupSpool).toHaveBeenCalledWith('spool-secret-1');
  });

  it.each([
    ['same-id event update', { revision: 8, rebuildAfterRevision: 2 }],
    ['rebuild epoch advance', { revision: 7, rebuildAfterRevision: 3 }],
  ])('rejects stale %s before any execute/create/transfer side effect', async (_name, next) => {
    const harness = createHarness();
    const preparation = await harness.prepareOne();
    harness.state.eventState = {
      sessionId: SOURCE_ID,
      ...next,
    };

    await expect(
      harness.coordinator.commit(OWNER, preparation.preparationId),
    ).rejects.toThrow(/已过期/);
    expect(harness.execute).not.toHaveBeenCalled();
    expect(harness.cache.size).toBe(0);
    expect(harness.cleanupSpool).toHaveBeenCalledWith('spool-secret-1');
  });

  it.each(['source runtime', 'settings', 'target create options', 'target runtime'] as const)(
    'rejects %s drift before execution and cleans the preparation',
    async (kind) => {
      const harness = createHarness();
      const preparation = await harness.prepareOne();
      if (kind === 'source runtime') harness.state.sourceRuntimeFingerprint = 'source-runtime-v2';
      if (kind === 'settings') harness.state.settingsFingerprint = 'settings-v2';
      if (kind === 'target create options') {
        harness.state.target = makeTarget({
          createOptions: { codexSandbox: 'danger-full-access' },
        });
      }
      if (kind === 'target runtime') {
        harness.state.target = makeTarget({ runtimeFingerprint: 'target-runtime-v2' });
      }

      await expect(
        harness.coordinator.commit(OWNER, preparation.preparationId),
      ).rejects.toThrow(/已过期/);
      expect(harness.execute).not.toHaveBeenCalled();
      expect(harness.cache.size).toBe(0);
      expect(harness.cleanupSpool).toHaveBeenCalledWith('spool-secret-1');
    },
  );

  it.each([
    ['missing', null],
    ['closed', makeSource({ lifecycle: 'closed', endedAt: 100 })],
    ['archived', makeSource({ archivedAt: 100 })],
  ] as const)('rejects a %s source before execution and cleans the preparation', async (_kind, source) => {
    const harness = createHarness();
    const preparation = await harness.prepareOne();
    harness.state.source = source;

    await expect(
      harness.coordinator.commit(OWNER, preparation.preparationId),
    ).rejects.toThrow(/已过期/);
    expect(harness.execute).not.toHaveBeenCalled();
    expect(harness.cache.size).toBe(0);
    expect(harness.cleanupSpool).toHaveBeenCalledWith('spool-secret-1');
  });

  it('commits once with the frozen create options and trusted turn', async () => {
    const harness = createHarness();
    const preparation = await harness.prepareOne();
    const result = await harness.coordinator.commit(OWNER, preparation.preparationId);

    expect(result).toEqual({
      successorSessionId: 'successor-session',
      sourceFinalizationWarning: null,
    });
    expect(harness.execute).toHaveBeenCalledTimes(1);
    expect(harness.execute).toHaveBeenCalledWith({
      source: harness.state.source,
      sourcePrecondition: { eventRevision: 7, rebuildAfterRevision: 2, runtimeFingerprint: 'source-runtime-secret' },
      target: harness.state.target.createOptions,
      turn: expect.objectContaining({
        kind: 'trusted-continuation',
        providerPrompt: harness.preparedValues[0]?.providerPrompt,
        persistedUserText: harness.preparedValues[0]?.persistedUserText,
        metadata: expect.objectContaining({
          sourceSessionId: SOURCE_ID,
          preparationHash: 'preparation-hash-secret-1',
        }),
      }),
    });
    expect(harness.cache.size).toBe(0);
    expect(harness.cleanupSpool).toHaveBeenCalledWith('spool-secret-1');
    await expect(
      harness.coordinator.commit(OWNER, preparation.preparationId),
    ).rejects.toThrow(/not authorized/);
    expect(harness.execute).toHaveBeenCalledTimes(1);
  });

  it('deletes a transfer-failed preparation and never permits another attempt', async () => {
    const harness = createHarness();
    const preparation = await harness.prepareOne();
    harness.execute.mockRejectedValueOnce(
      new HandOffExecutionError(
        'mandatory transfer failed',
        'transfer',
        'orphan-successor',
        'ok',
        { failed: true },
        null,
      ),
    );

    await expect(
      harness.coordinator.commit(OWNER, preparation.preparationId),
    ).rejects.toMatchObject({ stage: 'transfer' });
    expect(harness.cache.size).toBe(0);
    expect(harness.cleanupSpool).toHaveBeenCalledWith('spool-secret-1');
    await expect(
      harness.coordinator.commit(OWNER, preparation.preparationId),
    ).rejects.toThrow(/not authorized/);
    expect(harness.execute).toHaveBeenCalledTimes(1);
  });

  it('allows exactly one same-snapshot retry after a pre-spawn failure', async () => {
    const harness = createHarness();
    const preparation = await harness.prepareOne();
    harness.execute
      .mockRejectedValueOnce(new Error('spawn failed before creation'))
      .mockRejectedValueOnce(new Error('retry also failed before creation'));

    await expect(
      harness.coordinator.commit(OWNER, preparation.preparationId),
    ).rejects.toThrow('spawn failed before creation');
    expect(harness.cache.size).toBe(1);
    expect(harness.cleanupSpool).not.toHaveBeenCalled();

    await expect(
      harness.coordinator.commit(OWNER, preparation.preparationId),
    ).rejects.toThrow('retry also failed before creation');
    expect(harness.execute).toHaveBeenCalledTimes(2);
    expect(harness.cache.size).toBe(0);
    expect(harness.cleanupSpool).toHaveBeenCalledWith('spool-secret-1');

    await expect(
      harness.coordinator.commit(OWNER, preparation.preparationId),
    ).rejects.toThrow(/not authorized/);
    expect(harness.execute).toHaveBeenCalledTimes(2);
  });

  it('keeps cancellation owner-bound and cleans its immutable spool', async () => {
    const harness = createHarness();
    const preparation = await harness.prepareOne();

    expect(() => harness.coordinator.cancel(OTHER_OWNER, preparation.preparationId)).toThrow(
      /not authorized/,
    );
    expect(harness.cache.size).toBe(1);
    expect(harness.cleanupSpool).not.toHaveBeenCalled();
    expect(harness.coordinator.cancel(OWNER, preparation.preparationId)).toBe(true);
    expect(harness.cache.size).toBe(0);
    expect(harness.cleanupSpool).toHaveBeenCalledTimes(1);
    expect(harness.cleanupSpool).toHaveBeenCalledWith('spool-secret-1');
  });

  it('serializes commits per source while leaving the rejected preparation reusable', async () => {
    const harness = createHarness();
    const first = await harness.prepareOne();
    const second = await harness.prepareOne();
    let finishFirst!: (result: UiHandOffExecutionResult) => void;
    harness.execute.mockImplementationOnce(
      () =>
        new Promise<UiHandOffExecutionResult>((resolve) => {
          finishFirst = resolve;
        }),
    );

    const firstCommit = harness.coordinator.commit(OWNER, first.preparationId);
    await vi.waitFor(() => expect(harness.execute).toHaveBeenCalledTimes(1));
    await expect(
      harness.coordinator.commit(OWNER, second.preparationId),
    ).rejects.toThrow(/正在创建续接会话/);
    expect(harness.execute).toHaveBeenCalledTimes(1);
    expect(harness.cache.peek(second.preparationId, OWNER).consumed).toBe(false);

    finishFirst({
      successorSessionId: 'first-successor',
      sourceFinalization: { ok: true, value: undefined },
    });
    await expect(firstCommit).resolves.toMatchObject({ successorSessionId: 'first-successor' });
    expect(harness.cache.size).toBe(1);
    expect(harness.coordinator.cancel(OWNER, second.preparationId)).toBe(true);
    expect(harness.cleanupSpool).toHaveBeenCalledTimes(2);
  });
});
