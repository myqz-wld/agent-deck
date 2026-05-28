import type { JSX } from 'react';
import type { AgentEvent } from '@shared/types';
import { useSessionStore } from '@renderer/stores/session-store';
import { Section, EmptyState } from './Header';
import { relativeTime, eventKindLabel } from './helpers';
import { translateSessionEndReason } from '@renderer/components/activity-feed/describe';

/**
 * plan team-cohesion-fix-20260513 Phase C：team 内成员事件流 section（聚合 50 条 ts DESC）。
 *
 * 数据来自 IPC `agent-deck-team:get-full` 的 `recentEvents` 字段（event-repo.findTeamEvents
 * 已改用 universal team backend 列 sessionIds 后查 events.session_id IN (...)，不再 JOIN 已 drop
 * 的 sessions.team_name 列）。
 *
 * 不复用 ActivityFeed 的完整渲染（那个支持 PermissionRow / AskRow / ExitPlanRow 等
 * 交互组件），TeamDetail 的 events section 是只读时间线 —— 每条一行：相对时间 + sender label
 * + kind + payload 浓缩描述（payload 长则截断）。
 */
interface Props {
  events: (AgentEvent & { id: number })[];
}

export function EventsSection({ events }: Props): JSX.Element {
  const sessions = useSessionStore((s) => s.sessions);

  if (events.length === 0) {
    return (
      <Section title="近期事件" count={0}>
        <EmptyState>团队内暂无事件</EmptyState>
      </Section>
    );
  }

  return (
    <Section title="近期事件" count={events.length}>
      <ol className="flex flex-col gap-0.5">
        {events.map((e) => {
          const sess = sessions.get(e.sessionId);
          const senderLabel = sess?.title ?? e.sessionId.slice(0, 8);
          return (
            <li
              key={e.id}
              className="flex items-baseline gap-1.5 rounded border border-deck-border/30 bg-white/[0.015] px-2 py-0.5 text-[10px]"
            >
              <span className="shrink-0 text-deck-muted/60 tabular-nums">
                {relativeTime(e.ts)}
              </span>
              <span className="shrink-0 truncate text-deck-text/70" title={senderLabel}>
                {senderLabel}
              </span>
              <span className="shrink-0 rounded bg-white/5 px-1 py-0 text-[9px] text-deck-muted">
                {eventKindLabel(e.kind)}
              </span>
              <span
                className="ml-1 truncate text-deck-text/85"
                title={describeEventPayload(e)}
              >
                {describeEventPayload(e)}
              </span>
            </li>
          );
        })}
      </ol>
    </Section>
  );
}

/**
 * 事件 payload 简单描述。完整 describe 在 activity-feed/describe.ts(markdown / 多行 /
 * tool-icon 全套);本节只给一句话浓缩。
 *
 * R4 修(reviewer-codex MED-1):JSON.stringify 直显字段名给用户(`{"cwd":...}` 等)
 * → 按 kind 给用户向摘要,常见事件家族枚举翻译;未知 kind 兜底「无更多详情」(不再
 * 暴露 raw JSON)。复用同一份枚举翻译思路与 activity-feed/describe.ts 同源。
 */
function describeEventPayload(e: AgentEvent): string {
  if (!e.payload) return '';
  if (typeof e.payload === 'string') {
    return e.payload.length > 80 ? `${e.payload.slice(0, 80)}…` : e.payload;
  }
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

function truncate80(s: string): string {
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}
