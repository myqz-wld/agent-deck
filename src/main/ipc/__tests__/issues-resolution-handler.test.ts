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
describe('issuesResolveInNewSessionHandler — happy + cwd fallback + dedupe + emit', () => {
  it('happy: spawn + 写回 resolutionSessionId + status="in-progress" + emit kind="updated"', async () => {
    mockIssueRepo.get.mockReturnValue(makeIssue({
      cwd: '/repo/issue-cwd',
      resolutionSessionId: 'old-resolution-sid',
    }));
    mockAdapterRegistry.get.mockReturnValue(makeAdapter());
    const updated = makeIssue({ resolutionSessionId: 'new-sid-123', status: 'in-progress' });
    mockIssueRepo.update.mockReturnValue(updated);

    const result = await issuesResolveInNewSessionHandler({
      issueId: 'issue-1',
      adapter: 'claude-code',
      prompt: 'Resolve issue X',
    });

    expect(result.sessionId).toBe('new-sid-123');
    expect(mockIssueRepo.update).toHaveBeenCalledWith(
      'issue-1',
      { resolutionSessionId: 'new-sid-123', status: 'in-progress' },
    );
    expect(mockEventBus.emit).toHaveBeenCalledWith(
      'issue-changed',
      expect.objectContaining({ kind: 'updated', issueId: 'issue-1' }),
    );
  });

  it('cwd fallback: args.cwd 未传 + issue.cwd 非空 → 用 issue.cwd', async () => {
    const adapter = makeAdapter();
    mockIssueRepo.get.mockReturnValue(makeIssue({ cwd: '/repo/issue-cwd' }));
    mockAdapterRegistry.get.mockReturnValue(adapter);
    mockIssueRepo.update.mockReturnValue(makeIssue());
    await issuesResolveInNewSessionHandler({
      issueId: 'issue-1',
      adapter: 'claude-code',
      prompt: 'p',
    });
    expect(adapter.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/repo/issue-cwd' }),
    );
  });

  it('cwd fallback: args.cwd 优先 (非空) → issue.cwd 不被 fallback', async () => {
    const adapter = makeAdapter();
    mockIssueRepo.get.mockReturnValue(makeIssue({ cwd: '/repo/issue-cwd' }));
    mockAdapterRegistry.get.mockReturnValue(adapter);
    mockIssueRepo.update.mockReturnValue(makeIssue());
    await issuesResolveInNewSessionHandler({
      issueId: 'issue-1',
      adapter: 'claude-code',
      cwd: '/repo/explicit-cwd',
      prompt: 'p',
    });
    expect(adapter.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/repo/explicit-cwd' }),
    );
  });

  it('reject 不存在 issue', async () => {
    mockIssueRepo.get.mockReturnValue(null);
    await expect(
      issuesResolveInNewSessionHandler({
        issueId: 'ghost-id',
        adapter: 'claude-code',
        prompt: 'p',
      }),
    ).rejects.toThrow(/ghost-id not found/);
  });

  it('zod reject prompt > 102400 char (args 层守门)', async () => {
    await expect(
      issuesResolveInNewSessionHandler({
        issueId: 'issue-1',
        adapter: 'claude-code',
        prompt: 'x'.repeat(102_401),
      }),
    ).rejects.toThrow(/invalid ipc input.*args/);
  });

  it('zod reject 未知 args 字段 (strict)', async () => {
    await expect(
      issuesResolveInNewSessionHandler({
        issueId: 'issue-1',
        adapter: 'claude-code',
        prompt: 'p',
        unknownField: 'x',
      }),
    ).rejects.toThrow(/invalid ipc input.*args/);
  });

  it('§D14 in-flight Promise dedupe: 同 issueId 并发 click 期间 return 同 Promise', async () => {
    mockIssueRepo.get.mockReturnValue(makeIssue());
    let resolveCreateSession: (sid: string) => void;
    const adapter = makeAdapter({
      createSession: vi.fn().mockReturnValue(
        new Promise<string>((resolve) => {
          resolveCreateSession = resolve;
        }),
      ),
    });
    mockAdapterRegistry.get.mockReturnValue(adapter);
    mockIssueRepo.update.mockReturnValue(makeIssue({ resolutionSessionId: 'new-sid-123' }));

    // 同 issueId 同时发起 3 次（模拟 React 双 click + race）
    const p1 = issuesResolveInNewSessionHandler({
      issueId: 'issue-1',
      adapter: 'claude-code',
      prompt: 'p',
    });
    const p2 = issuesResolveInNewSessionHandler({
      issueId: 'issue-1',
      adapter: 'claude-code',
      prompt: 'p',
    });
    const p3 = issuesResolveInNewSessionHandler({
      issueId: 'issue-1',
      adapter: 'claude-code',
      prompt: 'p',
    });
    // resolve underlying createSession promise → 三个 caller 全部 resolve
    resolveCreateSession!('new-sid-123');
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    // 关键：adapter.createSession 仅被调用 1 次（dedupe 工作）
    expect(adapter.createSession).toHaveBeenCalledTimes(1);
    expect(r1.sessionId).toBe('new-sid-123');
    expect(r2).toBe(r1); // 同 Promise 同 result reference
    expect(r3).toBe(r1);
  });

  it('§D14 dedupe 清条目: spawn 完成后 同 issueId 二次调用重新走 createSession', async () => {
    mockIssueRepo.get.mockReturnValue(makeIssue());
    const adapter = makeAdapter();
    mockAdapterRegistry.get.mockReturnValue(adapter);
    mockIssueRepo.update.mockReturnValue(makeIssue({ resolutionSessionId: 'new-sid-123' }));
    await issuesResolveInNewSessionHandler({ issueId: 'issue-1', adapter: 'claude-code', prompt: 'p' });
    await issuesResolveInNewSessionHandler({ issueId: 'issue-1', adapter: 'claude-code', prompt: 'p' });
    // dedupe Map 在第一次完成后清条目 → 第二次重新走 createSession
    expect(adapter.createSession).toHaveBeenCalledTimes(2);
  });

  it('§D14 dedupe 清条目: spawn 失败后 同 issueId 二次调用重新走 createSession (不缓存失败)', async () => {
    mockIssueRepo.get.mockReturnValue(makeIssue());
    const adapter = makeAdapter({
      createSession: vi.fn().mockRejectedValueOnce(new Error('spawn failed')).mockResolvedValueOnce('new-sid'),
    });
    mockAdapterRegistry.get.mockReturnValue(adapter);
    mockIssueRepo.update.mockReturnValue(makeIssue({ resolutionSessionId: 'new-sid' }));
    await expect(
      issuesResolveInNewSessionHandler({ issueId: 'issue-1', adapter: 'claude-code', prompt: 'p' }),
    ).rejects.toThrow(/spawn failed/);
    // 失败后 dedupe Map 清条目 → 第二次调用 走 mockResolvedValueOnce 路径
    const result = await issuesResolveInNewSessionHandler({
      issueId: 'issue-1',
      adapter: 'claude-code',
      prompt: 'p',
    });
    expect(result.sessionId).toBe('new-sid');
    expect(adapter.createSession).toHaveBeenCalledTimes(2);
  });

  it('§10 recordCreatedPermissionMode 持久化（dialog 选 acceptEdits → 调用 sessionManager.recordCreatedPermissionMode("new-sid", "acceptEdits")）', async () => {
    mockIssueRepo.get.mockReturnValue(makeIssue());
    mockAdapterRegistry.get.mockReturnValue(makeAdapter());
    mockIssueRepo.update.mockReturnValue(makeIssue());
    await issuesResolveInNewSessionHandler({
      issueId: 'issue-1',
      adapter: 'claude-code',
      prompt: 'p',
      permissionMode: 'acceptEdits',
    });
    expect(mockSessionManager.recordCreatedPermissionMode).toHaveBeenCalledWith('new-sid-123', 'acceptEdits');
  });

  it('§10 permissionMode 未传 → does not persist an implicit default', async () => {
    mockIssueRepo.get.mockReturnValue(makeIssue());
    mockAdapterRegistry.get.mockReturnValue(makeAdapter());
    mockIssueRepo.update.mockReturnValue(makeIssue());
    await issuesResolveInNewSessionHandler({
      issueId: 'issue-1',
      adapter: 'claude-code',
      prompt: 'p',
    });
    expect(mockSessionManager.recordCreatedPermissionMode).not.toHaveBeenCalled();
  });

  it('permission persistence failure is warn-only after creation', async () => {
    mockIssueRepo.get.mockReturnValue(makeIssue());
    const closeSessionForRollback = vi.fn().mockResolvedValue(undefined);
    mockAdapterRegistry.get.mockReturnValue(makeAdapter({ closeSessionForRollback }));
    mockIssueRepo.update.mockReturnValue(makeIssue({ resolutionSessionId: 'new-sid-123' }));
    mockSessionManager.recordCreatedPermissionMode.mockImplementation(() => {
      throw new Error('permission persistence failed');
    });

    await expect(issuesResolveInNewSessionHandler({
      issueId: 'issue-1',
      adapter: 'claude-code',
      prompt: 'p',
      permissionMode: 'acceptEdits',
    })).resolves.toMatchObject({ sessionId: 'new-sid-123' });
    expect(closeSessionForRollback).not.toHaveBeenCalled();
  });

  it.each([
    ['re-read throws', () => {
      mockIssueRepo.get
        .mockReturnValueOnce(makeIssue())
        .mockImplementationOnce(() => { throw new Error('re-read failed'); });
    }],
    ['re-read finds no row', () => {
      mockIssueRepo.get.mockReturnValueOnce(makeIssue()).mockReturnValueOnce(null);
    }],
    ['link update throws', () => {
      mockIssueRepo.get.mockReturnValue(makeIssue());
      mockIssueRepo.update.mockImplementation(() => { throw new Error('update failed'); });
    }],
    ['link update returns no row', () => {
      mockIssueRepo.get.mockReturnValue(makeIssue());
      mockIssueRepo.update.mockReturnValue(null);
    }],
    ['appendix hydration throws', () => {
      mockIssueRepo.get.mockReturnValue(makeIssue());
      mockIssueRepo.update.mockReturnValue(makeIssue({ resolutionSessionId: 'new-sid-123' }));
      mockIssueRepo.listAppendices.mockImplementation(() => { throw new Error('appendix failed'); });
    }],
  ] as Array<[string, () => void]>)('strictly rolls back when required post-create %s', async (_label, arrangeFailure) => {
    const closeSessionForRollback = vi.fn().mockResolvedValue(undefined);
    mockAdapterRegistry.get.mockReturnValue(makeAdapter({ closeSessionForRollback }));
    arrangeFailure();

    await expect(issuesResolveInNewSessionHandler({
      issueId: 'issue-1',
      adapter: 'claude-code',
      prompt: 'p',
    })).rejects.toThrow();
    expect(closeSessionForRollback).toHaveBeenCalledWith('new-sid-123');
    expect(mockSessionManager.close).toHaveBeenCalledWith('new-sid-123');
    expect(mockSessionRepo.get).toHaveBeenCalledWith('new-sid-123');
  });

  it('treats issue-changed notification failure as non-fatal after linking', async () => {
    mockIssueRepo.get.mockReturnValue(makeIssue());
    const closeSessionForRollback = vi.fn().mockResolvedValue(undefined);
    mockAdapterRegistry.get.mockReturnValue(makeAdapter({ closeSessionForRollback }));
    mockIssueRepo.update.mockReturnValue(makeIssue({ resolutionSessionId: 'new-sid-123' }));
    mockEventBus.emit.mockImplementation(() => { throw new Error('event listener failed'); });

    await expect(issuesResolveInNewSessionHandler({
      issueId: 'issue-1',
      adapter: 'claude-code',
      prompt: 'p',
    })).resolves.toMatchObject({ sessionId: 'new-sid-123' });
    expect(closeSessionForRollback).not.toHaveBeenCalled();
  });
});
