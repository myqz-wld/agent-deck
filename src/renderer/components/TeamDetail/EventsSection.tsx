import type { JSX } from 'react';
import type { AgentEvent } from '@shared/types';
import { useSessionStore } from '@renderer/stores/session-store';
import { Section, EmptyState } from './Header';
import { relativeTime } from './helpers';

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
                {e.kind}
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
 * 事件 payload 简单描述。完整 describe 在 activity-feed/describe.ts，但那里是 markdown / 多
 * 行 / tool-icon 全套，给 TeamDetail 单行展示太厚。这里只给一句话浓缩；超过 80 字符截断。
 */
function describeEventPayload(e: AgentEvent): string {
  if (!e.payload) return '';
  if (typeof e.payload === 'string') {
    return e.payload.length > 80 ? `${e.payload.slice(0, 80)}…` : e.payload;
  }
  // 常见 kind payload 提取
  const p = e.payload as Record<string, unknown>;
  if ('text' in p && typeof p.text === 'string') {
    return p.text.length > 80 ? `${p.text.slice(0, 80)}…` : p.text;
  }
  if ('toolName' in p && typeof p.toolName === 'string') {
    return p.toolName;
  }
  if ('summary' in p && typeof p.summary === 'string') {
    return p.summary.length > 80 ? `${p.summary.slice(0, 80)}…` : p.summary;
  }
  // fallback：JSON.stringify 头 60 字符
  try {
    const s = JSON.stringify(p);
    return s.length > 80 ? `${s.slice(0, 80)}…` : s;
  } catch {
    return '<unrenderable>';
  }
}
