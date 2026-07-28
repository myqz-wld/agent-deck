import { useMemo, type JSX } from 'react';
import type { TaskRecord } from '@shared/types';
import {
  ExpandableContent,
  type DiagnosticContentPayload,
} from '@renderer/components/expandable-content';

export function TaskDetailViewer({
  task,
  sessionId,
}: {
  task: TaskRecord;
  sessionId: string;
}): JSX.Element {
  const payload = useMemo<DiagnosticContentPayload>(() => ({
    kind: 'diagnostic',
    text: task.description ?? '',
    severity: task.status === 'blocked' ? 'warning' : 'info',
    metadata: {
      subject: task.subject,
      status: task.status,
      activeForm: task.activeForm,
      priority: task.priority,
      labels: task.labels,
      blocks: task.blocks,
      blockedBy: task.blockedBy,
      updatedAt: task.updatedAt,
    },
  }), [task]);

  return (
    <ExpandableContent<DiagnosticContentPayload>
      identity={{
        sessionId,
        kind: 'payload',
        payloadId: `task-${task.id}`,
        revision: task.updatedAt,
      }}
      payload={payload}
      title="任务详情"
      triggerLabel={`展开任务详情：${task.subject}`}
    >
      <TaskDetails task={task} />
    </ExpandableContent>
  );
}

function TaskDetails({ task }: { task: TaskRecord }): JSX.Element {
  return (
    <dl className="grid min-w-0 grid-cols-1 gap-2 text-sm sm:grid-cols-[max-content_1fr] sm:gap-x-4">
      <dt className="text-deck-muted">主题</dt>
      <dd className="min-w-0 break-words font-medium">{task.subject}</dd>
      <dt className="text-deck-muted">说明</dt>
      <dd className="min-w-0 whitespace-pre-wrap break-words">
        {task.description || '（无说明）'}
      </dd>
      <dt className="text-deck-muted">状态</dt>
      <dd>{statusLabel(task.status)}</dd>
      <dt className="text-deck-muted">当前进度</dt>
      <dd className="min-w-0 break-words">{task.activeForm || '（未提供）'}</dd>
      <dt className="text-deck-muted">优先级</dt>
      <dd>{task.priority}</dd>
      <dt className="text-deck-muted">全部标签</dt>
      <dd>
        {task.labels.length > 0 ? (
          <ul className="flex flex-wrap gap-1" aria-label="任务全部标签">
            {task.labels.map((label, index) => (
              <li key={`${label}-${index}`} className="rounded bg-white/[0.06] px-2 py-1">
                {label}
              </li>
            ))}
          </ul>
        ) : '（无标签）'}
      </dd>
    </dl>
  );
}

function statusLabel(status: TaskRecord['status']): string {
  switch (status) {
    case 'active': return '进行中';
    case 'pending': return '待处理';
    case 'blocked': return '已阻塞';
    case 'completed': return '已完成';
    case 'abandoned': return '已放弃';
  }
}
