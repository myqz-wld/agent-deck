import type { JSX } from 'react';
import type { AgentEvent } from '@shared/types';
import { readBackgroundTaskSnapshot, type BackgroundTaskStatus } from '@shared/background-task';
import { ActivityIcon } from '../activity-icon';
import { MarkdownText } from '../../MarkdownText';
import { formatStatusDuration } from '../status-format';
import { StatusRow } from './status-row';

const STATUS: Record<BackgroundTaskStatus, string> = {
  pending: '等待中', running: '运行中', paused: '已暂停', completed: '已完成',
  failed: '失败', stopped: '已停止', unknown: '状态待确认',
};

export function BackgroundTaskRow({ event }: { event: AgentEvent }): JSX.Element | null {
  const task = readBackgroundTaskSnapshot(event.payload);
  if (!task) return null;
  const label = task.taskType === 'local_bash' ? '后台命令'
    : task.taskType === 'local_agent' ? '后台子代理' : '后台任务';
  const status = STATUS[task.status] ?? '状态待确认';
  const duration = task.durationMs === undefined ? undefined : formatStatusDuration(task.durationMs);
  return (
    <StatusRow title={`${label} · ${status}`} label={`${label} · ${status}${task.description ? ` · ${task.description}` : ''}`}
      tags={task.description ? <span className="min-w-0 max-w-[60%] truncate text-[10px] text-deck-muted/70">{task.description}</span> : undefined}
      ts={event.ts} tone={task.status === 'failed' ? 'error' : 'neutral'}
      icon={<ActivityIcon kind={task.status === 'failed' ? 'error'
        : task.status === 'completed' ? 'success' : 'task'} />}
      metrics={<>
        {duration && <span>用时 {duration}</span>}
        {task.toolUses !== undefined && <span>工具调用 {task.toolUses} 次</span>}
      </>}>
      {task.description && <p className="mt-1 break-words text-deck-text">{task.description}</p>}
      {task.summary && <div className="mt-1 max-h-64 overflow-auto text-deck-muted">
        <MarkdownText text={task.summary} />
      </div>}
      {task.error && <pre className="mt-1 whitespace-pre-wrap text-status-error">{task.error}</pre>}
      <div className="mt-1 flex flex-wrap gap-x-3 text-[10px] text-deck-muted">
        {task.totalTokens !== undefined && <span>{task.totalTokens.toLocaleString('en-US')} Token</span>}
        {task.lastToolName && <span>最近工具：{task.lastToolName}</span>}
      </div>
      <div className="mt-2 text-[10px] text-deck-muted/70">
        <div className="break-all">任务 ID：{task.taskId}</div>
        {task.outputFile && <div className="break-all">输出文件：{task.outputFile}</div>}
      </div>
    </StatusRow>
  );
}
