/**
 * issue tool 测试（plan issue-tracker-mcp-20260529 §Step 3.3.6）。
 *
 * 覆盖 plan 列出的 8 类测试矩阵：
 * 1. report_issue happy path + cwd 兜底（args.cwd > sessionRepo.cwd > null）+ kind 默认值 +
 *    severity 默认值
 * 2. kind free-form fallback（非枚举值 'agent-deck-bug' 原样落库）
 * 3. severity enum 严格（'critical' 等非枚举值 zod reject）
 * 4. append_issue_context owner-only reject（跨 caller — D10 hint）
 * 5. append_issue_context owner-only reject（跨 session — hand_off 后新 sid 同款 hint）
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
const mocks = vi.hoisted(() => ({
  issueRepo: {
    create: vi.fn(),
    get: vi.fn(),
    appendContext: vi.fn(),
    listAppendices: vi.fn(),
  },
  eventBus: { emit: vi.fn() },
}));

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: makeSessionRepoMock({}),
}));
vi.mock('@main/store/issue-repo', () => ({ issueRepo: mocks.issueRepo }));
vi.mock('@main/event-bus', () => ({ eventBus: mocks.eventBus }));

const mockIssueRepo = mocks.issueRepo;
const mockEventBus = mocks.eventBus;

import { sessionRepo } from '@main/store/session-repo';
const mockSessions = (sessionRepo as unknown as { __sessions: Map<string, unknown> })
  .__sessions;

import { reportIssueHandler } from '../tools/handlers/report-issue';
import { appendIssueContextHandler } from '../tools/handlers/append-issue-context';
import {
  REPORT_ISSUE_SCHEMA,
  APPEND_ISSUE_CONTEXT_SCHEMA,
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

beforeEach(() => {
  mockIssueRepo.create.mockReset();
  mockIssueRepo.get.mockReset();
  mockIssueRepo.appendContext.mockReset();
  mockIssueRepo.listAppendices.mockReset();
  mockEventBus.emit.mockReset();
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
      }),
    );
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
      expect.objectContaining({ cwd: '/repo/from-session' }),
    );
  });

  it('cwd 兜底：args.cwd 未传 + caller 不在 sessions 表 → null', async () => {
    mockSessions.clear(); // 模拟 caller 不在 sessions 表
    mockIssueRepo.create.mockReturnValue(makeIssue({ cwd: null, sourceSessionId: 'ghost-caller' }));
    await reportIssueHandler(
      { title: 'T', description: 'D' },
      makeCtx('ghost-caller'),
    );
    expect(mockIssueRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: null }),
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
    expect(parsed.hint).toMatch(/report_issue 重新上报新 issue/);
    expect(mockIssueRepo.appendContext).not.toHaveBeenCalled();
    expect(mockEventBus.emit).not.toHaveBeenCalled();
  });

  it('§5 跨 session reject（hand_off 后新 sid 模拟）— 同款 D10 hint', async () => {
    mockIssueRepo.get.mockReturnValue(makeIssue({ sourceSessionId: 'sess-old-pre-handoff' }));
    const result = await appendIssueContextHandler(
      { issueId: 'issue-1', additionalContext: 'after-handoff append' },
      makeCtx('sess-new-after-handoff'),
    );
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toMatch(/sess-old-pre-handoff/);
    expect(parsed.error).toMatch(/sess-new-after-handoff/);
    expect(parsed.hint).toMatch(/report_issue 重新上报新 issue/);
  });

  it('§6 non-existent issueId reject + 不调 appendContext', async () => {
    mockIssueRepo.get.mockReturnValue(null);
    const result = await appendIssueContextHandler(
      { issueId: 'issue-ghost', additionalContext: 'ctx' },
      makeCtx('sess-caller'),
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toMatch(/issue issue-ghost not found/);
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
    expect(parsed.hint).toMatch(/create 新 issue/);
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
    expect(JSON.parse(result.content[0].text).error).toMatch(/disappeared during append/);
    expect(mockEventBus.emit).not.toHaveBeenCalled();
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
  it('EXTERNAL_CALLER_ALLOWED 17 entries 含两 issue write tool 都 false', () => {
    expect(EXTERNAL_CALLER_ALLOWED.report_issue).toBe(false);
    expect(EXTERNAL_CALLER_ALLOWED.append_issue_context).toBe(false);
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
// §args zod 边界（title / description / additionalContext 长度守门）
// ═══════════════════════════════════════════════════════════════════════════
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
