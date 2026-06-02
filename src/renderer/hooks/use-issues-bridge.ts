import { useEffect } from 'react';
import { useIssuesStore } from '@renderer/stores/issues-store';

/**
 * 全局 issue 事件桥：常驻订阅主进程 'issue-changed' 事件 → issues-store。整个应用只挂一次
 * （App.tsx，与 session 的 useEventBridge 同款「always-on」模式）。
 *
 * 为何常驻、不放 IssuesPanel 组件内自订阅（修 bug：切到问题页状态不刷新）：
 * App 按 view 条件渲染 panel，IssuesPanel 切走即 unmount → 若订阅写在组件 useEffect 里会被
 * 一并拆除 → 期间（典型：MCP「起新会话解决」回写 status=in-progress / 解决会话 update_issue_status
 * 翻 resolved）的 issue-changed 事件全部丢失。切回时 IssuesPanel remount 虽按当前 filter 重拉
 * list，但 mergeIssuesFromList 是 keep-all merge：已掉出当前 filter 的 stale 行（如 open→resolved
 * 后「活跃」filter 重拉结果不含它）既不会被刷新也不会被移除 → store 里仍是旧 open → 列表继续
 * 显示过期状态。常驻订阅保证事件永不漏，store 始终最新，切到问题页即见最新状态。
 */
export function useIssuesBridge(): void {
  const upsertIssue = useIssuesStore((s) => s.upsertIssue);
  const removeIssue = useIssuesStore((s) => s.removeIssue);

  useEffect(() => {
    const off = window.api.onIssueChanged((e) => {
      if (e.kind === 'hardDeleted') {
        removeIssue(e.issueId);
      } else if (e.issue) {
        upsertIssue(e.issue);
      }
    });
    return off;
  }, [upsertIssue, removeIssue]);
}
