import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sessionConsoleCapabilitiesFixture } from '@contracts/session-console-capabilities.fixture';
import type { AgentAdapter, CreateSessionOptions } from '@main/adapters/types';
import { emptyContinuationCheckpoint } from '@main/session/continuation-context/checkpoint-fold-source';
import type { TrustedContinuationInitialTurn } from '@main/session/continuation-context/initial-turn';
import { createContinuationCheckpointRepo } from '@main/store/continuation-checkpoint-repo';
import { closeDb, getDb, initDb } from '@main/store/db';
import { eventRepo } from '@main/store/event-repo';
import { bindingAvailable } from '@main/store/__tests__/_binding-probe';
import { findSessionHandOffSuccessor } from '@main/store/session-handoff-alias-repo';
import { sessionRepo } from '@main/store/session-repo';
import { worktreeTransitionRepo } from '@main/store/worktree-transition-repo';
import type { SessionRecord } from '@shared/types';

import type { ServerCoreDesktopBrokerPort } from './desktop-broker-port';
import { ServerCoreMcpHandOff } from './mcp-handoff';
import type { ServerCoreMcpPresentationPort } from './mcp-presentation-port';
import type { ServerCoreMcpSessionPort } from './mcp-session-port';
import type { ServerCoreWorktreeRuntimePort } from './mcp-worktree-port';
import type { ServerCoreRuntimeMetadataStore } from './runtime-metadata-store';
import type { ServerCoreSessionCreateCapabilities } from './session-create-capabilities';

const roots: string[] = [];

function session(
  id: string,
  cwd: string,
  overrides: Partial<SessionRecord> = {},
): SessionRecord {
  return {
    id,
    agentId: 'codex-cli',
    cwd,
    title: `title-${id}`,
    source: 'sdk',
    lifecycle: 'active',
    activity: 'idle',
    startedAt: 1,
    lastEventAt: 2,
    endedAt: null,
    archivedAt: null,
    runtimeProvider: 'openai',
    model: 'gpt-5.6',
    thinking: 'high',
    codexApprovalPolicy: 'on-request',
    codexSandbox: 'workspace-write',
    ...overrides,
  };
}

interface HarnessOptions {
  readonly acceptance?: readonly ('accepted' | 'context-window-exceeded')[];
  readonly mutateSourceOnCreate?: boolean;
  readonly failMarkClosed?: boolean;
  readonly rawRetentionCeilingTokens?: number;
  readonly refreshContinuation?: (sessionId: string) => Promise<void>;
}

function harness(input: HarnessOptions = {}) {
  const parent = mkdtempSync(join(tmpdir(), 'agent-deck-core-handoff-'));
  roots.push(parent);
  const workspaceRoot = join(parent, 'Workspace');
  const project = join(workspaceRoot, 'project-a');
  mkdirSync(project, { recursive: true });
  const root = realpathSync(workspaceRoot);
  const cwd = realpathSync(project);
  initDb({
    databasePath: join(parent, 'core.db'),
    diagnostics: { info: vi.fn(), warn: vi.fn() },
  });
  const sourceId = `source-${roots.length}`;
  const sourceRecord = session(sourceId, cwd);
  sessionRepo.upsert(sourceRecord);
  const privateAttachmentPath = join(parent, 'private', 'secret-image.png');
  eventRepo.insert({
    sessionId: sourceId,
    agentId: 'codex-cli',
    kind: 'message',
    payload: {
      role: 'user',
      text: 'Please preserve this intent',
      attachments: [{
        kind: 'uploaded',
        path: privateAttachmentPath,
        mime: 'image/png',
        bytes: 12,
      }],
    },
    ts: 3,
    source: 'sdk',
  });

  const describe = vi.fn(async (request: {
    adapterId: 'claude-code' | 'codex-cli' | 'grok-build';
    workingDirectory: string;
  }) => sessionConsoleCapabilitiesFixture(request.adapterId, request.workingDirectory));
  const validateCreate = vi.fn(async (
    adapterId: 'claude-code' | 'codex-cli' | 'grok-build',
    _revision: string,
    directory: string,
  ) => sessionConsoleCapabilitiesFixture(adapterId, directory));
  const capabilities = { describe, validateCreate } as unknown as
    ServerCoreSessionCreateCapabilities;

  const turns: TrustedContinuationInitialTurn[] = [];
  const createTargets: CreateSessionOptions[] = [];
  const accepted = input.acceptance ?? ['accepted'];
  let createIndex = 0;
  const createTrustedContinuationSession = vi.fn(async (
    target: CreateSessionOptions,
    turn: TrustedContinuationInitialTurn,
  ) => {
    const index = createIndex++;
    const id = `${sourceId}-successor-${index + 1}`;
    createTargets.push(target);
    turns.push(turn);
    sessionRepo.upsert(session(id, target.cwd, {
      agentId: target.agentId,
      runtimeProvider: target.agentId === 'codex-cli' ? target.provider ?? null : null,
      model: target.model ?? null,
    }));
    if (input.mutateSourceOnCreate && index === 0) {
      sessionRepo.upsert({ ...sourceRecord, model: 'source-runtime-changed' });
    }
    const state = accepted[index] ?? 'accepted';
    return {
      sessionId: id,
      acceptance: Promise.resolve(state === 'accepted'
        ? { status: 'accepted' as const, boundary: 'model-activity' as const }
        : { status: 'rejected' as const, reason: 'context-window-exceeded' as const }),
    };
  });
  const closeSessionForRollback = vi.fn(async () => undefined);
  const enqueueMessage = vi.fn(async () => undefined);
  const retireSessionAfterCurrentTurn = vi.fn();
  const adapter = {
    createTrustedContinuationSession,
    closeSessionForRollback,
    enqueueMessage,
    retireSessionAfterCurrentTurn,
    snapshotQueuedMessagesForHandOff: () => [{ text: 'queued provider turn' }],
  } as unknown as AgentAdapter;
  const markClosed = vi.fn((id: string) => {
    if (input.failMarkClosed) throw new Error('close publication failed');
    sessionRepo.setLifecycle(id, 'closed', 20, { clearPinned: true });
  });
  const discardAfterProviderRollback = vi.fn((id: string) => sessionRepo.delete(id));
  const notifyTeamMembershipChanged = vi.fn();
  const commitPresentationTransfer = vi.fn();
  const rollbackPresentationTransfer = vi.fn();
  const prepareSessionTransfer = vi.fn(() => ({
    commit: commitPresentationTransfer,
    rollback: rollbackPresentationTransfer,
  }));
  const releasePresentation = vi.fn();
  const releaseBrowser = vi.fn();
  const renameSession = vi.fn();
  let revision = 100;
  const appendChange = vi.fn(() => ++revision);
  const handoff = new ServerCoreMcpHandOff({
    workspaceRoot: root,
    sessions: sessionRepo,
    sessionManager: {
      markClosed,
      discardAfterProviderRollback,
      notifyTeamMembershipChanged,
    },
    registry: { get: () => adapter },
    capabilities,
    collaboration: {
      drainForHandOff: vi.fn(async () => true),
    } as unknown as ServerCoreMcpSessionPort,
    worktrees: { renameSession } as unknown as ServerCoreWorktreeRuntimePort,
    desktopBroker: { releaseSession: releaseBrowser } as unknown as ServerCoreDesktopBrokerPort,
    presentations: {
      prepareSessionTransfer,
      releaseSession: releasePresentation,
    } as unknown as ServerCoreMcpPresentationPort,
    metadata: {
      appendChange,
      currentRevision: () => revision,
    } as unknown as ServerCoreRuntimeMetadataStore,
    rawRetentionCeilingTokens: input.rawRetentionCeilingTokens ?? 64_000,
    refreshContinuation: input.refreshContinuation,
    warn: vi.fn(),
  });
  return {
    appendChange,
    closeSessionForRollback,
    createTargets,
    cwd,
    discardAfterProviderRollback,
    enqueueMessage,
    handoff,
    markClosed,
    privateAttachmentPath,
    prepareSessionTransfer,
    commitPresentationTransfer,
    releaseBrowser,
    releasePresentation,
    renameSession,
    retireSessionAfterCurrentTurn,
    root,
    sourceId,
    rollbackPresentationTransfer,
    turns,
  };
}

function activateSourceWorktree(sourceId: string, worktreePath: string, originalCwd: string): void {
  const created = worktreeTransitionRepo.createEnter({
    sessionId: sourceId,
    originalCwd,
    targetCwd: worktreePath,
    mainRepo: originalCwd,
    worktreePath,
    baseCommit: 'a'.repeat(40),
    toolUseId: 'tool-enter',
    continuationKey: 'worktree:enter',
    requestedAt: 10,
  });
  worktreeTransitionRepo.markEnterCreated(sourceId, created.generation, 11);
  for (const [index, [expected, next]] of ([
    ['enter_waiting_tool_result', 'interrupting_enter_turn'],
    ['interrupting_enter_turn', 'switching_to_worktree'],
    ['switching_to_worktree', 'active'],
  ] as const).entries()) {
    worktreeTransitionRepo.compareAndSetPhase({
      sessionId: sourceId,
      generation: created.generation,
      expected,
      next,
      updatedAt: 12 + index,
    });
  }
}

beforeEach(() => {
  try { closeDb(); } catch {}
});

afterEach(() => {
  try { closeDb(); } catch {}
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!bindingAvailable)('ServerCoreMcpHandOff', () => {
  it('refreshes the checkpoint before capture and applies configured raw retention', async () => {
    const refreshContinuation = vi.fn(async (sessionId: string) => {
      const db = getDb();
      const revision = db.prepare(
        `SELECT revision, rebuild_after_revision AS rebuildAfterRevision
           FROM session_event_revisions
          WHERE session_id = ?`,
      ).get(sessionId) as { revision: number; rebuildAfterRevision: number };
      const maxEvent = db.prepare(
        `SELECT MAX(id) AS id FROM events WHERE session_id = ?`,
      ).get(sessionId) as { id: number | null };
      const committed = createContinuationCheckpointRepo(db).commit({
        sessionId,
        expectedHeadId: null,
        expectedRebuildAfterRevision: revision.rebuildAfterRevision,
        sourceEventRevision: revision.revision,
        sourceMaxEventId: maxEvent.id,
        checkpoint: emptyContinuationCheckpoint(),
        generatorAdapter: 'codex-cli',
        generatorModel: 'gpt-5.6',
        generatorThinking: 'high',
        trigger: 'handoff-test',
      });
      expect(committed.ok).toBe(true);
    });
    const state = harness({
      rawRetentionCeilingTokens: 8_000,
      refreshContinuation,
    });
    eventRepo.insert({
      sessionId: state.sourceId,
      agentId: 'codex-cli',
      kind: 'message',
      payload: { role: 'user', text: 'bounded evidence '.repeat(8_000) },
      ts: 4,
      source: 'sdk',
    });

    const preview = await state.handoff.preview(state.sourceId, {
      prompt: 'Continue from the refreshed checkpoint',
    });

    expect(refreshContinuation).toHaveBeenCalledOnce();
    expect(refreshContinuation).toHaveBeenCalledWith(state.sourceId);
    expect(preview.checkpoint).toMatchObject({
      id: expect.any(Number),
      throughRevision: 2,
      refreshed: true,
    });
    expect(preview.metrics.rawRetentionCeilingTokens).toBe(8_000);
    expect(preview.metrics.rawTailTokens).toBeLessThanOrEqual(8_000);
    expect(preview.metrics.truncatedBoundaryMessages).toBeGreaterThan(0);
  });

  it('uses the bounded lower candidate, moves ownership, and never exposes private paths', async () => {
    const state = harness({ acceptance: ['context-window-exceeded', 'accepted'] });
    const preview = await state.handoff.preview(state.sourceId, {
      prompt: 'Continue from the authoritative checkpoint',
    });
    const result = await state.handoff.handOff(state.sourceId, {
      prompt: 'Continue from the authoritative checkpoint',
    }, preview.bindingDigest);

    expect(preview.target).toMatchObject({
      adapterId: 'codex-cli', workingDirectory: 'project-a',
    });
    expect(preview.bindingDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(preview.preview).not.toContain(state.privateAttachmentPath);
    expect(state.turns).toHaveLength(2);
    expect(state.turns[0]?.providerPrompt).not.toContain(state.privateAttachmentPath);
    expect(state.turns[1]?.providerPrompt).not.toContain(state.privateAttachmentPath);
    expect(result).toMatchObject({
      sessionId: `${state.sourceId}-successor-2`,
      adapter: 'codex-cli',
      cwd: 'project-a',
      callerClosed: 'ok',
      continuationContext: {
        usedLowerBudgetRetry: true,
        preparationHash: state.turns[1]?.metadata.preparationHash,
        lateMessagesDelivered: 1,
      },
      resourceTransfer: {
        tasks: { status: 'ok', count: 0 },
        teams: { status: 'ok', transferred: [] },
      },
    });
    expect(state.closeSessionForRollback).toHaveBeenCalledWith(
      `${state.sourceId}-successor-1`,
    );
    expect(sessionRepo.get(`${state.sourceId}-successor-1`)).toBeNull();
    expect(sessionRepo.get(state.sourceId)?.lifecycle).toBe('closed');
    expect(findSessionHandOffSuccessor(state.sourceId)).toBe(result.sessionId);
    expect(state.enqueueMessage).toHaveBeenCalledWith(
      result.sessionId,
      'queued provider turn',
      undefined,
      { bypassQueueLimit: true },
    );
    expect(state.prepareSessionTransfer).toHaveBeenCalledWith(state.sourceId, result.sessionId);
    expect(state.commitPresentationTransfer).toHaveBeenCalledOnce();
    expect(state.renameSession).toHaveBeenCalledWith(state.sourceId, result.sessionId);
    expect(state.releaseBrowser).toHaveBeenCalledWith(state.sourceId);
    expect(state.releasePresentation).toHaveBeenCalledWith(state.sourceId, 'Session handed off');
    expect(state.retireSessionAfterCurrentTurn).toHaveBeenCalledWith(state.sourceId);
    expect(JSON.stringify(result)).not.toContain(state.privateAttachmentPath);
    expect(JSON.stringify(result)).not.toContain(state.root);
  });

  it('rejects a commit whose preview binding does not match the source and target', async () => {
    const state = harness();
    const preview = await state.handoff.preview(state.sourceId, {
      prompt: 'Continue after preview',
    });
    await expect(state.handoff.handOff(state.sourceId, {
      prompt: 'Different instruction after preview',
    }, preview.bindingDigest)).rejects.toThrow('preview no longer matches');
    expect(state.createTargets).toEqual([]);
    expect(sessionRepo.get(state.sourceId)?.lifecycle).toBe('active');
  });

  it('strictly removes the successor and preserves the source when runtime state drifts', async () => {
    const state = harness({ mutateSourceOnCreate: true });
    await expect(state.handoff.handOff(state.sourceId, {
      prompt: 'This attempt must roll back',
    })).rejects.toThrow(/changed incompatibly/);

    expect(state.closeSessionForRollback).toHaveBeenCalledWith(
      `${state.sourceId}-successor-1`,
    );
    expect(state.discardAfterProviderRollback).toHaveBeenCalled();
    expect(sessionRepo.get(`${state.sourceId}-successor-1`)).toBeNull();
    expect(sessionRepo.get(state.sourceId)?.lifecycle).toBe('active');
    expect(findSessionHandOffSuccessor(state.sourceId)).toBeNull();
    expect(state.prepareSessionTransfer).not.toHaveBeenCalled();
    expect(state.retireSessionAfterCurrentTurn).not.toHaveBeenCalled();
  });

  it('rejects an explicit cwd that conflicts with the transferred active worktree lease', async () => {
    const state = harness();
    const other = join(state.root, 'project-b');
    mkdirSync(other);
    activateSourceWorktree(state.sourceId, state.cwd, state.root);

    await expect(state.handoff.handOff(state.sourceId, {
      prompt: 'Do not split runtime and durable cwd',
      cwd: 'project-b',
    })).rejects.toThrow('active worktree lease');

    expect(state.createTargets).toEqual([]);
    expect(sessionRepo.get(state.sourceId)?.lifecycle).toBe('active');
    expect(worktreeTransitionRepo.get(state.sourceId)?.phase).toBe('active');
  });

  it('continues every revocation step after a committed source-close failure', async () => {
    const state = harness({ failMarkClosed: true });
    const result = await state.handoff.handOff(state.sourceId, {
      prompt: 'Commit ownership even if old-row publication fails',
    });

    expect(result.callerClosed).toBe('failed');
    expect(result.warnings).toContain('source-finalization-failed');
    expect(findSessionHandOffSuccessor(state.sourceId)).toBe(result.sessionId);
    expect(state.releaseBrowser).toHaveBeenCalledWith(state.sourceId);
    expect(state.releasePresentation).toHaveBeenCalledWith(state.sourceId, 'Session handed off');
    expect(state.retireSessionAfterCurrentTurn).toHaveBeenCalledWith(state.sourceId);
    expect(state.closeSessionForRollback).not.toHaveBeenCalled();
  });
});
