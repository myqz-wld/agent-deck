/**
 * append_issue_context handler — agent 在**同一 session 内**为已上报 issue 追加现场。
 *
 * plan issue-tracker-mcp-20260529 §Step 3.3.3 / §D7 / §D10 / §D16 / §D17 / §D19。
 *
 * 关键行为：
 * 1. **strict source-bound**（§D10 / §不变量 3）：`issue.sourceSessionId === callerSid`，
 *    跨 session / 跨 caller 一律 reject + 详细 hint「issue.sourceSessionId=<old>, caller=<new>。
 *    append_issue_context 仅支持同 session 补现场,请用 report_issue 重新上报新 issue,UI 端人工 merge」
 * 2. **status='resolved' 时 reject**（§D7 / §D13）：「issue 已 resolved，新现场请 create 新 issue」
 *    避免 resolved issue 被 appendContext 长期续命让 GC 时钟错位
 * 3. **append 不动 issues.description**（§不变量 9 / §D16）：新行写入 issue_appendices 子表 +
 *    可选 args.logsRef merge 到 issues.logs_ref（§D17 算法在 issueRepo.appendContext 内）
 * 4. **返回完整 IssueRecord 含 appendices**（§D19 与 task_create / report_issue 对称）让 UI emit
 *    'issue-changed' kind='appended' 时一次拿全 record + 子表
 *
 * **§不变量 7 deny external**：与 report_issue 同款 — 写 issues + issue_appendices 表 +
 * source-bound 校验需要真实 in-process closure callerSessionId。
 */

import { issueRepo } from '@main/store/issue-repo';
import { eventBus } from '@main/event-bus';

import {
  err,
  ok,
  withMcpGuard,
  type HandlerContext,
} from '../helpers';
import type { AppendIssueContextArgs, AppendIssueContextResult } from '../schemas';

export const appendIssueContextHandler = withMcpGuard(
  'append_issue_context',
  async (args: AppendIssueContextArgs, ctx: HandlerContext) => {
    try {
      const callerSid = ctx.caller.callerSessionId;
      const issue = issueRepo.get(args.issueId);
      if (!issue) {
        return err(`issue ${args.issueId} not found`);
      }
      // §D10 strict source-bound 校验：issue.sourceSessionId 必须等于 callerSid。
      // 跨 session / 跨 caller / hand_off 后丢 issueId 都走这条 reject 路径,详细 hint
      // 让 agent 知道改走 report_issue 重新上报新 issue。
      if (issue.sourceSessionId !== callerSid) {
        return err(
          `append rejected: issue.sourceSessionId=${issue.sourceSessionId ?? '<null>'}, caller=${callerSid}`,
          'append_issue_context 仅支持同 session 补现场（agent 重启 / hand_off 后丢 issueId）。请用 report_issue 重新上报新 issue,UI 端人工 merge。',
        );
      }
      // §D7 status='resolved' reject：issue 已经 resolved 状态机进入 GC 倒计时（§D13），
      // append 现场到 resolved issue 会让 issues.updated_at 刷新但不刷 resolved_at,既无法
      // 重新触发用户 triage 又让 GC 行为暧昧（resolved_at 与 updated_at 不一致）。
      if (issue.status === 'resolved') {
        return err(
          `append rejected: issue ${args.issueId} status='resolved'`,
          'issue 已 resolved，新现场请 create 新 issue（resolved issue 不接受 append — UI 端可手工改 status 回 in-progress 让 issue 重新可 append）。',
        );
      }
      // §D16 append 子表 + §D17 logsRef merge（当 args.logsRef 非 null/undefined 时）。
      // repo.appendContext 内部已实现 merge 算法 + 返回 getWithAppendices 含 appendices 子列表。
      const updated = issueRepo.appendContext({
        issueId: args.issueId,
        body: args.additionalContext,
        logsRef: args.logsRef ?? null,
        appendedSessionId: callerSid,
      });
      if (!updated) {
        // 极少数 race case：repo.get(issueId) 之间 TOCTOU 被另一处 hardDelete 掉
        return err(`issue ${args.issueId} disappeared during append (race with hardDelete)`);
      }
      eventBus.emit('issue-changed', {
        kind: 'appended',
        issueId: updated.id,
        issue: updated,
        sourceSessionId: updated.sourceSessionId,
        ts: Date.now(),
      });
      return ok(updated satisfies AppendIssueContextResult);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
);
