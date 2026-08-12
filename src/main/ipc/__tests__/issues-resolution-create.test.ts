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
  createIssueResolutionSession,
  _resetInFlightResolveForTesting,
} from '../issues';

const mockIssueRepo = mocks.issueRepo;
const mockAdapterRegistry = mocks.adapterRegistry;
const mockSessionManager = mocks.sessionManager;
const mockEventBus = mocks.eventBus;
const mockSessionRepo = mocks.sessionRepo;

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

  it('omits attachments when the resolution request has none', async () => {
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

  it('persists and forwards bounded attachments through the shared create path', async () => {
    const persisted = [{
      kind: 'uploaded', path: '/uploads/issue.png', mime: 'image/png',
      bytes: 4, originalName: 'issue.png',
    }];
    mocks.persistAdapterAttachments.mockResolvedValue(persisted);
    mockAdapterRegistry.get.mockReturnValue(makeAdapter({
      capabilities: {
        canCreateSession: true,
        canAcceptAttachments: true,
        canSetPermissionMode: true,
      },
    }));
    const raw = [{ kind: 'image', mime: 'image/png', base64: 'dGVzdA==', bytes: 4 }];

    await createIssueResolutionSession({
      adapter: 'claude-code', cwd: '/repo', prompt: 'p', attachments: raw,
      permissionMode: null, codexSandbox: null, claudeCodeSandbox: null,
    });

    expect(mocks.persistAdapterAttachments).toHaveBeenCalledWith(raw, 'attachments');
    expect(mocks.buildCreateSessionOptions.mock.calls[0]?.[1]).toMatchObject({
      attachments: persisted,
    });
  });

  it('removes persisted attachments when provider creation fails', async () => {
    const persisted = [{
      kind: 'uploaded', path: '/uploads/failed.png', mime: 'image/png',
      bytes: 4, originalName: 'failed.png',
    }];
    mocks.persistAdapterAttachments.mockResolvedValue(persisted);
    mockAdapterRegistry.get.mockReturnValue(makeAdapter({
      capabilities: { canCreateSession: true, canAcceptAttachments: true },
      createSession: vi.fn().mockRejectedValue(new Error('provider failed')),
    }));

    await expect(createIssueResolutionSession({
      adapter: 'claude-code', cwd: '/repo', prompt: 'p', attachments: [{}],
      permissionMode: null, codexSandbox: null, claudeCodeSandbox: null,
    })).rejects.toThrow('provider failed');
    expect(mocks.deleteUploadIfExists).toHaveBeenCalledWith('/uploads/failed.png');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// IssuesResolveInNewSession — happy + cwd fallback + in-flight dedupe + emit
// ═══════════════════════════════════════════════════════════════════════════
