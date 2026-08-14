import { useEffect, useMemo, useState, type JSX } from 'react';
import type { TaskRecord } from '@shared/types';
import log from '@renderer/utils/logger';
import { relativeTime } from '../session-presentation';
import { safeErrorData } from '../activity-feed/viewers/safe-error-data';

interface Props {
  sessionId: string;
}

type TaskTab = 'unfinished' | 'completed';

const EMPTY: TaskRecord[] = [];
const logger = log.scope('renderer-session-tasks');
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

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let req = 0;
    let cachedCount = 0;
    setTasks(EMPTY);
    setLoaded(false);
    setError(null);

    const sync = (): void => {
      const cur = ++req;
      void window.api
        .listSessionTasks(sessionId)
        .then((res) => {
          if (disposed || cur !== req) return;
          cachedCount = res.tasks.length;
          setTasks(res.tasks);
          setLoaded(true);
          setError(null);
        })
        .catch((err: unknown) => {
          if (disposed || cur !== req) return;
          logger.warn('session tasks load failed', {
            action: cachedCount > 0 ? 'refresh-session-tasks' : 'list-session-tasks',
            agentId: null,
            sessionId,
            teamId: null,
            source: 'session-detail-tasks',
            count: cachedCount,
            ...safeErrorData(err),
          });
          setError(
            cachedCount > 0
              ? '刷新失败，当前显示上次结果。'
              : '读取任务失败，请稍后重试。',
          );
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

  return <TaskRecordsView tasks={tasks} loaded={loaded} error={error} />;
}

export function TaskRecordsView({
  tasks,
  loaded,
  error,
}: {
  tasks: readonly TaskRecord[];
  loaded: boolean;
  error: string | null;
}): JSX.Element {
  const [activeTab, setActiveTab] = useState<TaskTab>('unfinished');
  const { unfinished, completed } = useMemo(() => {
    const ordered = [...tasks].sort(compareTasks);
    return {
      unfinished: ordered.filter((task) => task.status !== 'completed'),
      completed: ordered.filter((task) => task.status === 'completed'),
    };
  }, [tasks]);
  const activeTasks = activeTab === 'unfinished' ? unfinished : completed;

  if (error && tasks.length === 0) {
    return <div className="px-2 py-3 text-[11px] leading-snug text-status-waiting/90">{error}</div>;
  }
  if (!loaded && tasks.length === 0) {
    return <div className="px-2 py-3 text-[11px] text-deck-muted">加载中…</div>;
  }
  if (tasks.length === 0) {
    return <div className="px-2 py-3 text-[11px] text-deck-muted">本会话暂无任务</div>;
  }

  return (
    <div className="flex flex-col gap-3">
      {error && (
        <div className="text-[10px] text-status-waiting/80">
          {error}
        </div>
      )}
      <div
        role="tablist"
        aria-label="任务状态"
        className="inline-flex w-fit rounded border border-deck-border/50 bg-white/[0.02] p-0.5"
      >
        <TaskTabButton
          active={activeTab === 'unfinished'}
          count={unfinished.length}
          label="未完成"
          onClick={() => setActiveTab('unfinished')}
        />
        <TaskTabButton
          active={activeTab === 'completed'}
          count={completed.length}
          label="已完成"
          onClick={() => setActiveTab('completed')}
        />
      </div>
      <TaskList
        emptyLabel={activeTab === 'unfinished' ? '暂无未完成任务' : '暂无已完成任务'}
        tasks={[...activeTasks]}
        muted={activeTab === 'completed'}
      />
    </div>
  );
}

function TaskTabButton({
  active,
  count,
  label,
  onClick,
}: {
  active: boolean;
  count: number;
  label: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={`rounded px-2 py-1 text-[10px] transition ${
        active
          ? 'bg-white/[0.08] text-deck-text'
          : 'text-deck-muted hover:bg-white/[0.04] hover:text-deck-text'
      }`}
      onClick={onClick}
    >
      {label} <span className="tabular-nums">{count}</span>
    </button>
  );
}

function TaskList({
  emptyLabel,
  tasks,
  muted,
}: {
  emptyLabel: string;
  tasks: TaskRecord[];
  muted: boolean;
}): JSX.Element {
  return (
    <section className="min-w-0">
      {tasks.length === 0 ? (
        <div className="rounded border border-deck-border/30 bg-white/[0.015] px-2 py-2 text-[11px] text-deck-muted/70">
          {emptyLabel}
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
        {task.labels.slice(0, 3).map((label, index) => (
          <span key={`${label}-${index}`} className="rounded bg-white/[0.05] px-1 py-px">
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
