import type { JSX } from 'react';
import type { TaskRecord } from '@shared/types';
import { Section, EmptyState } from './Header';
import { relativeTime } from './helpers';

/**
 * plan team-cohesion-fix-20260513 Phase C：team 内 task 列表 section。
 *
 * 数据来自 IPC `agent-deck-team:get-full` 的 `tasks` 字段（taskRepo.list({teamId}) — task 表
 * 自己的 team_id 列）。展示：
 * - 状态 emoji + subject
 * - activeForm（"present continuous form shown during execution" 如 "Running tests"，
 *   sdk-task-manager-spec §3，是状态描述不是 sessionId — 不要 lookup sessions Map）
 * - priority（5 是默认；非 5 显示 ⬆/⬇ + 数字）
 * - 相对更新时间（updatedAt 是 ISO 字符串，需 Date.parse 转 ms）
 *
 * 按状态分组排序（active / pending / blocked / completed / abandoned）。
 */
interface Props {
  tasks: TaskRecord[];
}

export function TasksSection({ tasks }: Props): JSX.Element {
  if (tasks.length === 0) {
    return (
      <Section title="任务" count={0}>
        <EmptyState>团队内暂无任务</EmptyState>
      </Section>
    );
  }

  const byStatus = new Map<TaskRecord['status'], TaskRecord[]>();
  for (const t of tasks) {
    const arr = byStatus.get(t.status) ?? [];
    arr.push(t);
    byStatus.set(t.status, arr);
  }
  const ordered: TaskRecord['status'][] = ['active', 'pending', 'blocked', 'completed', 'abandoned'];
  const orderedTasks = ordered.flatMap((s) => byStatus.get(s) ?? []);

  return (
    <Section title="任务" count={tasks.length}>
      <ol className="flex flex-col gap-1">
        {orderedTasks.map((t) => (
          <TaskRow key={t.id} task={t} />
        ))}
      </ol>
    </Section>
  );
}

function TaskRow({ task }: { task: TaskRecord }): JSX.Element {
  return (
    <li
      className="rounded border border-deck-border/40 bg-white/[0.02] px-2 py-1 text-[11px]"
      title={task.description ?? task.subject}
    >
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex min-w-0 items-baseline gap-1.5">
          <span className="shrink-0">{statusEmoji(task.status)}</span>
          <strong className="truncate text-deck-text">{task.subject}</strong>
        </div>
        <span className="shrink-0 text-[9px] text-deck-muted/60 tabular-nums">
          {relativeTime(Date.parse(task.updatedAt))}
        </span>
      </div>
      {(task.activeForm || task.priority !== 5) && (
        <div className="mt-0.5 flex items-center gap-2 text-[9px] text-deck-muted">
          {task.activeForm && (
            <span title="当前进度描述">
              🔧 {task.activeForm}
            </span>
          )}
          {task.priority !== 5 && (
            <span title={`优先级 ${task.priority}`}>
              {task.priority < 5 ? '⬆' : '⬇'} P{task.priority}
            </span>
          )}
        </div>
      )}
    </li>
  );
}

function statusEmoji(status: TaskRecord['status']): string {
  switch (status) {
    case 'pending':
      return '⏳';
    case 'active':
      return '🔧';
    case 'completed':
      return '✅';
    case 'blocked':
      return '🚧';
    case 'abandoned':
      return '⊘';
    default:
      return '❓';
  }
}
