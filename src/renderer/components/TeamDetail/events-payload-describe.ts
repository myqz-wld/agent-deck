/**
 * EventsSection 的 payload 描述纯逻辑抽离成独立 .ts 模块，便于 node 环境 vitest 单测
 * （不拉 React / useSessionStore）。范式同 session-list-tree.ts。
 *
 * R4（reviewer-codex MED-1）：不再 JSON.stringify 直显字段名给用户，按 kind 给用户向摘要 +
 * 未知 kind 兜底「无更多详情」。REVIEW_107 LOW：补 truthy 非 string 原始值 payload 守门
 * （`'in'` 对原始值抛 TypeError，TeamDetail 无 local ErrorBoundary → 整 app 崩）。
 */
import type { AgentEvent } from '@shared/types';
import {
  describeToolInput,
  translateSessionEndReason,
} from '@renderer/components/activity-feed/describe';

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
  // 常见字段优先级:text > summary > 按 kind 取主字段
  const p = e.payload as Record<string, unknown>;
  if ('text' in p && typeof p.text === 'string' && p.text.trim()) {
    return p.text.length > 80 ? `${p.text.slice(0, 80)}…` : p.text;
  }
  if ('summary' in p && typeof p.summary === 'string') {
    return p.summary.length > 80 ? `${p.summary.slice(0, 80)}…` : p.summary;
  }
  // 按 kind 取主字段(对照 src/shared/types/agent.ts AgentEventKind union)
  switch (e.kind) {
    case 'session-start':
      return typeof p.cwd === 'string' && p.cwd.trim() ? truncate80(p.cwd.trim()) : '会话已开始';
    case 'session-end':
      return typeof p.reason === 'string' ? translateSessionEndReason(p.reason) : '会话已结束';
    case 'tool-use-start':
    case 'tool-use-end': {
      const toolName = typeof p.toolName === 'string' ? p.toolName : '工具';
      const detail = describeToolInput(toolName, p.toolInput);
      const status = e.kind === 'tool-use-end' ? toolStatusLabel(p.status) : '';
      const parts = [toolName, detail, status].filter(Boolean);
      return truncate80(parts.join(' · '));
    }
    case 'file-changed':
      return typeof p.filePath === 'string' && p.filePath.trim()
        ? truncate80(p.filePath.trim())
        : '文件已变更';
    case 'thinking':
      return 'No reasoning summary for this turn';
    case 'team-task-created':
    case 'team-task-completed': {
      const desc = typeof p.description === 'string' ? p.description : '';
      const team = typeof p.teamName === 'string' ? p.teamName : '';
      const assigned = typeof p.teammateName === 'string' ? p.teammateName : '';
      const parts = [desc, assigned && `→ ${assigned}`, team && `@ ${team}`].filter(Boolean);
      if (parts.length > 0) return truncate80(parts.join(' '));
      return e.kind === 'team-task-created' ? '任务已创建' : '任务已完成';
    }
    case 'team-teammate-idle': {
      const teammate = typeof p.teammateName === 'string' ? p.teammateName : '';
      const reason = typeof p.reason === 'string' ? p.reason : '';
      return [teammate, reason].filter(Boolean).join(' · ') || '协作者空闲';
    }
    case 'waiting-for-user':
      return describeWaitingPayload(p);
    default:
      return typeof p.toolName === 'string' ? truncate80(p.toolName) : '无更多详情';
  }
}

function describeWaitingPayload(p: Record<string, unknown>): string {
  const type = typeof p.type === 'string' ? p.type : '';
  if (type === 'permission-request') {
    const toolName = typeof p.toolName === 'string' ? p.toolName : '工具';
    const detail = describeToolInput(toolName, p.toolInput);
    return truncate80(detail ? `${toolName} · ${detail}` : toolName);
  }
  if (type === 'ask-user-question') {
    const questions = Array.isArray(p.questions) ? p.questions : [];
    const first = questions.find((q): q is { question: string } => {
      return (
        q !== null &&
        typeof q === 'object' &&
        typeof (q as { question?: unknown }).question === 'string'
      );
    });
    return first ? truncate80(first.question) : '等待回答问题';
  }
  if (type === 'exit-plan-mode') {
    const plan = typeof p.plan === 'string' ? p.plan.trim() : '';
    const firstLine = plan.split('\n').find((line) => line.trim())?.trim();
    return firstLine ? truncate80(firstLine) : '等待批准计划';
  }
  if (type === 'permission-cancelled') return '权限请求已取消';
  if (type === 'ask-question-cancelled') return '提问已取消';
  if (type === 'exit-plan-cancelled') return '计划批准请求已取消';
  if (typeof p.message === 'string') return truncate80(p.message);
  return '等待响应';
}

function toolStatusLabel(status: unknown): string {
  if (status === 'failed') return '失败';
  if (status === 'cancelled') return '已取消';
  return '';
}
