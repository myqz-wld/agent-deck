import type { JSX } from 'react';
import type { TaskRecord } from '@shared/types';
import { Section, EmptyState } from './Header';
import { relativeTime } from './helpers';
import {
  AlertTriangleIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  BanIcon,
  CircleCheckIcon,
  ClockIcon,
  InfoIcon,
  WrenchIcon,
} from '../icons';
import { TaskDetailViewer } from './viewers/TaskDetailViewer';

/** Team tasks in workflow order. Every row exposes the complete task record in its detail viewer. */
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
      className="relative rounded border border-deck-border/40 bg-white/[0.02] py-1 pl-2 pr-12 text-[11px]"
      title={task.description ?? task.subject}
    >
      <TaskDetailViewer task={task} sessionId={task.ownerSessionId} />
      <div className="flex min-h-11 items-center justify-between gap-2">
        <div className="flex min-w-0 items-baseline gap-1.5">
          <span className="shrink-0">{statusIcon(task.status)}</span>
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
              <WrenchIcon className="mr-0.5 inline h-3 w-3" />{task.activeForm}
            </span>
          )}
          {task.priority !== 5 && (
            <span title={`优先级 ${task.priority}`}>
              {task.priority < 5 ? <ArrowUpIcon className="mr-0.5 inline h-3 w-3" /> : <ArrowDownIcon className="mr-0.5 inline h-3 w-3" />}优先级 {task.priority}
            </span>
          )}
        </div>
      )}
    </li>
  );
}

function statusIcon(status: TaskRecord['status']): JSX.Element {
  const className = 'h-3.5 w-3.5';
  switch (status) {
    case 'pending':
      return <ClockIcon className={className} label="待处理" />;
    case 'active':
      return <WrenchIcon className={className} label="进行中" />;
    case 'completed':
      return <CircleCheckIcon className={className} label="已完成" />;
    case 'blocked':
      return <AlertTriangleIcon className={className} label="已阻塞" />;
    case 'abandoned':
      return <BanIcon className={className} label="已放弃" />;
    default:
      return <InfoIcon className={className} label="未知状态" />;
  }
}
