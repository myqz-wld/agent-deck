import { useEffect, useMemo, useState, type JSX } from 'react';
import type { TaskRecord } from '@shared/types';
import { relativeTime } from '../TeamDetail/helpers';

interface Props {
  sessionId: string;
}

const EMPTY: TaskRecord[] = [];
const STATUS_ORDER: TaskRecord['status'][] = [
  'active',
  'pending',
  'blocked',
  'abandoned',
  'completed',
];

export function TasksPanel({ sessionId }: Props): JSX.Element {
  const [tasks, setTasks] = useState<TaskRecord[]>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCompleted, setShowCompleted] = useState(false);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let req = 0;

    const sync = (): void => {
      const cur = ++req;
      void window.api
        .listSessionTasks(sessionId)
        .then((res) => {
          if (disposed || cur !== req) return;
          setTasks(res.tasks);
          setLoaded(true);
          setError(null);
        })
        .catch((err: unknown) => {
          if (disposed) return;
          const message = err instanceof Error ? err.message : String(err);
          setError(`加载任务失败：${message}`);
          setLoaded(true);
        });
    };

    sync();
    const off = window.api.onTaskChanged(() => {
      if (timer != null) return;
      timer = setTimeout(() => {
        timer = null;
        sync();
      }, 200);
    });

    return () => {
      disposed = true;
      if (timer != null) clearTimeout(timer);
      off();
    };
  }, [sessionId]);

  const { unfinished, completed } = useMemo(() => {
    const ordered = [...tasks].sort(compareTasks);
    return {
      unfinished: ordered.filter((task) => task.status !== 'completed'),
      completed: ordered.filter((task) => task.status === 'completed'),
    };
  }, [tasks]);

  if (!loaded && tasks.length === 0) {
    return <div className="px-2 py-3 text-[11px] text-deck-muted">加载中…</div>;
  }
  if (error && tasks.length === 0) {
    return <div className="px-2 py-3 text-[11px] leading-snug text-status-waiting/90">{error}</div>;
  }
  if (tasks.length === 0) {
    return <div className="px-2 py-3 text-[11px] text-deck-muted">本会话暂无任务</div>;
  }

  return (
    <div className="flex flex-col gap-3">
      {error && (
        <div className="text-[10px] text-status-waiting/80">
          刷新任务失败（显示的是上次结果）：{error}
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] text-deck-muted">
          未完成 <span className="tabular-nums">{unfinished.length}</span>
        </div>
        <label className="flex shrink-0 items-center gap-1 text-[10px] text-deck-muted">
          <input
            type="checkbox"
            checked={showCompleted}
            onChange={(e) => setShowCompleted(e.target.checked)}
          />
          显示已完成 <span className="tabular-nums">{completed.length}</span>
        </label>
      </div>
      <TaskGroup title="未完成" tasks={unfinished} />
      {showCompleted && <TaskGroup title="已完成" tasks={completed} muted />}
    </div>
  );
}

function TaskGroup({
  title,
  tasks,
  muted = false,
}: {
  title: string;
  tasks: TaskRecord[];
  muted?: boolean;
}): JSX.Element {
  return (
    <section className="min-w-0">
      <div className="mb-1 flex items-center gap-1.5 text-[10px] font-medium text-deck-muted">
        <span>{title}</span>
        <span className="rounded bg-white/[0.06] px-1 py-px text-[9px] tabular-nums">
          {tasks.length}
        </span>
      </div>
      {tasks.length === 0 ? (
        <div className="rounded border border-deck-border/30 bg-white/[0.015] px-2 py-2 text-[11px] text-deck-muted/70">
          暂无
        </div>
      ) : (
        <ol className="flex flex-col gap-1.5">
          {tasks.map((task) => (
            <TaskRow key={task.id} task={task} muted={muted} />
          ))}
        </ol>
      )}
    </section>
  );
}

function TaskRow({ task, muted }: { task: TaskRecord; muted: boolean }): JSX.Element {
  const status = statusMeta(task.status);
  return (
    <li
      className={`rounded border border-deck-border/40 bg-white/[0.02] px-2 py-1.5 text-[11px] ${
        muted ? 'opacity-75' : ''
      }`}
      title={task.description ?? task.subject}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${status.dotClass}`} />
            <strong className="truncate text-deck-text">{task.subject}</strong>
          </div>
          {(task.activeForm || task.description) && (
            <div className="mt-0.5 truncate text-[10px] text-deck-muted">
              {task.activeForm ?? task.description}
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-0.5 text-[9px] text-deck-muted/70">
          <span className={`rounded px-1 py-px ${status.badgeClass}`}>{status.label}</span>
          <span className="tabular-nums">{relativeTime(Date.parse(task.updatedAt))}</span>
        </div>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[9px] text-deck-muted/65">
        <span>{task.teamId ? '团队任务' : '个人任务'}</span>
        {task.priority !== 5 && <span className="tabular-nums">P{task.priority}</span>}
        {task.labels.slice(0, 3).map((label) => (
          <span key={label} className="rounded bg-white/[0.05] px-1 py-px">
            {label}
          </span>
        ))}
      </div>
    </li>
  );
}

function compareTasks(a: TaskRecord, b: TaskRecord): number {
  const statusDelta = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
  if (statusDelta !== 0) return statusDelta;
  return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
}

function statusMeta(status: TaskRecord['status']): {
  label: string;
  dotClass: string;
  badgeClass: string;
} {
  switch (status) {
    case 'active':
      return {
        label: '进行中',
        dotClass: 'bg-status-working',
        badgeClass: 'bg-status-working/15 text-status-working',
      };
    case 'blocked':
      return {
        label: '阻塞',
        dotClass: 'bg-status-waiting',
        badgeClass: 'bg-status-waiting/15 text-status-waiting',
      };
    case 'completed':
      return {
        label: '已完成',
        dotClass: 'bg-emerald-300/80',
        badgeClass: 'bg-emerald-300/10 text-emerald-200',
      };
    case 'abandoned':
      return {
        label: '已放弃',
        dotClass: 'bg-deck-muted/70',
        badgeClass: 'bg-white/[0.05] text-deck-muted',
      };
    case 'pending':
    default:
      return {
        label: '待处理',
        dotClass: 'bg-deck-muted/80',
        badgeClass: 'bg-white/[0.05] text-deck-muted',
      };
  }
}
