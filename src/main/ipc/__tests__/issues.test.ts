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
}));

vi.mock('@main/store/issue-repo', () => ({ issueRepo: mocks.issueRepo }));
vi.mock('@main/adapters/registry', () => ({ adapterRegistry: mocks.adapterRegistry }));
vi.mock('@main/session/manager', () => ({ sessionManager: mocks.sessionManager }));
vi.mock('@main/store/session-repo', () => ({ sessionRepo: mocks.sessionRepo }));
vi.mock('@main/event-bus', () => ({ eventBus: mocks.eventBus }));
vi.mock('@main/adapters/options-builder', () => ({
  buildCreateSessionOptions: mocks.buildCreateSessionOptions,
}));

import {
  issuesUpdateHandler,
  issuesSoftDeleteHandler,
  issuesUndeleteHandler,
  issuesResolveInNewSessionHandler,
  createIssueResolutionSession,
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
describe('createIssueResolutionSession helper — 11 项边界硬化 (§D14 + Step 3.5.1)', () => {
  it('§1+§2 adapter 不存在 throw (不 optional chain 吞错)', async () => {
    mockAdapterRegistry.get.mockReturnValue(null);
    await expect(
      createIssueResolutionSession({
        adapter: 'unknown-adapter',
        cwd: '/repo',
        prompt: 'p',
        permissionMode: null,
        codexSandbox: null,
        claudeCodeSandbox: null,
      }),
    ).rejects.toThrow(/adapter "unknown-adapter" not found/);
  });

  it('§2 adapter 存在但无 createSession method → throw (不 optional chain 吞错)', async () => {
    mockAdapterRegistry.get.mockReturnValue({ id: 'claude-code', capabilities: { canCreateSession: false } });
    await expect(
      createIssueResolutionSession({
        adapter: 'claude-code',
        cwd: '/repo',
        prompt: 'p',
        permissionMode: null,
        codexSandbox: null,
        claudeCodeSandbox: null,
      }),
    ).rejects.toThrow(/does not implement createSession/);
  });

  it('§3 canCreateSession=false → throw', async () => {
    mockAdapterRegistry.get.mockReturnValue(makeAdapter({
      capabilities: { canCreateSession: false, canAcceptAttachments: false },
    }));
    await expect(
      createIssueResolutionSession({
        adapter: 'claude-code',
        cwd: '/repo',
        prompt: 'p',
        permissionMode: null,
        codexSandbox: null,
        claudeCodeSandbox: null,
      }),
    ).rejects.toThrow(/canCreateSession=false/);
  });

  it('§5 cwd > 4096 char → throw', async () => {
    mockAdapterRegistry.get.mockReturnValue(makeAdapter());
    await expect(
      createIssueResolutionSession({
        adapter: 'claude-code',
        cwd: '/'.repeat(4097),
        prompt: 'p',
        permissionMode: null,
        codexSandbox: null,
        claudeCodeSandbox: null,
      }),
    ).rejects.toThrow(/cwd.*length > 4096/);
  });

  it('§6 prompt > 102400 char → throw', async () => {
    mockAdapterRegistry.get.mockReturnValue(makeAdapter());
    await expect(
      createIssueResolutionSession({
        adapter: 'claude-code',
        cwd: '/repo',
        prompt: 'x'.repeat(102_401),
        permissionMode: null,
        codexSandbox: null,
        claudeCodeSandbox: null,
      }),
    ).rejects.toThrow(/prompt.*> 102400/);
  });

  it('§9-§10 happy path: 调 adapter.createSession + recordCreatedPermissionMode 持久化', async () => {
    const adapter = makeAdapter();
    mockAdapterRegistry.get.mockReturnValue(adapter);
    const sid = await createIssueResolutionSession({
      adapter: 'claude-code',
      cwd: '/repo',
      prompt: 'sample prompt',
      permissionMode: 'acceptEdits',
      codexSandbox: null,
      claudeCodeSandbox: null,
    });
    expect(sid).toBe('new-sid-123');
    expect(adapter.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/repo', prompt: 'sample prompt', permissionMode: 'acceptEdits' }),
    );
    // §10 关键：recordCreatedPermissionMode 持久化（项目 CLAUDE.md §会话恢复 硬约束）
    expect(mockSessionManager.recordCreatedPermissionMode).toHaveBeenCalledWith('new-sid-123', 'acceptEdits');
  });

  it('§10 permissionMode=null → capability path does not persist an implicit mode', async () => {
    mockAdapterRegistry.get.mockReturnValue(makeAdapter());
    await createIssueResolutionSession({
      adapter: 'claude-code',
      cwd: '/repo',
      prompt: 'p',
      permissionMode: null,
      codexSandbox: null,
      claudeCodeSandbox: null,
    });
    expect(mockSessionManager.recordCreatedPermissionMode).not.toHaveBeenCalled();
  });

  it('§10 skips permission persistence when the adapter lacks the capability', async () => {
    mockAdapterRegistry.get.mockReturnValue(makeAdapter({
      capabilities: {
        canCreateSession: true,
        canAcceptAttachments: false,
        canSetPermissionMode: false,
      },
    }));
    await createIssueResolutionSession({
      adapter: 'claude-code',
      cwd: '/repo',
      prompt: 'p',
      permissionMode: 'acceptEdits',
      codexSandbox: null,
      claudeCodeSandbox: null,
    });
    expect(mockSessionManager.recordCreatedPermissionMode).not.toHaveBeenCalled();
  });

  it('Codex approvalPolicy 显式值透传到 createSession', async () => {
    const adapter = makeAdapter({ id: 'codex-cli' });
    mockAdapterRegistry.get.mockReturnValue(adapter);
    await createIssueResolutionSession({
      adapter: 'codex-cli',
      cwd: '/repo',
      prompt: 'p',
      permissionMode: null,
      approvalPolicy: 'never',
      codexSandbox: null,
      claudeCodeSandbox: null,
    });
    expect(adapter.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'codex-cli', approvalPolicy: 'never' }),
    );
  });

  it('非 Codex adapter 拒绝 approvalPolicy', async () => {
    const adapter = makeAdapter();
    mockAdapterRegistry.get.mockReturnValue(adapter);
    await expect(createIssueResolutionSession({
      adapter: 'claude-code',
      cwd: '/repo',
      prompt: 'p',
      permissionMode: null,
      approvalPolicy: 'never',
      codexSandbox: null,
      claudeCodeSandbox: null,
    })).rejects.toThrow(/approvalPolicy.*incompatible/);
    expect(adapter.createSession).not.toHaveBeenCalled();
  });

  it('§8 不暴露 attachments — buildCreateSessionOptions 调用 opts 无 attachments 字段', async () => {
    mockAdapterRegistry.get.mockReturnValue(makeAdapter());
    await createIssueResolutionSession({
      adapter: 'claude-code',
      cwd: '/repo',
      prompt: 'p',
      permissionMode: null,
      codexSandbox: null,
      claudeCodeSandbox: null,
    });
    const buildOptsCall = mocks.buildCreateSessionOptions.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(buildOptsCall).not.toHaveProperty('attachments');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// IssuesResolveInNewSession — happy + cwd fallback + in-flight dedupe + emit
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
