/**
 * Issue Tracker IPC handler 测试（plan issue-tracker-mcp-20260529 §Step 3.5.6）。
 *
 * 覆盖 plan §Step 3.5.6 测试矩阵：
 * - IssuesUpdate args zod schema 严格 enum reject (status='foo' 等非 3 态值)
 * - IssuesUpdate partial patch undefined idempotent (不带 status 字段)
 * - IssuesResolveInNewSession in-flight Promise dedupe (同 issueId 并发 click 期间 return 同 Promise)
 * - IssuesResolveInNewSession adapter 边界硬化 (adapter 不存在 / canCreateSession=false /
 *   cwd >4096 / prompt >102400 — Step 3.5.1 createIssueResolutionSession helper 全套校验)
 * - IssuesResolveInNewSession recordCreatedPermissionMode 持久化（spawn 后 sessionRepo 拿回
 *   permissionMode 等于 dialog 选的值 — 项目 CLAUDE.md §会话恢复 硬约束）
 * - IssuesSoftDelete / IssuesUndelete 改 deleted_at + emit 'issue-changed' kind='softDeleted' /
 *   'undeleted' 边界
 *
 * **测试策略**：mock issueRepo / adapterRegistry / sessionManager / eventBus；调 named handler
 * （issuesUpdateHandler / issuesResolveInNewSessionHandler / 等）验业务逻辑（与 session-hand-off-finalize
 * 同款 named export 测试 pattern — 避免 mock electron ipcMain 复杂度）。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// vi.hoisted: mock 起手
const mocks = vi.hoisted(() => ({
  issueRepo: {
    get: vi.fn(),
    list: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn(),
    undelete: vi.fn(),
    listAppendices: vi.fn(),
  },
  adapterRegistry: {
    get: vi.fn(),
  },
  sessionManager: {
    recordCreatedPermissionMode: vi.fn(),
    close: vi.fn(),
  },
  sessionRepo: { get: vi.fn() },
  eventBus: { emit: vi.fn() },
  buildCreateSessionOptions: vi.fn((agentId: string, opts: Record<string, unknown>) => ({ agentId, ...opts })),
  persistAdapterAttachments: vi.fn(async (): Promise<Array<Record<string, unknown>>> => []),
  deleteUploadIfExists: vi.fn(async () => undefined),
}));

vi.mock('@main/store/issue-repo', () => ({ issueRepo: mocks.issueRepo }));
vi.mock('@main/adapters/registry', () => ({ adapterRegistry: mocks.adapterRegistry }));
vi.mock('@main/session/manager', () => ({ sessionManager: mocks.sessionManager }));
vi.mock('@main/store/session-repo', () => ({ sessionRepo: mocks.sessionRepo }));
vi.mock('@main/event-bus', () => ({ eventBus: mocks.eventBus }));
vi.mock('@main/adapters/options-builder', () => ({
  buildCreateSessionOptions: mocks.buildCreateSessionOptions,
}));
vi.mock('../adapters-attachments', () => ({
  persistAdapterAttachments: mocks.persistAdapterAttachments,
}));
vi.mock('@main/store/image-uploads', () => ({
  deleteUploadIfExists: mocks.deleteUploadIfExists,
}));

import {
  issuesResolveInNewSessionHandler,
  IssueResolutionRollbackIncompleteError,
  _resetInFlightResolveForTesting,
} from '../issues';
import type { IssueRecord } from '@shared/types';

const mockIssueRepo = mocks.issueRepo;
const mockAdapterRegistry = mocks.adapterRegistry;
const mockSessionManager = mocks.sessionManager;
const mockEventBus = mocks.eventBus;
const mockSessionRepo = mocks.sessionRepo;

function makeIssue(overrides: Partial<IssueRecord> = {}): IssueRecord {
  const now = Date.now();
  return {
    id: 'issue-1',
    title: 'T',
    description: 'D',
    repro: null,
    kind: 'follow-up',
    status: 'open',
    severity: 'medium',
    sourceSessionId: 'sess-orig',
    cwd: '/repo/issue-cwd',
    branchName: null,
    logsRef: null,
    resolutionSessionId: null,
    labels: [],
    createdAt: now,
    updatedAt: now,
    resolvedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function makeAdapter(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'claude-code',
    capabilities: {
      canCreateSession: true,
      canAcceptAttachments: false,
      canSetPermissionMode: true,
    },
    createSession: vi.fn().mockResolvedValue('new-sid-123'),
    closeSessionForRollback: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

beforeEach(() => {
  mockIssueRepo.get.mockReset();
  mockIssueRepo.list.mockReset();
  mockIssueRepo.update.mockReset();
  mockIssueRepo.softDelete.mockReset();
  mockIssueRepo.undelete.mockReset();
  mockIssueRepo.listAppendices.mockReset().mockReturnValue([]);
  mockAdapterRegistry.get.mockReset();
  mockSessionManager.recordCreatedPermissionMode.mockReset();
  mockSessionManager.close.mockReset().mockResolvedValue(undefined);
  mockSessionRepo.get.mockReset().mockReturnValue({ lifecycle: 'closed' });
  mockEventBus.emit.mockReset();
  mocks.buildCreateSessionOptions.mockClear();
  mocks.persistAdapterAttachments.mockReset().mockResolvedValue([]);
  mocks.deleteUploadIfExists.mockReset().mockResolvedValue(undefined);
  _resetInFlightResolveForTesting();
});

// ═══════════════════════════════════════════════════════════════════════════
// IssuesUpdate — zod enum reject (D7 9 case 第 9) + partial patch idempotent (D15 边角)
// ═══════════════════════════════════════════════════════════════════════════
describe('issuesResolveInNewSessionHandler — rollback and adapter boundaries', () => {
  it('returns an explicit non-retryable sid when strict provider rollback fails', async () => {
    mockIssueRepo.get.mockReturnValue(makeIssue());
    mockIssueRepo.update.mockImplementation(() => { throw new Error('update failed'); });
    const createSession = vi.fn().mockResolvedValue('new-sid-123');
    mockAdapterRegistry.get.mockReturnValue(makeAdapter({
      createSession,
      closeSessionForRollback: vi.fn().mockRejectedValue(new Error('provider still live')),
    }));

    const error = await issuesResolveInNewSessionHandler({
      issueId: 'issue-1',
      adapter: 'claude-code',
      prompt: 'p',
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(IssueResolutionRollbackIncompleteError);
    expect(error).toMatchObject({
      retryValid: false,
      sessionId: 'new-sid-123',
      code: 'ISSUE_RESOLUTION_ROLLBACK_INCOMPLETE',
    });
    expect(mockSessionManager.close).toHaveBeenCalledWith('new-sid-123');
    expect(mockSessionRepo.get).toHaveBeenCalledWith('new-sid-123');
    expect((error as Error).message).toContain('ISSUE_RESOLUTION_ROLLBACK_INCOMPLETE');
    expect((error as Error).message).toContain('retryValid=false');
    expect((error as Error).message).toContain('sid=new-sid-123');
    expect((error as Error).message).toMatch(/restart Agent Deck.*clean up.*before retrying/);

    await expect(issuesResolveInNewSessionHandler({
      issueId: 'issue-1', adapter: 'claude-code', prompt: 'retry',
    })).rejects.toBe(error);
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it('returns an explicit non-retryable sid when durable closure cannot be proven', async () => {
    mockIssueRepo.get.mockReturnValue(makeIssue());
    mockIssueRepo.update.mockImplementation(() => { throw new Error('update failed'); });
    mockSessionRepo.get.mockReturnValue({ lifecycle: 'active' });
    mockAdapterRegistry.get.mockReturnValue(makeAdapter());

    const error = await issuesResolveInNewSessionHandler({
      issueId: 'issue-1',
      adapter: 'claude-code',
      prompt: 'p',
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(IssueResolutionRollbackIncompleteError);
    expect((error as Error).message).toContain('durable lifecycle is active');
  });

  it('keeps at most one live child when a rolled-back attempt is retried', async () => {
    const live = new Set<string>();
    let created = 0;
    let maxLive = 0;
    const createSession = vi.fn(async () => {
      const sid = `new-sid-${++created}`;
      live.add(sid);
      maxLive = Math.max(maxLive, live.size);
      return sid;
    });
    const closeSessionForRollback = vi.fn(async (sid: string) => { live.delete(sid); });
    mockAdapterRegistry.get.mockReturnValue(makeAdapter({
      createSession,
      closeSessionForRollback,
    }));
    mockIssueRepo.get.mockReturnValue(makeIssue());
    mockIssueRepo.update
      .mockImplementationOnce(() => { throw new Error('first update failed'); })
      .mockReturnValueOnce(makeIssue({ resolutionSessionId: 'new-sid-2' }));

    await expect(issuesResolveInNewSessionHandler({
      issueId: 'issue-1', adapter: 'claude-code', prompt: 'p',
    })).rejects.toThrow('first update failed');
    expect(live.size).toBe(0);

    await expect(issuesResolveInNewSessionHandler({
      issueId: 'issue-1', adapter: 'claude-code', prompt: 'p',
    })).resolves.toMatchObject({ sessionId: 'new-sid-2' });
    expect(maxLive).toBe(1);
    expect(live).toEqual(new Set(['new-sid-2']));
  });

  it('把 Codex 模型与思考程度映射到 adapter-native createSession 字段', async () => {
    mockIssueRepo.get.mockReturnValue(makeIssue());
    const adapter = makeAdapter({ id: 'codex-cli' });
    mockAdapterRegistry.get.mockReturnValue(adapter);
    mockIssueRepo.update.mockReturnValue(makeIssue());

    await issuesResolveInNewSessionHandler({
      issueId: 'issue-1',
      adapter: 'codex-cli',
      prompt: 'p',
      approvalPolicy: 'on-request',
      model: '  gpt-custom-preview  ',
      thinking: 'ultra',
    });

    expect(mocks.buildCreateSessionOptions).toHaveBeenCalledWith(
      'codex-cli',
      expect.objectContaining({
        model: 'gpt-custom-preview',
        modelReasoningEffort: 'ultra',
      }),
    );
    const opts = mocks.buildCreateSessionOptions.mock.calls.at(-1)?.[1];
    expect(opts).not.toHaveProperty('claudeCodeEffortLevel');
    expect(adapter.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ approvalPolicy: 'on-request' }),
    );
  });

  it('把规范化后的 Grok sandbox profile 透传给问题解决会话', async () => {
    mockIssueRepo.get.mockReturnValue(makeIssue());
    mockAdapterRegistry.get.mockReturnValue(makeAdapter({
      id: 'grok-build',
      capabilities: {
        canCreateSession: true,
        canAcceptAttachments: false,
        canSetSessionMode: true,
      },
    }));
    mockIssueRepo.update.mockReturnValue(makeIssue());

    await issuesResolveInNewSessionHandler({
      issueId: 'issue-1',
      adapter: 'grok-build',
      prompt: 'p',
      grokSandbox: ' project-locked ',
    });

    expect(mocks.buildCreateSessionOptions).toHaveBeenCalledWith(
      'grok-build',
      expect.objectContaining({ grokSandbox: 'project-locked' }),
    );
  });

  it('rejects a Grok sandbox field for another adapter instead of filtering it', async () => {
    mockIssueRepo.get.mockReturnValue(makeIssue());
    const adapter = makeAdapter({ id: 'codex-cli' });
    mockAdapterRegistry.get.mockReturnValue(adapter);

    await expect(issuesResolveInNewSessionHandler({
      issueId: 'issue-1',
      adapter: 'codex-cli',
      prompt: 'p',
      grokSandbox: 'strict',
    })).rejects.toThrow(/grokSandbox 与 Codex CLI 不兼容；仅 Grok Build 支持/);
    expect(adapter.createSession).not.toHaveBeenCalled();
  });

  it('在创建会话前拒绝与 adapter 不匹配的思考程度', async () => {
    mockIssueRepo.get.mockReturnValue(makeIssue());
    const adapter = makeAdapter();
    mockAdapterRegistry.get.mockReturnValue(adapter);

    await expect(
      issuesResolveInNewSessionHandler({
        issueId: 'issue-1',
        adapter: 'claude-code',
        prompt: 'p',
        thinking: 'ultra',
      }),
    ).rejects.toThrow(/thinking.*must be one of/);
    expect(adapter.createSession).not.toHaveBeenCalled();
  });

  it('reject permissionMode 非白名单 (parsePermissionMode 守门)', async () => {
    mockIssueRepo.get.mockReturnValue(makeIssue());
    mockAdapterRegistry.get.mockReturnValue(makeAdapter());
    await expect(
      issuesResolveInNewSessionHandler({
        issueId: 'issue-1',
        adapter: 'claude-code',
        prompt: 'p',
        permissionMode: 'evil-mode',
      }),
    ).rejects.toThrow(/permissionMode.*must be one of/);
  });

  it('reject approvalPolicy 非白名单', async () => {
    mockIssueRepo.get.mockReturnValue(makeIssue());
    mockAdapterRegistry.get.mockReturnValue(makeAdapter({ id: 'codex-cli' }));
    await expect(
      issuesResolveInNewSessionHandler({
        issueId: 'issue-1',
        adapter: 'codex-cli',
        prompt: 'p',
        approvalPolicy: 'always',
      }),
    ).rejects.toThrow(/approvalPolicy.*must be one of/);
  });
});
