import type { JSX } from 'react';
import type { AgentEvent } from '@shared/types';
import { readBackgroundTaskSnapshot, type BackgroundTaskStatus } from '@shared/background-task';
import { ActivityIcon } from '../activity-icon';
import { MarkdownText } from '../../MarkdownText';
import { formatToolDuration } from '../tool-status';

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
  const duration = formatToolDuration(task.durationMs);
  return (
    <li className="min-w-0 rounded-md border border-deck-border/40 bg-white/[0.015] p-2 text-[11px]">
      <div className="flex min-w-0 items-center gap-1.5">
        <ActivityIcon kind={task.status === 'failed' ? 'error'
          : task.status === 'completed' ? 'success' : 'task'} />
        <span className={task.status === 'failed' ? 'text-status-error' : 'text-deck-text'}>
          {label} · {status}
        </span>
        <span className="ml-auto text-[9px] tabular-nums text-deck-muted/60">
          {new Date(event.ts).toLocaleTimeString('zh-CN', { hour12: false })}
        </span>
      </div>
      {task.description && <p className="mt-1 break-words text-deck-text">{task.description}</p>}
      {task.summary && <div className="mt-1 max-h-64 overflow-auto text-deck-muted">
        <MarkdownText text={task.summary} />
      </div>}
      {task.error && <pre className="mt-1 whitespace-pre-wrap text-status-error">{task.error}</pre>}
      <div className="mt-1 flex flex-wrap gap-x-3 text-[10px] text-deck-muted">
        {duration && <span>用时 {duration}</span>}
        {task.toolUses !== undefined && <span>工具调用 {task.toolUses} 次</span>}
        {task.totalTokens !== undefined && <span>{task.totalTokens.toLocaleString()} tokens</span>}
        {task.lastToolName && <span>最近工具：{task.lastToolName}</span>}
      </div>
      <details className="mt-1 text-[10px] text-deck-muted">
        <summary className="cursor-pointer">任务详情</summary>
        <div className="break-all">任务 ID：{task.taskId}</div>
        {task.outputFile && <div className="break-all">输出文件：{task.outputFile}</div>}
      </details>
    </li>
  );
}
