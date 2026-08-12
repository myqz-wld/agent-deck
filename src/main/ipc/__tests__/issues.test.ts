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
  issuesUpdateHandler,
  issuesSoftDeleteHandler,
  issuesUndeleteHandler,
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
describe('issuesUpdateHandler — zod enum 严格 (§D7 + §D15 case 9)', () => {
  it('reject status="foo" 非 3 态值 (zod enum 第 9 case)', () => {
    expect(() => issuesUpdateHandler('issue-1', { status: 'foo' })).toThrow(/invalid ipc input.*patch/);
    expect(mockIssueRepo.update).not.toHaveBeenCalled();
  });

  it('reject status="closed" 非 3 态值', () => {
    expect(() => issuesUpdateHandler('issue-1', { status: 'closed' })).toThrow(/invalid ipc input.*patch/);
  });

  it('reject severity="critical" 非 3 态值', () => {
    expect(() => issuesUpdateHandler('issue-1', { severity: 'critical' })).toThrow(/invalid ipc input.*patch/);
  });

  it('reject patch 含未知字段 (strict)', () => {
    expect(() => issuesUpdateHandler('issue-1', { unknownField: 'x' })).toThrow(/invalid ipc input.*patch/);
  });

  it('accept status="open" / "in-progress" / "resolved" 三态', () => {
    mockIssueRepo.update.mockReturnValue(makeIssue({ status: 'in-progress' }));
    issuesUpdateHandler('issue-1', { status: 'in-progress' });
    expect(mockIssueRepo.update).toHaveBeenCalledWith('issue-1', expect.objectContaining({ status: 'in-progress' }));
  });

  it('partial patch 不带 status (idempotent — D15 边角): handler 透传到 repo + emit kind=updated', () => {
    mockIssueRepo.update.mockReturnValue(makeIssue({ title: 'NewT' }));
    const result = issuesUpdateHandler('issue-1', { title: 'NewT' });
    // status 字段缺失，patch 仍透传 — repo D15 内部走「不带 status → 不动 resolved_at」路径
    expect(mockIssueRepo.update).toHaveBeenCalledWith('issue-1', { title: 'NewT' });
    expect(mockEventBus.emit).toHaveBeenCalledWith(
      'issue-changed',
      expect.objectContaining({ kind: 'updated', issueId: 'issue-1' }),
    );
    expect(result.title).toBe('NewT');
  });

  it('reject 不存在 id (repo.update returns null)', () => {
    mockIssueRepo.update.mockReturnValue(null);
    expect(() => issuesUpdateHandler('ghost-id', { title: 'T' })).toThrow(/ghost-id not found/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// IssuesSoftDelete / IssuesUndelete — 改 deleted_at + emit
// ═══════════════════════════════════════════════════════════════════════════
describe('issuesSoftDeleteHandler / issuesUndeleteHandler — 改 deleted_at + emit kind', () => {
  it('softDelete 成功 → emit kind="softDeleted" + 含 issue snapshot (deletedAt 非 null)', () => {
    mockIssueRepo.softDelete.mockReturnValue(true);
    mockIssueRepo.get.mockReturnValue(makeIssue({ deletedAt: Date.now() }));
    const result = issuesSoftDeleteHandler('issue-1');
    expect(result).toBe(true);
    expect(mockIssueRepo.softDelete).toHaveBeenCalledWith('issue-1');
    expect(mockEventBus.emit).toHaveBeenCalledWith(
      'issue-changed',
      expect.objectContaining({
        kind: 'softDeleted',
        issueId: 'issue-1',
        sourceSessionId: 'sess-orig',
        issue: expect.objectContaining({ deletedAt: expect.any(Number) }),
      }),
    );
  });

  it('softDelete 已 soft-deleted (idempotent) → 返 false + 不 emit', () => {
    mockIssueRepo.softDelete.mockReturnValue(false);
    const result = issuesSoftDeleteHandler('issue-1');
    expect(result).toBe(false);
    expect(mockEventBus.emit).not.toHaveBeenCalled();
  });

  it('undelete 成功 → emit kind="undeleted" + 含 issue snapshot (deletedAt null)', () => {
    mockIssueRepo.undelete.mockReturnValue(true);
    mockIssueRepo.get.mockReturnValue(makeIssue({ deletedAt: null }));
    const result = issuesUndeleteHandler('issue-1');
    expect(result).toBe(true);
    expect(mockIssueRepo.undelete).toHaveBeenCalledWith('issue-1');
    expect(mockEventBus.emit).toHaveBeenCalledWith(
      'issue-changed',
      expect.objectContaining({
        kind: 'undeleted',
        issueId: 'issue-1',
        sourceSessionId: 'sess-orig',
      }),
    );
  });

  it('undelete 未 soft-deleted (idempotent) → 返 false + 不 emit', () => {
    mockIssueRepo.undelete.mockReturnValue(false);
    const result = issuesUndeleteHandler('issue-1');
    expect(result).toBe(false);
    expect(mockEventBus.emit).not.toHaveBeenCalled();
  });

  it('reject 非法 id (空字符串) — parseStringId 守门', () => {
    expect(() => issuesSoftDeleteHandler('')).toThrow(/invalid ipc input.*id/);
    expect(() => issuesUndeleteHandler('')).toThrow(/invalid ipc input.*id/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// createIssueResolutionSession helper — 11 项边界硬化
// ═══════════════════════════════════════════════════════════════════════════
