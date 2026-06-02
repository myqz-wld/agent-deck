/**
 * EventsSection 的 payload 描述纯逻辑抽离成独立 .ts 模块，便于 node 环境 vitest 单测
 * （不拉 React / useSessionStore）。范式同 session-list-tree.ts。
 *
 * R4（reviewer-codex MED-1）：不再 JSON.stringify 直显字段名给用户，按 kind 给用户向摘要 +
 * 未知 kind 兜底「无更多详情」。REVIEW_107 LOW：补 truthy 非 string 原始值 payload 守门
 * （`'in'` 对原始值抛 TypeError，TeamDetail 无 local ErrorBoundary → 整 app 崩）。
 */
import type { AgentEvent } from '@shared/types';
import { translateSessionEndReason } from '@renderer/components/activity-feed/describe';

export function truncate80(s: string): string {
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

/**
 * 事件 payload 简单描述。完整 describe 在 activity-feed/describe.ts(markdown / 多行 /
 * tool-icon 全套);本节只给一句话浓缩。
 */
export function describeEventPayload(e: AgentEvent): string {
  if (!e.payload) return '';
  if (typeof e.payload === 'string') {
    return e.payload.length > 80 ? `${e.payload.slice(0, 80)}…` : e.payload;
  }
  // REVIEW_107 LOW（防御护栏）：payload 类型是 `unknown`，DB rowToEvent 走 `JSON.parse(...) as
  // unknown` 不收窄 → 类型上 truthy 非 string 原始值（number/boolean）可达，后续 `'text' in p`
  // 对原始值抛 TypeError。当前无 emitter 产此类 payload（SDK/hook 两通道 emit 全是 object），
  // 实际不可达；但 TeamDetail 无 local ErrorBoundary，一旦抛错冒泡到 RootErrorBoundary = 整
  // app 持久错误页 → blast radius 大，加一行 object 守门兜底。
  if (typeof e.payload !== 'object') return '无更多详情';
  // 常见字段优先级:text > summary > toolName > 按 kind 取主字段
  const p = e.payload as Record<string, unknown>;
  if ('text' in p && typeof p.text === 'string') {
    return p.text.length > 80 ? `${p.text.slice(0, 80)}…` : p.text;
  }
  if ('summary' in p && typeof p.summary === 'string') {
    return p.summary.length > 80 ? `${p.summary.slice(0, 80)}…` : p.summary;
  }
  if ('toolName' in p && typeof p.toolName === 'string') {
    return p.toolName;
  }
  // 按 kind 取主字段(对照 src/shared/types/agent.ts AgentEventKind union)
  switch (e.kind) {
    case 'session-start':
      return typeof p.cwd === 'string' ? truncate80(p.cwd) : '';
    case 'session-end':
      return typeof p.reason === 'string' ? translateSessionEndReason(p.reason) : '';
    case 'file-changed':
      return typeof p.filePath === 'string' ? truncate80(p.filePath) : '';
    case 'team-task-created':
    case 'team-task-completed': {
      const desc = typeof p.description === 'string' ? p.description : '';
      const team = typeof p.teamName === 'string' ? p.teamName : '';
      const assigned = typeof p.teammateName === 'string' ? p.teammateName : '';
      const parts = [desc, assigned && `→ ${assigned}`, team && `@ ${team}`].filter(Boolean);
      return parts.length > 0 ? truncate80(parts.join(' ')) : '';
    }
    case 'team-teammate-idle': {
      const teammate = typeof p.teammateName === 'string' ? p.teammateName : '';
      const reason = typeof p.reason === 'string' ? p.reason : '';
      return [teammate, reason].filter(Boolean).join(' · ') || '';
    }
    case 'waiting-for-user':
      return typeof p.message === 'string' ? truncate80(p.message) : '';
    default:
      return '无更多详情';
  }
}
