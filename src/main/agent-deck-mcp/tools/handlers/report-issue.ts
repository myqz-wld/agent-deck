/**
 * report_issue handler — agent 上报新 issue,source_session_id 闭包注入 caller sid。
 *
 * plan issue-tracker-mcp-20260529 §Step 3.3.2 / §D2 / §D6 / §D19。
 *
 * 关键行为：
 * - `ctx.caller.callerSessionId` 闭包注 issue.source_session_id（§不变量 3 source = owner）
 * - cwd 兜底链：`args.cwd > sessionRepo.get(callerSid)?.cwd > null`
 * - issueRepo.create 返回完整 IssueRecord（§D19 与 task_create 对称）
 * - emit eventBus 'issue-changed' kind='created'（plan §Step 3.4.2 EventMap 已加 — UI bridge 在 Step 3.4 落地）
 * - withMcpGuard pattern：deny external + caller 反查（§不变量 7 — write 路径 deny external 严守）
 *
 * **§不变量 1**：report_issue 仅 write 不 read（不查别人 issue）；agent 拿到 returned IssueRecord
 * 后用其主键字段 `id`（不是 `issueId`）作为后续同 session append_issue_context / update_issue_status
 * 的 `issueId` 入参。status 写入受限：仅源 / 解决会话经 update_issue_status 自助推进，其余 admin 走 UI。
 */

import { sessionRepo } from '@main/store/session-repo';
import { issueRepo } from '@main/store/issue-repo';
import { eventBus } from '@main/event-bus';
import { detectGitBranchName } from '@main/utils/git-branch';
import { normalizeIssueBranchName } from '@shared/types';

import {
  err,
  ok,
  withMcpGuard,
  type HandlerContext,
} from '../helpers';
import type { ReportIssueArgs, ReportIssueResult } from '../schemas';

export const reportIssueHandler = withMcpGuard(
  'report_issue',
  async (args: ReportIssueArgs, ctx: HandlerContext) => {
    try {
      const callerSid = ctx.caller.callerSessionId;
      // §D2 cwd 兜底链：caller args.cwd > sessionRepo.cwd 快照 > null。
      // 显式 null（caller 传 cwd: null）也走 fallback — `??` 把 null/undefined 都视为缺省。
      const cwdFallback = args.cwd ?? sessionRepo.get(callerSid)?.cwd ?? null;
      const created = issueRepo.create({
        title: args.title,
        description: args.description,
        repro: args.repro ?? null,
        kind: args.kind,
        severity: args.severity,
        sourceSessionId: callerSid,
        cwd: cwdFallback,
        branchName: normalizeIssueBranchName(detectGitBranchName(cwdFallback)),
        logsRef: args.logsRef ?? null,
        labels: args.labels,
      });
      eventBus.emit('issue-changed', {
        kind: 'created',
        issueId: created.id,
        issue: created,
        sourceSessionId: created.sourceSessionId,
        ts: Date.now(),
      });
      return ok(created satisfies ReportIssueResult);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
);
