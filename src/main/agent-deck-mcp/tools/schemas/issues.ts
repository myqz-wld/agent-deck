import { z } from 'zod';
import type { IssueRecord } from '@shared/types';
import { SDK_WRITE_CALLER_SESSION_ID_DESCRIPTION } from './shared';

// ═══════════════════════════════════════════════════════════════════════════
// Issue Tracker (plan issue-tracker-mcp-20260529 §Step 3.3.1 / §D2 / §D17 / §D19)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * §D2 / §D17：logsRef 严格 schema SSOT。args 层 zod 校验，handler 不再二次校验
 * 字段格式（仅做 merge / null 合并语义）。
 *
 * - `date` 必填 YYYY-MM-DD ISO 格式（regex 严格）
 * - `tsRange?` 可选 { start, end } epoch ms; refine `start <= end` 反则 reject
 * - `scopes?` 可选 string[] max 32 项 / 单项 max 64 char（数组层 max + 元素 max
 *   两个 zod 约束;handler 不需要再 dedupe — repo merge 内 Set 化）
 * - `note?` 可选 string max 2000 char
 *
 * **§D17 整 obj 全字段 null/undefined → reject**：用 `.refine` 检测至少 1 个字段非
 * null/undefined（注：因 `date` 必填 schema 层已强制非空,refine 实际兜底场景是「caller
 * 把 date 传成 undefined / 空字符串」,zod min(1) 已 reject。但保留 `.refine` 以防未来
 * date 字段改 optional — 当前规则等价 reject empty `{date: ''}` / `{}`）。
 */
export const LOGS_REF_SCHEMA = z
  .object({
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD ISO format')
      .describe('Required log date in YYYY-MM-DD format. This is a pointer to logs, not log content.'),
    tsRange: z
      .object({
        start: z.number().int().min(0).describe('Start timestamp in epoch milliseconds.'),
        end: z.number().int().min(0).describe('End timestamp in epoch milliseconds.'),
      })
      .refine((v) => v.start <= v.end, {
        message: 'tsRange.start must be <= tsRange.end',
      })
      .optional()
      .describe('Optional timestamp range inside the log date. start must be <= end.'),
    scopes: z
      .array(z.string().min(1).max(64))
      .max(32, 'scopes max 32 items')
      .optional()
      .describe('Optional log scopes or subsystem names, max 32 items.'),
    note: z
      .string()
      .max(2000)
      .optional()
      .describe('Optional note explaining what the log pointer should help triage.'),
  })
  .refine(
    (v) => v.date != null || v.tsRange != null || v.scopes != null || v.note != null,
    { message: 'logsRef must have at least one non-null field; pass undefined to skip merge' },
  );

/**
 * `report_issue` mcp tool — agent 上报新 issue。返回完整 IssueRecord;主键字段是 `id`
 * （不是 `issueId`）,作为后续同 session append_issue_context / update_issue_status 的 issueId 入参。
 */
export const REPORT_ISSUE_SCHEMA = {
  title: z
    .string()
    .min(1)
    .max(200)
    .describe('Required issue title (1-200 chars).'),
  description: z
    .string()
    .min(1)
    .max(2000)
    .describe(
      'Required issue description (1-2000 chars). Include self-contained context so triagers can read without depending on logs.',
    ),
  repro: z
    .string()
    .min(1)
    .max(2000)
    .nullable()
    .optional()
    .describe('Optional reproduction steps (1-2000 chars). Pass null or omit when not provided.'),
  // §D6: kind 软枚举 + free-form fallback — 不用 z.enum 严格校验,非推荐值原样落库 UI 'other' 分组。
  kind: z
    .string()
    .min(1)
    .max(32)
    .optional()
    .describe(
      'Default "follow-up" (your own follow-up work) or "app-bug" (an Agent Deck defect). Any other string is kept as-is and grouped under "other".',
    ),
  severity: z
    .enum(['low', 'medium', 'high'])
    .optional()
    .describe('Optional severity. Defaults to "medium"; allowed values are low, medium, or high.'),
  logsRef: LOGS_REF_SCHEMA.optional().describe(
    'Optional pointer to runtime logs, not the log content. `date` is required when logsRef is present; tsRange, scopes, and note are optional.',
  ),
  cwd: z
    .string()
    .max(2048)
    .nullable()
    .optional()
    .describe('Optional cwd. Omit it so the handler fills in the caller session cwd automatically.'),
  labels: z
    .array(z.string().min(1).max(64))
    .max(16)
    .optional()
    .describe('Optional free-form tags (max 16 items, each 1-64 chars)'),
  callerSessionId: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(SDK_WRITE_CALLER_SESSION_ID_DESCRIPTION),
};

/**
 * `append_issue_context` mcp tool — agent 在同一 session 内为已上报 issue 追加现场。
 * source-bound + resolved/软删 reject 详 handler;append 走 issue_appendices 子表不动 description。
 */
export const APPEND_ISSUE_CONTEXT_SCHEMA = {
  issueId: z
    .string()
    .min(1)
    .max(128)
    .describe('Issue `id` returned by report_issue. Only the same source session that reported it can append.'),
  additionalContext: z
    .string()
    .min(1)
    .max(2000)
    .describe('New context to append (1-2000 chars). Appended as a separate note; the original description is untouched.'),
  logsRef: LOGS_REF_SCHEMA.optional().describe(
    'Optional logsRef pointer to merge into the issue. Same shape as report_issue.logsRef; date is always required when logsRef is present.',
  ),
  callerSessionId: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(SDK_WRITE_CALLER_SESSION_ID_DESCRIPTION),
};

/**
 * `update_issue_status` mcp tool — issue 的源会话或解决会话自助推进 status。
 * 授权边界 source OR resolution session;软删 reject;可选 note 留痕 — 详 handler。
 */
export const UPDATE_ISSUE_STATUS_SCHEMA = {
  issueId: z
    .string()
    .min(1)
    .max(128)
    .describe('Issue `id` to update. Only its source session or resolution session may update it.'),
  status: z
    .enum(['open', 'in-progress', 'resolved'])
    .describe('New issue status. Use "resolved" after fixing it, or "open" / "in-progress" to reopen.'),
  note: z
    .string()
    .min(1)
    .max(2000)
    .optional()
    .describe('Optional note kept as an appendix explaining how you fixed it or why you reopened it.'),
  callerSessionId: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(SDK_WRITE_CALLER_SESSION_ID_DESCRIPTION),
};

// Args type infer
export type ReportIssueArgs = z.infer<z.ZodObject<typeof REPORT_ISSUE_SCHEMA>>;
export type AppendIssueContextArgs = z.infer<z.ZodObject<typeof APPEND_ISSUE_CONTEXT_SCHEMA>>;
export type UpdateIssueStatusArgs = z.infer<z.ZodObject<typeof UPDATE_ISSUE_STATUS_SCHEMA>>;

/**
 * Result types（§D19）：handler 返回完整 IssueRecord — 与 task_create / task_update
 * 对称，UI 端 emit 'issue-changed' 时直接拿到全 record（含 appendices 子列表 for created /
 * appended kinds）。
 */
export type ReportIssueResult = IssueRecord;
export type AppendIssueContextResult = IssueRecord;
export type UpdateIssueStatusResult = IssueRecord;
