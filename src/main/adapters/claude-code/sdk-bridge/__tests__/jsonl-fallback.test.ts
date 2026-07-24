import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  maybeJsonlFallback,
  type JsonlFallbackCtx,
  type JsonlFallbackOpts,
} from '../jsonl-fallback';
import type { AgentEvent, UploadedAttachmentRef } from '@shared/types';
import type { SdkSessionHandle } from '../types';
import { createTrustedContinuationInitialTurn } from '@main/session/continuation-context/initial-turn';
import type {
  CapturedRecoveryContinuation,
  PreparedRecoveryContinuation,
} from '@main/session/continuation-context/recovery';
import type {
  ContinuationQuality,
  PreparedContinuationContext,
} from '@main/session/continuation-context/types';

const emits: AgentEvent[] = [];
const capture: CapturedRecoveryContinuation = {
  sourceSessionId: 'app-sid-A',
  spoolId: 'spool-test',
  generator: {
    adapter: 'claude-code',
    model: null,
    thinking: 'medium',
    contextWindowTokens: null,
    configFingerprint: 'generator',
  },
  target: {
    adapter: 'claude-code',
    model: null,
    thinking: null,
    sandbox: null,
    permissionMode: null,
    networkAccessEnabled: null,
    additionalDirectories: [],
    contextWindowTokens: 128_000,
    runtimeFingerprint: 'target',
  },
  rawRetentionCeilingTokens: 64_000,
};

function preparedRecovery(
  instruction: string,
  quality: ContinuationQuality,
  sourceSessionId = capture.sourceSessionId,
): PreparedRecoveryContinuation {
  const prepared: PreparedContinuationContext = {
    version: 1,
    providerPrompt: `===== Agent Deck Continuation Context v1 =====\n${instruction}`,
    persistedUserText: instruction,
    source: { eventRevision: 4, rebuildAfterRevision: 0, maxEventId: 4 },
    checkpoint: { id: 2, throughRevision: 4, formatVersion: 1, refreshed: false },
    projection: { canonicalHash: 'canonical', omittedFacts: 0 },
    quality,
    metrics: {
      rawRetentionCeilingTokens: 64_000,
      targetPromptCapacityTokens: 104_000,
      checkpointProjectionBudgetTokens: 12_000,
      generatorFoldInputBudgetTokens: 32_000,
      estimatedPromptTokens: 100,
      checkpointTokens: 20,
      rawTailTokens: 20,
      includedUserMessages: quality === 'instruction-only' ? 0 : 1,
      truncatedBoundaryMessages: 0,
      foldCalls: 1,
      repairCalls: 0,
      elapsedMs: 1,
      uncoveredRevisionRange: null,
    },
    warnings: [],
    preparationHash: 'b'.repeat(64),
    spoolId: 'spool-test',
  };
  return { prepared, turn: createTrustedContinuationInitialTurn(prepared, sourceSessionId) };
}

interface MakeCtxOptions {
  jsonlExists?: boolean | ((cwd: string, sessionId: string) => boolean);
  jsonlMtimeMs?: number | null;
  latestConversationMessageTs?: number | null;
  quality?: ContinuationQuality;
  createSession?: (opts: unknown) => Promise<SdkSessionHandle>;
  prepare?: JsonlFallbackCtx['prepareRecoveryContinuation'];
}

function makeCtx(options: MakeCtxOptions = {}) {
  const jsonlExistsThunk = vi.fn((cwd: string, sessionId: string): boolean =>
    typeof options.jsonlExists === 'function'
      ? options.jsonlExists(cwd, sessionId)
      : (options.jsonlExists ?? true),
  );
  const jsonlMtimeMsThunk = vi.fn(() => options.jsonlMtimeMs ?? 10_000);
  const latestConversationMessageTsThunk = vi.fn(
    () => options.latestConversationMessageTs ?? null,
  );
  const createSession = vi.fn(
    options.createSession ??
      (async () => ({ sessionId: 'helper-stub-sid' }) as SdkSessionHandle),
  );
  const prepareRecoveryContinuation = vi.fn(
    options.prepare ??
      (async ({ capture: inputCapture, continuationInstruction }) =>
        preparedRecovery(
          continuationInstruction,
          options.quality ?? 'raw-only',
          inputCapture.sourceSessionId,
        )),
  );
  const ctx: JsonlFallbackCtx = {
    jsonlExistsThunk,
    jsonlMtimeMsThunk,
    latestConversationMessageTsThunk,
    createSession: createSession as unknown as JsonlFallbackCtx['createSession'],
    prepareRecoveryContinuation,
    emit: (event) => emits.push(event),
  };
  return {
    ctx,
    jsonlExistsThunk,
    jsonlMtimeMsThunk,
    latestConversationMessageTsThunk,
    createSession,
    prepareRecoveryContinuation,
  };
}

function recoverOpts(overrides: Partial<JsonlFallbackOpts> = {}): JsonlFallbackOpts {
  return {
    sessionId: 'app-sid-A',
    cliSessionId: 'cli-sid-X',
    cwd: '/tmp/test',
    prompt: '继续之前的话题',
    recoveryCapture: capture,
    minHealJsonlMtimeMs: 1_000,
    provider: 'deepseek',
    emitContext: 'recover',
    cwdFellBack: false,
    ...overrides,
  } as JsonlFallbackOpts;
}

function restartOpts(overrides: Partial<JsonlFallbackOpts> = {}): JsonlFallbackOpts {
  return {
    sessionId: 'app-sid-R',
    cliSessionId: 'cli-sid-Y',
    cwd: '/tmp/test',
    prompt: '继续之前的会话',
    recoveryCapture: { ...capture, sourceSessionId: 'app-sid-R' },
    minHealJsonlMtimeMs: 1_000,
    emitContext: 'restart',
    cwdFellBack: false,
    restartLabel: '权限模式 plan',
    ...overrides,
  } as JsonlFallbackOpts;
}

beforeEach(() => {
  emits.length = 0;
  vi.clearAllMocks();
});

describe('maybeJsonlFallback unified continuation recovery', () => {
  it('native jsonl resume bypasses continuation preparation and session creation', async () => {
    const { ctx, prepareRecoveryContinuation, createSession } = makeCtx({ jsonlExists: true });
    const result = await maybeJsonlFallback(ctx, recoverOpts());

    expect(result).toMatchObject({ finalSessionId: 'app-sid-A', fellBack: false });
    expect(prepareRecoveryContinuation).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(emits).toEqual([]);
  });

  it('cwd fallback short-circuits the jsonl probe and creates a trusted continuation turn', async () => {
    const { ctx, jsonlExistsThunk, createSession } = makeCtx({ jsonlExists: true });
    const result = await maybeJsonlFallback(ctx, recoverOpts({ cwdFellBack: true }));

    expect(result.fellBack).toBe(true);
    expect(jsonlExistsThunk).not.toHaveBeenCalled();
    const createOptions = createSession.mock.calls[0][0] as Record<string, unknown>;
    expect(createOptions).toMatchObject({
      cwd: '/tmp/test',
      resume: 'app-sid-A',
      resumeMode: 'fresh-cli-reuse-app',
      provider: 'deepseek',
    });
    expect(createOptions.prompt).toBeUndefined();
    expect(createOptions.resumeCliSid).toBeUndefined();
    expect(createOptions.trustedContinuation).toMatchObject({
      persistedUserText: '继续之前的话题',
    });
  });

  it('missing provider history emits bounded metadata and preserves attachments', async () => {
    const attachments: UploadedAttachmentRef[] = [
      { kind: 'uploaded', path: '/tmp/a.png', mime: 'image/png', bytes: 100 },
    ];
    const { ctx } = makeCtx({ jsonlExists: false, quality: 'full' });
    await maybeJsonlFallback(ctx, recoverOpts({ attachments }));

    expect(emits).toHaveLength(2);
    const userEvent = emits[1];
    expect(userEvent.payload).toMatchObject({
      text: '继续之前的话题',
      role: 'user',
      attachments,
      messageOrigin: 'continuation',
      continuation: { sourceSessionId: 'app-sid-A', sourceEventRevision: 4 },
    });
    expect(JSON.stringify(userEvent.payload)).not.toContain('Agent Deck Continuation Context');
  });

  it('instruction-only degradation uses the skipped-history notice', async () => {
    const { ctx } = makeCtx({ jsonlExists: false, quality: 'instruction-only' });
    await maybeJsonlFallback(ctx, recoverOpts());
    expect((emits[0].payload as { text: string }).text).toContain('典型原因');
  });

  it('a missing pre-await capture fails before side effects', async () => {
    const { ctx, createSession, prepareRecoveryContinuation } = makeCtx({ jsonlExists: false });
    await expect(
      maybeJsonlFallback(
        ctx,
        recoverOpts({ recoveryCapture: null, recoveryCaptureError: new Error('spool failed') }),
      ),
    ).rejects.toThrow('无法准备会话续接上下文：spool failed');
    expect(prepareRecoveryContinuation).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(emits).toEqual([]);
  });

  it('close during asynchronous preparation aborts before fresh session creation', async () => {
    let cancelled = false;
    const { ctx, createSession } = makeCtx({
      jsonlExists: false,
      prepare: async ({ capture: inputCapture, continuationInstruction }) => {
        await Promise.resolve();
        cancelled = true;
        return preparedRecovery(continuationInstruction, 'raw-only', inputCapture.sourceSessionId);
      },
    });
    const result = await maybeJsonlFallback(
      ctx,
      recoverOpts({ isCancelledFn: () => cancelled }),
    );

    expect(result).toMatchObject({ fellBack: false, aborted: true });
    expect(createSession).not.toHaveBeenCalled();
    expect(emits).toEqual([]);
  });

  it('create failure propagates without success/user emissions', async () => {
    const { ctx } = makeCtx({
      jsonlExists: false,
      createSession: async () => {
        throw new Error('SDK start failed');
      },
    });
    await expect(maybeJsonlFallback(ctx, recoverOpts())).rejects.toThrow('SDK start failed');
    expect(emits).toEqual([]);
  });

  it('skipFirstUserEmit keeps recovery entry emission single-owned', async () => {
    const { ctx } = makeCtx({ jsonlExists: false });
    await maybeJsonlFallback(ctx, recoverOpts({ skipFirstUserEmit: true }));
    expect(emits).toHaveLength(1);
    expect((emits[0].payload as { role?: string }).role).toBeUndefined();
  });

  it('heals a phantom cli id when the application jsonl is fresh', async () => {
    const { ctx, createSession, jsonlExistsThunk } = makeCtx({
      jsonlExists: (_cwd, sessionId) => sessionId === 'app-sid-A',
      jsonlMtimeMs: 10_000,
    });
    const result = await maybeJsonlFallback(
      ctx,
      recoverOpts({ cliSessionId: 'cli-sid-phantom', minHealJsonlMtimeMs: 9_000 }),
    );

    expect(result).toMatchObject({ fellBack: false, healedCliSessionId: 'app-sid-A' });
    expect(jsonlExistsThunk).toHaveBeenCalledTimes(2);
    expect(createSession).not.toHaveBeenCalled();
  });

  it('restart healing compares jsonl mtime to the latest dialog rather than lifecycle churn', async () => {
    const { ctx, createSession, latestConversationMessageTsThunk } = makeCtx({
      jsonlExists: (_cwd, sessionId) => sessionId === 'app-sid-R',
      jsonlMtimeMs: 5_000,
      latestConversationMessageTs: 5_100,
    });
    const result = await maybeJsonlFallback(
      ctx,
      restartOpts({ cliSessionId: 'cli-sid-phantom', minHealJsonlMtimeMs: 20_000 }),
    );

    expect(result).toMatchObject({ fellBack: false, healedCliSessionId: 'app-sid-R' });
    expect(latestConversationMessageTsThunk).toHaveBeenCalledWith('app-sid-R');
    expect(createSession).not.toHaveBeenCalled();
  });

  it('a jsonl older than the latest restart dialog fails closed to unified fallback', async () => {
    const { ctx, createSession } = makeCtx({
      jsonlExists: (_cwd, sessionId) => sessionId === 'app-sid-R',
      jsonlMtimeMs: 5_000,
      latestConversationMessageTs: 10_000,
    });
    const result = await maybeJsonlFallback(
      ctx,
      restartOpts({ cliSessionId: 'cli-sid-real-fork', minHealJsonlMtimeMs: 20_000 }),
    );

    expect(result.fellBack).toBe(true);
    expect(result.healedCliSessionId).toBeUndefined();
    expect(createSession).toHaveBeenCalledOnce();
  });
});
