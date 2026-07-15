/**
 * update_issue_status handler — source / resolution lineage 的**当前逻辑所有者**推进 status。
 *
 * plan issue-tracker 体验改进 20260531 §需求3（打破旧「agent 永不改 status」铁律的受控开口）。
 *
 * 关键行为：
 * 1. **两条 logical-owner lineage**（比 append_issue_context 多认 resolution lineage）：
 *    未 handoff 时各自的原 session 可写；handoff commit 后仅各自 latest successor 可写，
 *    predecessor 立即失权。两者皆 null（会话被 GC）时只能走 UI。
 * 2. **软删 reject**（与 append 对称）：已被用户隐藏的 issue 不接受 agent 改 status。
 * 3. **可选 note 留痕**：note 非空时复用 issueRepo.appendContext 写一条补充记录
 *    （body=note, logsRef=null, appendedSessionId=callerSid）— 记录怎么修的 / 为何 reopen,
 *    再走 issueRepo.update({status}) 的 D15 resolved_at 状态机。
 * 4. **返回完整 IssueRecord 含 appendices** + emit 'issue-changed' kind='updated'（与 IPC
 *    IssuesUpdate handler 同款 — UI 端实时刷新 list + detail）。
 *
 * **§不变量 7 deny external**：写 issues 表 + 授权校验需真实 in-process closure callerSessionId。
 */

import { issueRepo } from '@main/store/issue-repo';
import { eventBus } from '@main/event-bus';
import { isCurrentHandOffOwner } from '@main/session/hand-off/ownership';

import {
  err,
  ok,
  withMcpGuard,
  type HandlerContext,
} from '../helpers';
import type { UpdateIssueStatusArgs, UpdateIssueStatusResult } from '../schemas';

export const updateIssueStatusHandler = withMcpGuard(
  'update_issue_status',
  async (args: UpdateIssueStatusArgs, ctx: HandlerContext) => {
    try {
      const callerSid = ctx.caller.callerSessionId;
      const issue = issueRepo.get(args.issueId);
      if (!issue) {
        return err(
          `issue ${args.issueId} not found`,
          'Verify issueId against the id returned by report_issue. If the issue was removed, call report_issue to create a new issue.',
        );
      }
      // 授权校验：源 / 解决会话的当前逻辑所有者。provenance 字段保持原 session id。
      const isSource = isCurrentHandOffOwner(issue.sourceSessionId, callerSid);
      const isResolution = isCurrentHandOffOwner(issue.resolutionSessionId, callerSid);
      if (!isSource && !isResolution) {
        // MED-1 轻量缓和（plan issue-tracker 体验改进 20260531 review Round 1）：
        // IPC IssuesResolveInNewSession 先 await createSession（启动 SDK + 消费首轮 prompt）
        // 才写回 resolutionSessionId（ipc/issues.ts:273→294）。解决会话若在首轮极早期就调本
        // tool，DB 里 resolutionSessionId 可能尚未写入 → 落到此第三方分支被 reject。窗口属
        // createSession 内部固有（return sid 时 SDK 已消费 prompt），外部前置消不掉；故 hint
        // 引导「刚起的解决会话几秒后重试」把 silent reject 变成可理解的一时错（重试即命中）。
        return err(
          `update_issue_status rejected: caller=${callerSid} is not the current logical owner of source lineage (${issue.sourceSessionId ?? '<null>'}) or resolution lineage (${issue.resolutionSessionId ?? '<null>'}) for issue ${args.issueId}`,
          "Only a current logical owner of the issue's source or resolution lineage can update it: the original lineage session before handoff, or only that lineage's latest committed successor afterward. A predecessor whose handoff committed no longer has authority. If this is a newly launched resolution session, retry once after initialization completes; otherwise ask the user to update the issue in the Agent Deck UI.",
        );
      }
      // 软删 reject（与 append_issue_context 对称）：用户已隐藏的 issue 不接受 agent 改 status。
      if (issue.deletedAt !== null) {
        return err(
          `update_issue_status rejected: issue ${args.issueId} is deleted`,
          'Ask the user to restore this issue in the Agent Deck UI, then retry update_issue_status.',
        );
      }
      // 可选 note 留痕：非空 → 复用 appendContext 写一条补充记录（怎么修的 / 为何 reopen）。
      // appendContext 返 null 仅在极少数 TOCTOU race（get 与 append 间被 hardDelete）— 此时
      // 放弃 note 但继续改 status（status 是主操作；note 是 nice-to-have 留痕）。
      // **非原子窗口（review Round 1 LOW，benign 不强原子）**：appendContext 与下方 update 不在
      // 同一事务。若 update throw（DB locked 等罕见）→ note appendix 已 commit + updated_at 已
      // bump 但 status 未改，留「有 note 没改 status」中间态。非破坏、可重试（重试累积多 appendix，
      // UI 按 appendedAt asc 渲染仅轻微 noise）；若 update 返 null（race hardDelete），appendix 走
      // FK ON DELETE CASCADE（v026_issues.sql）一并删，note 不残留 → 自愈。issue tracker 容忍此窗口。
      if (args.note != null) {
        issueRepo.appendContext({
          issueId: args.issueId,
          body: args.note,
          logsRef: null,
          appendedSessionId: callerSid,
        });
      }
      // 改 status（走 issueRepo.update 的 D15 resolved_at 状态机：进 resolved 写 now / 离开保留）。
      const updated = issueRepo.update(args.issueId, { status: args.status });
      if (!updated) {
        return err(
          `issue ${args.issueId} disappeared before its status was updated`,
          'Do not retry this issueId. Call report_issue to create a new issue if follow-up is still required.',
        );
      }
      updated.appendices = issueRepo.listAppendices(args.issueId);
      eventBus.emit('issue-changed', {
        kind: 'updated',
        issueId: updated.id,
        issue: updated,
        sourceSessionId: updated.sourceSessionId,
        ts: Date.now(),
      });
      return ok(updated satisfies UpdateIssueStatusResult);
    } catch (e) {
      return err(
        e instanceof Error ? e.message : String(e),
        'Do not retry automatically because the note or status may already have been written. Check the issue in the Agent Deck UI, then retry only if the requested change is absent.',
      );
    }
  },
);
