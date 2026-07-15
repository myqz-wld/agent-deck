/**
 * issue tool 测试（plan issue-tracker-mcp-20260529 §Step 3.3.6）。
 *
 * 覆盖 plan 列出的 8 类测试矩阵：
 * 1. report_issue happy path + cwd 兜底（args.cwd > sessionRepo.cwd > null）+ kind 默认值 +
 *    severity 默认值
 * 2. kind free-form fallback（非枚举值 'agent-deck-bug' 原样落库）
 * 3. severity enum 严格（'critical' 等非枚举值 zod reject）
 * 4. append_issue_context owner-only reject（跨 caller — D10 hint）
 * 5. append_issue_context allows the current committed handoff successor
 * 6. append_issue_context to non-existent issueId reject
 * 7. append_issue_context to status='resolved' reject + hint 含「create 新 issue」
 * 8. append_issue_context logsRef merge happy path（D17 — 透传到 issueRepo.appendContext + emit）
 * 9. logsRef args 层 zod reject（date 格式 / tsRange / scopes / note / empty obj）— §D17 SSOT 严格化
 * 10. logsRef merge 后 normalize（note 精确 = 2000 / scopes > 32 取最新 32）— issueRepo 内部行为,
 *     这里仅验 handler 调用透传 args.logsRef 不破坏
 * 11. report_issue / append_issue_context external caller deny（EXTERNAL_CALLER_ALLOWED 矩阵）
 *
 * **测试策略**：mock issueRepo / sessionRepo / eventBus；直接调 handler(args, ctx) 验业务逻辑
 * （绕开 withMcpGuard wrapper deny 链 — 由 helpers / external-caller 测试覆盖,详 §11 矩阵节）。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { makeSessionRepoMock } from '@main/__tests__/_shared/mocks/session-repo';

// vi.hoisted 让 mock objects 在 vi.mock factory 执行前就 ready
const mocks = vi.hoisted(() => {
  const handoffSuccessors = new Map<string, string>();
  return {
    issueRepo: {
      create: vi.fn(),
      get: vi.fn(),
      update: vi.fn(),
      appendContext: vi.fn(),
      listAppendices: vi.fn(),
    },
    eventBus: { emit: vi.fn() },
    handoffSuccessors,
    isCurrentHandOffOwner: vi.fn((owner: string | null, caller: string) =>
      owner !== null && (handoffSuccessors.get(owner) ?? owner) === caller),
  };
});

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: makeSessionRepoMock({}),
}));
vi.mock('@main/store/issue-repo', () => ({ issueRepo: mocks.issueRepo }));
vi.mock('@main/event-bus', () => ({ eventBus: mocks.eventBus }));
vi.mock('@main/session/hand-off/ownership', () => ({
  isCurrentHandOffOwner: mocks.isCurrentHandOffOwner,
  sessionOwnershipLineage: (sessionId: string) => [sessionId],
  sessionOwnershipLineages: (sessionIds: string[]) =>
    new Map(sessionIds.map((sessionId) => [sessionId, [sessionId]])),
}));
vi.mock('@main/utils/git-branch', () => ({
  detectGitBranchName: vi.fn(),
}));

const mockIssueRepo = mocks.issueRepo;
const mockEventBus = mocks.eventBus;

import { sessionRepo } from '@main/store/session-repo';
import { detectGitBranchName } from '@main/utils/git-branch';
const mockSessions = (sessionRepo as unknown as { __sessions: Map<string, unknown> })
  .__sessions;
const mockDetectGitBranchName = vi.mocked(detectGitBranchName);

import { reportIssueHandler } from '../tools/handlers/report-issue';
import { appendIssueContextHandler } from '../tools/handlers/append-issue-context';
import { updateIssueStatusHandler } from '../tools/handlers/update-issue-status';
import {
  REPORT_ISSUE_SCHEMA,
  APPEND_ISSUE_CONTEXT_SCHEMA,
  UPDATE_ISSUE_STATUS_SCHEMA,
  LOGS_REF_SCHEMA,
} from '../tools/schemas';
import { z } from 'zod';
import type { HandlerContext } from '../tools/helpers';
import {
  EXTERNAL_CALLER_ALLOWED,
  EXTERNAL_CALLER_SENTINEL,
} from '../types';
import { denyExternalIfNotAllowed } from '../tools/helpers';
import type { IssueRecord, LogsRef } from '@shared/types';

function makeCtx(callerSessionId: string): HandlerContext {
  return { caller: { callerSessionId, transport: 'in-process' } };
}

function makeIssue(overrides: Partial<IssueRecord> = {}): IssueRecord {
  const now = Date.now();
  return {
    id: 'issue-1',
    title: 'Sample',
    description: 'desc',
    repro: null,
    kind: 'follow-up',
    status: 'open',
    severity: 'medium',
    sourceSessionId: 'sess-caller',
    cwd: '/repo',
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

const REPORT_SCHEMA_OBJ = z.object(REPORT_ISSUE_SCHEMA);
const APPEND_SCHEMA_OBJ = z.object(APPEND_ISSUE_CONTEXT_SCHEMA);
const UPDATE_STATUS_SCHEMA_OBJ = z.object(UPDATE_ISSUE_STATUS_SCHEMA);

beforeEach(() => {
  mockIssueRepo.create.mockReset();
  mockIssueRepo.get.mockReset();
  mockIssueRepo.update.mockReset();
  mockIssueRepo.appendContext.mockReset();
  mockIssueRepo.listAppendices.mockReset();
  mockEventBus.emit.mockReset();
  mocks.handoffSuccessors.clear();
  mocks.isCurrentHandOffOwner.mockClear();
  mockDetectGitBranchName.mockReset().mockReturnValue(null);
  mockSessions.clear();
  // 默认 caller session 在 sessions 表（cwd 兜底测试用到）
  mockSessions.set('sess-caller', {
    id: 'sess-caller',
    lifecycle: 'active',
    cwd: '/repo/from-session',
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §1 report_issue happy path + cwd 兜底 + 默认值
// ═══════════════════════════════════════════════════════════════════════════
describe('report_issue — happy path + cwd 兜底 + 默认值', () => {
  it('happy: closure 注 sourceSessionId + emit issue-changed kind=created + 返回完整 IssueRecord', async () => {
    const created = makeIssue({ id: 'i1', title: 'T1', cwd: '/repo/explicit' });
    mockIssueRepo.create.mockReturnValue(created);

    const result = await reportIssueHandler(
      {
        title: 'T1',
        description: 'd1',
        cwd: '/repo/explicit',
      },
      makeCtx('sess-caller'),
    );

    expect(mockIssueRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'T1',
        description: 'd1',
        sourceSessionId: 'sess-caller', // closure 注
        cwd: '/repo/explicit', // args.cwd 优先
        branchName: null,
      }),
    );
    expect(mockDetectGitBranchName).toHaveBeenCalledWith('/repo/explicit');
    expect(mockEventBus.emit).toHaveBeenCalledWith(
      'issue-changed',
      expect.objectContaining({
        kind: 'created',
        issueId: 'i1',
        sourceSessionId: 'sess-caller',
      }),
    );
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toMatchObject({ id: 'i1', title: 'T1' });
  });

  it('cwd 兜底：args.cwd 未传 → fallback sessionRepo.cwd', async () => {
    mockIssueRepo.create.mockReturnValue(makeIssue({ cwd: '/repo/from-session' }));
    await reportIssueHandler(
      { title: 'T', description: 'D' },
      makeCtx('sess-caller'),
    );
    expect(mockIssueRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/repo/from-session', branchName: null }),
    );
  });

  it('记录 branchName：从最终 cwd 探测 git 分支并透传给 repo', async () => {
    mockDetectGitBranchName.mockReturnValue('feature/issue-branch');
    mockIssueRepo.create.mockReturnValue(makeIssue({
      cwd: '/repo/from-session',
      branchName: 'feature/issue-branch',
    }));

    await reportIssueHandler(
      { title: 'T', description: 'D' },
      makeCtx('sess-caller'),
    );

    expect(mockDetectGitBranchName).toHaveBeenCalledWith('/repo/from-session');
    expect(mockIssueRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/repo/from-session',
        branchName: 'feature/issue-branch',
      }),
    );
  });

  it('branchName 超过持久层上限时降级为 null，report_issue 仍创建 issue', async () => {
    mockDetectGitBranchName.mockReturnValue('feature/' + 'a'.repeat(256));
    mockIssueRepo.create.mockReturnValue(makeIssue({ cwd: '/repo/from-session', branchName: null }));

    const result = await reportIssueHandler(
      { title: 'T', description: 'D' },
      makeCtx('sess-caller'),
    );

    expect(mockDetectGitBranchName).toHaveBeenCalledWith('/repo/from-session');
    expect(mockIssueRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/repo/from-session',
        branchName: null,
      }),
    );
    expect(result.isError).toBeFalsy();
  });

  it('cwd 兜底：args.cwd 未传 + caller 不在 sessions 表 → null', async () => {
    mockSessions.clear(); // 模拟 caller 不在 sessions 表
    mockIssueRepo.create.mockReturnValue(makeIssue({ cwd: null, sourceSessionId: 'ghost-caller' }));
    await reportIssueHandler(
      { title: 'T', description: 'D' },
      makeCtx('ghost-caller'),
    );
    expect(mockIssueRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: null, branchName: null }),
    );
  });

  it('默认值：handler 不显式传 kind / severity，让 repo 走自己 default（zod schema parse 透传）', async () => {
    mockIssueRepo.create.mockReturnValue(makeIssue());
    await reportIssueHandler(
      { title: 'T', description: 'D' },
      makeCtx('sess-caller'),
    );
    const call = mockIssueRepo.create.mock.calls[0][0];
    // kind / severity 未传 → input undefined → repo 自己写 default 'follow-up' / 'medium'
    expect(call.kind).toBeUndefined();
    expect(call.severity).toBeUndefined();
  });

  it('preserves a caught storage error and warns against a duplicate retry', async () => {
    mockIssueRepo.create.mockImplementation(() => {
      throw new Error('SQLITE_BUSY: issues table is locked');
    });

    const result = await reportIssueHandler(
      { title: 'T', description: 'D' },
      makeCtx('sess-caller'),
    );
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(parsed.error).toBe('SQLITE_BUSY: issues table is locked');
    expect(parsed.hint).toMatch(/Do not retry automatically/);
    expect(parsed.hint).toMatch(/Issues UI or logs/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §2 kind free-form fallback (§D6 — 非枚举值原样落库,不 normalize)
// ═══════════════════════════════════════════════════════════════════════════
describe('report_issue — kind free-form fallback (§D6)', () => {
  it('args.kind = "agent-deck-bug"（非推荐 5 值之一）→ 原样透传到 issueRepo.create', async () => {
    mockIssueRepo.create.mockReturnValue(makeIssue({ kind: 'agent-deck-bug' }));
    const result = await reportIssueHandler(
      { title: 'T', description: 'D', kind: 'agent-deck-bug' },
      makeCtx('sess-caller'),
    );
    expect(mockIssueRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'agent-deck-bug' }), // 不 normalize 成 'app-bug'
    );
    expect(result.isError).toBeFalsy();
  });

  it('zod schema 接受任意 1-32 字符 string kind（free-form）', () => {
    expect(REPORT_SCHEMA_OBJ.safeParse({
      title: 'T', description: 'D', kind: 'some-custom-kind',
    }).success).toBe(true);
    expect(REPORT_SCHEMA_OBJ.safeParse({
      title: 'T', description: 'D', kind: 'follow-up',
    }).success).toBe(true);
  });

  it('zod schema reject kind 超 32 字符（DDL CHECK 兜底前的 zod 守门）', () => {
    expect(REPORT_SCHEMA_OBJ.safeParse({
      title: 'T', description: 'D', kind: 'a'.repeat(33),
    }).success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §3 severity enum 严格 (§D9)
// ═══════════════════════════════════════════════════════════════════════════
describe('report_issue — severity enum 严格 (§D9)', () => {
  it('zod reject 非 low/medium/high 值（如 "critical"）', () => {
    expect(REPORT_SCHEMA_OBJ.safeParse({
      title: 'T', description: 'D', severity: 'critical',
    }).success).toBe(false);
  });

  it('zod 接受 low / medium / high', () => {
    for (const s of ['low', 'medium', 'high'] as const) {
      expect(REPORT_SCHEMA_OBJ.safeParse({
        title: 'T', description: 'D', severity: s,
      }).success).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §4-§7 append_issue_context source-bound / non-existent / resolved reject
// ═══════════════════════════════════════════════════════════════════════════
describe('append_issue_context — owner-only / non-existent / resolved reject (§D10 / §D7)', () => {
  it('§4 跨 caller reject + D10 hint「请用 report_issue 重新上报」', async () => {
    mockIssueRepo.get.mockReturnValue(makeIssue({ sourceSessionId: 'sess-orig' }));
    const result = await appendIssueContextHandler(
      { issueId: 'issue-1', additionalContext: 'new ctx' },
      makeCtx('sess-attacker'),
    );
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toMatch(/append rejected/);
    expect(parsed.error).toMatch(/issue\.sourceSessionId=sess-orig/);
    expect(parsed.error).toMatch(/caller=sess-attacker/);
    expect(parsed.hint).toMatch(/current logical owner/);
    expect(parsed.hint).toMatch(/latest committed successor/);
    expect(mockIssueRepo.appendContext).not.toHaveBeenCalled();
    expect(mockEventBus.emit).not.toHaveBeenCalled();
  });

  it('§5 已提交 handoff 的当前 successor 可追加，source provenance 保持原 id', async () => {
    const issue = makeIssue({ sourceSessionId: 'sess-old-pre-handoff' });
    const updated = makeIssue({
      sourceSessionId: 'sess-old-pre-handoff',
      appendices: [],
    });
    mocks.handoffSuccessors.set('sess-old-pre-handoff', 'sess-new-after-handoff');
    mockIssueRepo.get.mockReturnValue(issue);
    mockIssueRepo.appendContext.mockReturnValue(updated);
    const result = await appendIssueContextHandler(
      { issueId: 'issue-1', additionalContext: 'after-handoff append' },
      makeCtx('sess-new-after-handoff'),
    );
    expect(result.isError).toBeFalsy();
    expect(mockIssueRepo.appendContext).toHaveBeenCalledWith(expect.objectContaining({
      appendedSessionId: 'sess-new-after-handoff',
    }));
    expect(JSON.parse(result.content[0].text).sourceSessionId).toBe('sess-old-pre-handoff');
  });

  it('handoff 提交后旧 source 不再能追加 issue context', async () => {
    mocks.handoffSuccessors.set('sess-old-pre-handoff', 'sess-new-after-handoff');
    mockIssueRepo.get.mockReturnValue(makeIssue({ sourceSessionId: 'sess-old-pre-handoff' }));

    const result = await appendIssueContextHandler(
      { issueId: 'issue-1', additionalContext: 'stale owner append' },
      makeCtx('sess-old-pre-handoff'),
    );

    expect(result.isError).toBe(true);
    expect(mockIssueRepo.appendContext).not.toHaveBeenCalled();
  });

  it('§6 non-existent issueId reject + 不调 appendContext', async () => {
    mockIssueRepo.get.mockReturnValue(null);
    const result = await appendIssueContextHandler(
      { issueId: 'issue-ghost', additionalContext: 'ctx' },
      makeCtx('sess-caller'),
    );
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toMatch(/issue issue-ghost not found/);
    expect(parsed.hint).toMatch(/Verify issueId against the id returned by report_issue/);
    expect(parsed.hint).toMatch(/call report_issue to create a new issue/);
    expect(mockIssueRepo.appendContext).not.toHaveBeenCalled();
  });

  it('§7 status="resolved" reject + hint 含「create 新 issue」', async () => {
    mockIssueRepo.get.mockReturnValue(
      makeIssue({ sourceSessionId: 'sess-caller', status: 'resolved' }),
    );
    const result = await appendIssueContextHandler(
      { issueId: 'issue-1', additionalContext: 'ctx' },
      makeCtx('sess-caller'),
    );
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toMatch(/append rejected: issue issue-1 status='resolved'/);
    expect(parsed.hint).toMatch(/Call update_issue_status/);
    expect(parsed.hint).toMatch(/status "open" or "in-progress"/);
    expect(mockIssueRepo.appendContext).not.toHaveBeenCalled();
  });

  it('deleted issue reject gives restore and replacement actions', async () => {
    mockIssueRepo.get.mockReturnValue(
      makeIssue({ sourceSessionId: 'sess-caller', status: 'resolved', deletedAt: Date.now() }),
    );
    const result = await appendIssueContextHandler(
      { issueId: 'issue-1', additionalContext: 'ctx' },
      makeCtx('sess-caller'),
    );
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(parsed.error).toBe('append rejected: issue issue-1 is deleted');
    expect(parsed.hint).toMatch(/restore this issue in the Agent Deck UI/);
    expect(parsed.hint).toMatch(/call report_issue to create a new issue/);
    expect(mockIssueRepo.appendContext).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §8 append_issue_context logsRef happy path（透传 + emit）
// ═══════════════════════════════════════════════════════════════════════════
describe('append_issue_context — happy path + logsRef 透传 + emit', () => {
  it('happy: 校验 sourceSessionId 通过 → 调 appendContext 透传 + emit kind=appended 含完整 record', async () => {
    const issue = makeIssue({ sourceSessionId: 'sess-caller' });
    const updated = makeIssue({
      sourceSessionId: 'sess-caller',
      logsRef: { date: '2026-05-30', scopes: ['scope-a'] },
      appendices: [
        { id: 1, issueId: 'issue-1', body: 'ctx', logsRef: null, appendedSessionId: 'sess-caller', appendedAt: Date.now() },
      ],
    });
    mockIssueRepo.get.mockReturnValue(issue);
    mockIssueRepo.appendContext.mockReturnValue(updated);

    const result = await appendIssueContextHandler(
      {
        issueId: 'issue-1',
        additionalContext: 'ctx',
        logsRef: { date: '2026-05-30', scopes: ['scope-a'] },
      },
      makeCtx('sess-caller'),
    );

    expect(mockIssueRepo.appendContext).toHaveBeenCalledWith(
      expect.objectContaining({
        issueId: 'issue-1',
        body: 'ctx',
        logsRef: { date: '2026-05-30', scopes: ['scope-a'] },
        appendedSessionId: 'sess-caller',
      }),
    );
    expect(mockEventBus.emit).toHaveBeenCalledWith(
      'issue-changed',
      expect.objectContaining({
        kind: 'appended',
        issueId: 'issue-1',
        sourceSessionId: 'sess-caller',
        issue: expect.objectContaining({ id: 'issue-1', appendices: expect.any(Array) }),
      }),
    );
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text).appendices).toHaveLength(1);
  });

  it('args.logsRef 未传时 → 透传 null（appendContext 内 skip merge — §D17 SSOT「args.logsRef==null/undefined 时跳过」）', async () => {
    mockIssueRepo.get.mockReturnValue(makeIssue({ sourceSessionId: 'sess-caller' }));
    mockIssueRepo.appendContext.mockReturnValue(makeIssue({ sourceSessionId: 'sess-caller' }));
    await appendIssueContextHandler(
      { issueId: 'issue-1', additionalContext: 'ctx' },
      makeCtx('sess-caller'),
    );
    expect(mockIssueRepo.appendContext).toHaveBeenCalledWith(
      expect.objectContaining({ logsRef: null }),
    );
  });

  it('appendContext 返 null（race with hardDelete TOCTOU）→ reject + 不 emit', async () => {
    mockIssueRepo.get.mockReturnValue(makeIssue({ sourceSessionId: 'sess-caller' }));
    mockIssueRepo.appendContext.mockReturnValue(null);
    const result = await appendIssueContextHandler(
      { issueId: 'issue-1', additionalContext: 'ctx' },
      makeCtx('sess-caller'),
    );
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toMatch(/disappeared before context was appended/);
    expect(parsed.hint).toMatch(/Do not retry this issueId/);
    expect(parsed.hint).toMatch(/Call report_issue/);
    expect(mockEventBus.emit).not.toHaveBeenCalled();
  });

  it('preserves a caught error and warns against duplicate context', async () => {
    mockIssueRepo.get.mockImplementation(() => {
      throw new Error('SQLITE_IOERR: issue lookup failed');
    });
    const result = await appendIssueContextHandler(
      { issueId: 'issue-1', additionalContext: 'ctx' },
      makeCtx('sess-caller'),
    );
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(parsed.error).toBe('SQLITE_IOERR: issue lookup failed');
    expect(parsed.hint).toMatch(/Do not retry automatically/);
    expect(parsed.hint).toMatch(/retry only if the context is absent/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §9 logsRef args 层 zod reject（D17 SSOT 严格化）
// ═══════════════════════════════════════════════════════════════════════════
describe('logsRef args 层 zod reject (§D17 SSOT)', () => {
  it('reject invalid date 格式 "2026/05/29"', () => {
    expect(
      LOGS_REF_SCHEMA.safeParse({ date: '2026/05/29' }).success,
    ).toBe(false);
  });

  it('reject invalid date 格式 "05-29-2026"', () => {
    expect(
      LOGS_REF_SCHEMA.safeParse({ date: '05-29-2026' }).success,
    ).toBe(false);
  });

  it('accept valid date "2026-05-30"', () => {
    expect(
      LOGS_REF_SCHEMA.safeParse({ date: '2026-05-30' }).success,
    ).toBe(true);
  });

  it('reject tsRange.start > end', () => {
    expect(
      LOGS_REF_SCHEMA.safeParse({
        date: '2026-05-30',
        tsRange: { start: 1000, end: 500 },
      }).success,
    ).toBe(false);
  });

  it('accept tsRange.start === end (edge case 视为合法瞬时事件)', () => {
    expect(
      LOGS_REF_SCHEMA.safeParse({
        date: '2026-05-30',
        tsRange: { start: 1000, end: 1000 },
      }).success,
    ).toBe(true);
  });

  it('reject scopes 超 32 项（input 层）', () => {
    expect(
      LOGS_REF_SCHEMA.safeParse({
        date: '2026-05-30',
        scopes: Array.from({ length: 33 }, (_, i) => `s${i}`),
      }).success,
    ).toBe(false);
  });

  it('accept scopes 恰好 32 项 + 单项 64 char 边界', () => {
    expect(
      LOGS_REF_SCHEMA.safeParse({
        date: '2026-05-30',
        scopes: Array.from({ length: 32 }, (_, i) => `s${i}`),
      }).success,
    ).toBe(true);
    expect(
      LOGS_REF_SCHEMA.safeParse({
        date: '2026-05-30',
        scopes: ['a'.repeat(64)],
      }).success,
    ).toBe(true);
  });

  it('reject scope item 超 64 char', () => {
    expect(
      LOGS_REF_SCHEMA.safeParse({
        date: '2026-05-30',
        scopes: ['a'.repeat(65)],
      }).success,
    ).toBe(false);
  });

  it('reject note 超 2000 char', () => {
    expect(
      LOGS_REF_SCHEMA.safeParse({
        date: '2026-05-30',
        note: 'x'.repeat(2001),
      }).success,
    ).toBe(false);
  });

  it('accept note 精确 2000 char 边界', () => {
    expect(
      LOGS_REF_SCHEMA.safeParse({
        date: '2026-05-30',
        note: 'x'.repeat(2000),
      }).success,
    ).toBe(true);
  });

  it('§D17 reject empty logsRef object {} — date 必填先于 refine 触发', () => {
    // 因 date 是必填 schema 层会先 reject empty {}，refine 兜底场景实际是 caller 不传 date 字段
    expect(LOGS_REF_SCHEMA.safeParse({}).success).toBe(false);
  });

  it('§D17 reject empty date 空字符串 — zod regex 不匹配', () => {
    expect(LOGS_REF_SCHEMA.safeParse({ date: '' }).success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §10 args.logsRef 透传不破坏（normalize 在 repo 层覆盖 — 这里只验 handler 透传完整 obj）
// ═══════════════════════════════════════════════════════════════════════════
describe('append_issue_context — args.logsRef 完整透传到 issueRepo.appendContext', () => {
  it('完整 logsRef 4 字段全透传（normalize 由 repo 层覆盖 — 见 issue-repo.test.ts）', async () => {
    mockIssueRepo.get.mockReturnValue(makeIssue({ sourceSessionId: 'sess-caller' }));
    mockIssueRepo.appendContext.mockReturnValue(makeIssue({ sourceSessionId: 'sess-caller' }));
    const fullLogsRef: LogsRef = {
      date: '2026-05-30',
      tsRange: { start: 100, end: 200 },
      scopes: ['s1', 's2'],
      note: 'sample note',
    };
    await appendIssueContextHandler(
      { issueId: 'issue-1', additionalContext: 'ctx', logsRef: fullLogsRef },
      makeCtx('sess-caller'),
    );
    expect(mockIssueRepo.appendContext).toHaveBeenCalledWith(
      expect.objectContaining({ logsRef: fullLogsRef }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §11 external caller deny — EXTERNAL_CALLER_ALLOWED 矩阵 + denyExternalIfNotAllowed
// ═══════════════════════════════════════════════════════════════════════════
describe('issue tool external caller deny (§不变量 7)', () => {
  it('EXTERNAL_CALLER_ALLOWED 含 3 个 issue write tool 都 false', () => {
    expect(EXTERNAL_CALLER_ALLOWED.report_issue).toBe(false);
    expect(EXTERNAL_CALLER_ALLOWED.append_issue_context).toBe(false);
    expect(EXTERNAL_CALLER_ALLOWED.update_issue_status).toBe(false);
  });

  it('HTTP transport external caller (sentinel) — report_issue DENY', () => {
    const denial = denyExternalIfNotAllowed('report_issue', {
      callerSessionId: EXTERNAL_CALLER_SENTINEL,
      transport: 'http',
    });
    expect(denial).not.toBeNull();
    expect(denial?.isError).toBe(true);
    expect(JSON.parse(denial!.content[0].text).error).toMatch(/report_issue not allowed for external caller/);
  });

  it('HTTP transport external caller (sentinel) — append_issue_context DENY', () => {
    const denial = denyExternalIfNotAllowed('append_issue_context', {
      callerSessionId: EXTERNAL_CALLER_SENTINEL,
      transport: 'http',
    });
    expect(denial).not.toBeNull();
    expect(denial?.isError).toBe(true);
    expect(JSON.parse(denial!.content[0].text).error).toMatch(
      /append_issue_context not allowed for external caller/,
    );
  });

  it('stdio transport sentinel — DENY 两 tool', () => {
    for (const tool of ['report_issue', 'append_issue_context'] as const) {
      const denial = denyExternalIfNotAllowed(tool, {
        callerSessionId: EXTERNAL_CALLER_SENTINEL,
        transport: 'stdio',
      });
      expect(denial).not.toBeNull();
      expect(denial?.isError).toBe(true);
    }
  });

  it('stdio + 非 sentinel callerSid（invariant violation 模拟）— 兜底 DENY', () => {
    const denial = denyExternalIfNotAllowed('report_issue', {
      callerSessionId: 'attacker-injected',
      transport: 'stdio',
    });
    expect(denial).not.toBeNull();
    expect(JSON.parse(denial!.content[0].text).error).toMatch(
      /not allowed for stdio transport with non-sentinel/,
    );
  });

  it('in-process transport + real sid — ALLOW（closure override 路径)', () => {
    for (const tool of ['report_issue', 'append_issue_context'] as const) {
      expect(
        denyExternalIfNotAllowed(tool, {
          callerSessionId: 'sdk-owner-real-sid',
          transport: 'in-process',
        }),
      ).toBeNull();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §12 update_issue_status — 源/解决会话授权 + note 留痕 + 软删/enum/external
// （plan issue-tracker 体验改进 20260531 §需求3）
// ═══════════════════════════════════════════════════════════════════════════
describe('update_issue_status — 源/解决会话自助改 status', () => {
  it('happy: 源会话改 status=resolved → 调 update + emit kind=updated + 返回完整 record', async () => {
    const issue = makeIssue({ sourceSessionId: 'sess-caller', status: 'in-progress' });
    const updated = makeIssue({ sourceSessionId: 'sess-caller', status: 'resolved' });
    mockIssueRepo.get.mockReturnValue(issue);
    mockIssueRepo.update.mockReturnValue(updated);
    mockIssueRepo.listAppendices.mockReturnValue([]);

    const result = await updateIssueStatusHandler(
      { issueId: 'issue-1', status: 'resolved' },
      makeCtx('sess-caller'),
    );

    expect(mockIssueRepo.update).toHaveBeenCalledWith('issue-1', { status: 'resolved' });
    expect(mockIssueRepo.appendContext).not.toHaveBeenCalled(); // 无 note
    expect(mockEventBus.emit).toHaveBeenCalledWith(
      'issue-changed',
      expect.objectContaining({ kind: 'updated', issueId: 'issue-1' }),
    );
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toMatchObject({ id: 'issue-1', status: 'resolved' });
  });

  it('解决会话授权：resolutionSessionId === callerSid 放行（source 是别人）', async () => {
    const issue = makeIssue({
      sourceSessionId: 'sess-orig',
      resolutionSessionId: 'sess-resolver',
      status: 'in-progress',
    });
    mockIssueRepo.get.mockReturnValue(issue);
    mockIssueRepo.update.mockReturnValue(makeIssue({ status: 'resolved' }));
    mockIssueRepo.listAppendices.mockReturnValue([]);

    const result = await updateIssueStatusHandler(
      { issueId: 'issue-1', status: 'resolved' },
      makeCtx('sess-resolver'),
    );

    expect(result.isError).toBeFalsy();
    expect(mockIssueRepo.update).toHaveBeenCalledWith('issue-1', { status: 'resolved' });
  });

  it('第三方 reject：caller 既非 source 又非 resolution → isError + hint + 不调 update', async () => {
    mockIssueRepo.get.mockReturnValue(
      makeIssue({ sourceSessionId: 'sess-orig', resolutionSessionId: 'sess-resolver' }),
    );
    const result = await updateIssueStatusHandler(
      { issueId: 'issue-1', status: 'resolved' },
      makeCtx('sess-third-party'),
    );
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toMatch(/not the current logical owner of source lineage/);
    expect(parsed.error).toMatch(/caller=sess-third-party/);
    expect(parsed.hint).toMatch(/current logical owner/);
    expect(parsed.hint).toMatch(/latest committed successor/);
    expect(parsed.hint).toMatch(/retry once after initialization completes/);
    expect(parsed.hint).toMatch(/Agent Deck UI/);
    expect(mockIssueRepo.update).not.toHaveBeenCalled();
    expect(mockEventBus.emit).not.toHaveBeenCalled();
  });

  it('已提交 handoff 的 source successor 可改 status', async () => {
    mocks.handoffSuccessors.set('sess-orig', 'sess-source-successor');
    mockIssueRepo.get.mockReturnValue(makeIssue({ sourceSessionId: 'sess-orig' }));
    mockIssueRepo.update.mockReturnValue(makeIssue({ sourceSessionId: 'sess-orig', status: 'resolved' }));
    mockIssueRepo.listAppendices.mockReturnValue([]);

    const result = await updateIssueStatusHandler(
      { issueId: 'issue-1', status: 'resolved' },
      makeCtx('sess-source-successor'),
    );

    expect(result.isError).toBeFalsy();
    expect(mockIssueRepo.update).toHaveBeenCalledWith('issue-1', { status: 'resolved' });
  });

  it('handoff 提交后旧 source 不再能修改 issue status', async () => {
    mocks.handoffSuccessors.set('sess-orig', 'sess-source-successor');
    mockIssueRepo.get.mockReturnValue(makeIssue({ sourceSessionId: 'sess-orig' }));

    const result = await updateIssueStatusHandler(
      { issueId: 'issue-1', status: 'resolved' },
      makeCtx('sess-orig'),
    );

    expect(result.isError).toBe(true);
    expect(mockIssueRepo.update).not.toHaveBeenCalled();
  });

  it('已提交 handoff 的 resolution successor 可改 status', async () => {
    mocks.handoffSuccessors.set('sess-resolver', 'sess-resolution-successor');
    mockIssueRepo.get.mockReturnValue(makeIssue({
      sourceSessionId: 'sess-orig',
      resolutionSessionId: 'sess-resolver',
    }));
    mockIssueRepo.update.mockReturnValue(makeIssue({ status: 'resolved' }));
    mockIssueRepo.listAppendices.mockReturnValue([]);

    const result = await updateIssueStatusHandler(
      { issueId: 'issue-1', status: 'resolved' },
      makeCtx('sess-resolution-successor'),
    );

    expect(result.isError).toBeFalsy();
  });

  it('note 留痕：传 note → appendContext 被调（appendedSessionId=callerSid）+ 随后 update', async () => {
    const issue = makeIssue({ sourceSessionId: 'sess-caller', status: 'open' });
    mockIssueRepo.get.mockReturnValue(issue);
    mockIssueRepo.appendContext.mockReturnValue(issue);
    mockIssueRepo.update.mockReturnValue(makeIssue({ status: 'resolved' }));
    mockIssueRepo.listAppendices.mockReturnValue([]);

    await updateIssueStatusHandler(
      { issueId: 'issue-1', status: 'resolved', note: '改了 X 行修复' },
      makeCtx('sess-caller'),
    );

    expect(mockIssueRepo.appendContext).toHaveBeenCalledWith(
      expect.objectContaining({
        issueId: 'issue-1',
        body: '改了 X 行修复',
        logsRef: null,
        appendedSessionId: 'sess-caller',
      }),
    );
    expect(mockIssueRepo.update).toHaveBeenCalledWith('issue-1', { status: 'resolved' });
  });

  it('non-existent issueId reject + 不调 update', async () => {
    mockIssueRepo.get.mockReturnValue(null);
    const result = await updateIssueStatusHandler(
      { issueId: 'issue-ghost', status: 'resolved' },
      makeCtx('sess-caller'),
    );
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toMatch(/issue issue-ghost not found/);
    expect(parsed.hint).toMatch(/Verify issueId against the id returned by report_issue/);
    expect(parsed.hint).toMatch(/call report_issue to create a new issue/);
    expect(mockIssueRepo.update).not.toHaveBeenCalled();
  });

  it('软删 reject（即使是源会话）', async () => {
    mockIssueRepo.get.mockReturnValue(
      makeIssue({ sourceSessionId: 'sess-caller', deletedAt: Date.now() }),
    );
    const result = await updateIssueStatusHandler(
      { issueId: 'issue-1', status: 'resolved' },
      makeCtx('sess-caller'),
    );
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('update_issue_status rejected: issue issue-1 is deleted');
    expect(parsed.hint).toMatch(/restore this issue in the Agent Deck UI/);
    expect(parsed.hint).toMatch(/retry update_issue_status/);
    expect(mockIssueRepo.update).not.toHaveBeenCalled();
  });

  it('status enum：zod reject 非法值（如 "done"）', () => {
    expect(
      UPDATE_STATUS_SCHEMA_OBJ.safeParse({ issueId: 'i1', status: 'done' }).success,
    ).toBe(false);
    for (const s of ['open', 'in-progress', 'resolved'] as const) {
      expect(
        UPDATE_STATUS_SCHEMA_OBJ.safeParse({ issueId: 'i1', status: s }).success,
      ).toBe(true);
    }
  });

  it('note zod 边界：空字符串 reject / > 2000 reject', () => {
    expect(
      UPDATE_STATUS_SCHEMA_OBJ.safeParse({ issueId: 'i1', status: 'open', note: '' }).success,
    ).toBe(false);
    expect(
      UPDATE_STATUS_SCHEMA_OBJ.safeParse({
        issueId: 'i1',
        status: 'open',
        note: 'a'.repeat(2001),
      }).success,
    ).toBe(false);
  });

  it('external deny：EXTERNAL_CALLER_ALLOWED.update_issue_status === false + http/stdio sentinel DENY', () => {
    expect(EXTERNAL_CALLER_ALLOWED.update_issue_status).toBe(false);
    for (const transport of ['http', 'stdio'] as const) {
      const denial = denyExternalIfNotAllowed('update_issue_status', {
        callerSessionId: EXTERNAL_CALLER_SENTINEL,
        transport,
      });
      expect(denial).not.toBeNull();
      expect(denial?.isError).toBe(true);
    }
  });

  it('双 null reject（review Round 1）：source/resolution 皆 null（会话被 GC）→ 任意 caller reject + 不调 update', async () => {
    // §12.3 第三方 reject 用的是 source/resolution 皆**非** null（两个具体 sid）+ 第三方 caller，
    // 不等价于本 cell：source/resolution 皆 null（会话被 GC 后字段清空）时任意 caller 都该 reject
    // ——只能走 UI 改 status。验证 `null === callerSid` 恒 false（callerSid 由 makeCallerContext
    // 保证非空 string），不会因 `null===null` 误放行。
    mockIssueRepo.get.mockReturnValue(
      makeIssue({ sourceSessionId: null, resolutionSessionId: null, status: 'in-progress' }),
    );
    const result = await updateIssueStatusHandler(
      { issueId: 'issue-1', status: 'resolved' },
      makeCtx('sess-anyone'),
    );
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toMatch(/not the current logical owner of source lineage/);
    expect(parsed.error).toMatch(/source lineage \(<null>\) or resolution lineage \(<null>\)/);
    expect(mockIssueRepo.update).not.toHaveBeenCalled();
    expect(mockEventBus.emit).not.toHaveBeenCalled();
  });

  it('部分失败（review Round 1）：note appendContext 成功但 update 返 null（TOCTOU hardDelete）→ isError + 已写 note', async () => {
    // note 与 update 非同一事务（benign 窗口，见 handler 注释）。appendContext 已 commit 后
    // update 返 null（race hardDelete）→ handler 返 "disappeared during update" err；note appendix
    // 走 FK CASCADE 随 issue 删不残留。本用例验证返回契约：isError + appendContext 确实被调过。
    const issue = makeIssue({ sourceSessionId: 'sess-caller', status: 'open' });
    mockIssueRepo.get.mockReturnValue(issue);
    mockIssueRepo.appendContext.mockReturnValue(issue);
    mockIssueRepo.update.mockReturnValue(null); // race: issue 在 append 与 update 间被 hardDelete

    const result = await updateIssueStatusHandler(
      { issueId: 'issue-1', status: 'resolved', note: '修复说明' },
      makeCtx('sess-caller'),
    );

    expect(mockIssueRepo.appendContext).toHaveBeenCalledWith(
      expect.objectContaining({ issueId: 'issue-1', body: '修复说明', appendedSessionId: 'sess-caller' }),
    );
    // reviewer-codex R2 INFO：断言 update 真被调（否则未来实现改成 append 后直接 err 不试 update，
    // 本用例仍会误过）—— 验证「确实走到 update 那步、是 update 返 null 触发 err」而非提前短路。
    expect(mockIssueRepo.update).toHaveBeenCalledWith('issue-1', { status: 'resolved' });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toMatch(/disappeared before its status was updated/);
    expect(parsed.hint).toMatch(/Do not retry this issueId/);
    expect(parsed.hint).toMatch(/Call report_issue/);
    expect(mockEventBus.emit).not.toHaveBeenCalled(); // update 失败 → 不 emit
  });

  it('preserves a caught error and warns against duplicating a note or status update', async () => {
    mockIssueRepo.get.mockImplementation(() => {
      throw new Error('SQLITE_CORRUPT: issue read failed');
    });
    const result = await updateIssueStatusHandler(
      { issueId: 'issue-1', status: 'resolved' },
      makeCtx('sess-caller'),
    );
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(parsed.error).toBe('SQLITE_CORRUPT: issue read failed');
    expect(parsed.hint).toMatch(/Do not retry automatically/);
    expect(parsed.hint).toMatch(/note or status may already have been written/);
  });
});


describe('report_issue / append_issue_context args zod 边界', () => {
  it('reject report_issue title 空字符串', () => {
    expect(
      REPORT_SCHEMA_OBJ.safeParse({ title: '', description: 'D' }).success,
    ).toBe(false);
  });

  it('reject report_issue title > 200 char', () => {
    expect(
      REPORT_SCHEMA_OBJ.safeParse({
        title: 'a'.repeat(201),
        description: 'D',
      }).success,
    ).toBe(false);
  });

  it('reject report_issue description 超 2000 char', () => {
    expect(
      REPORT_SCHEMA_OBJ.safeParse({
        title: 'T',
        description: 'a'.repeat(2001),
      }).success,
    ).toBe(false);
  });

  it('reject append_issue_context additionalContext 空字符串', () => {
    expect(
      APPEND_SCHEMA_OBJ.safeParse({
        issueId: 'i1',
        additionalContext: '',
      }).success,
    ).toBe(false);
  });

  it('reject append_issue_context additionalContext > 2000 char', () => {
    expect(
      APPEND_SCHEMA_OBJ.safeParse({
        issueId: 'i1',
        additionalContext: 'a'.repeat(2001),
      }).success,
    ).toBe(false);
  });
});
