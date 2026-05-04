import { useCallback, useEffect, useState, type JSX } from 'react';
import type { TaskRecord, TaskStatus } from '@shared/types';
import { Section } from './chrome';

/**
 * TeamDetail「结构化 tasks (mcp)」section（CHANGELOG_<X>）。
 *
 * 渲染当前 team 的 SQLite tasks 表（mcp__tasks__* 工具写入）。
 * 与既有「共享 task list」section（~/.claude/tasks/<name>/<file>.md，CLI TaskCreate /
 * TodoWrite 写的 markdown）**互补**：两套并行存在不互相同步——markdown 是 Claude 自然语
 * 言任务，本 section 是结构化 status / priority / labels / blocks 关系。
 *
 * 数据来源：IpcInvoke.TaskListByTeam（限 200 条）。订阅 IpcEvent.TaskChanged 后整体重拉
 * （200 条 SQLite 微秒级，事件只是触发器；与既有 onAgentEvent 同款不 debounce）。
 *
 * 只读视图，不做 inline 编辑；用户要改 task 仍走 mcp 工具调用 / 让 lead 帮忙改。
 */
const STATUS_CHIP_CLASS: Record<TaskStatus, string> = {
  pending: 'bg-deck-muted/15 text-deck-muted',
  active: 'bg-status-working/15 text-status-working',
  completed: 'bg-status-working/25 text-status-working',
  blocked: 'bg-status-waiting/20 text-status-waiting',
  abandoned: 'bg-status-error/20 text-status-error',
};

const STATUS_LABEL: Record<TaskStatus, string> = {
  pending: '待办',
  active: '进行中',
  completed: '已完成',
  blocked: '阻塞',
  abandoned: '已放弃',
};

export function McpTasksSection({ name }: { name: string }): JSX.Element {
  const [mcpTasks, setMcpTasks] = useState<TaskRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async (): Promise<void> => {
    try {
      const r = await window.api.listTeamTasks(name);
      setMcpTasks(r.tasks);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [name]);

  useEffect(() => {
    void refetch();
    // 订阅 task-changed：仅本 team 的事件触发重拉。teamName 在 created/updated/deleted
    // 三种 kind 下都被 emit 时显式带上（task-repo 写入路径都先校验过 teamName，deleted
    // 时取自被删 task 原 teamName，see TaskChangedEvent JSDoc）。
    const off = window.api.onTaskChanged((e) => {
      if (e.teamName === name) {
        void refetch();
      }
    });
    return off;
  }, [name, refetch]);

  return (
    <Section
      title={`结构化 tasks (${mcpTasks.length})`}
      right={
        <span className="rounded bg-white/8 px-1 py-0.5 font-mono text-[9px] text-deck-muted">
          mcp__tasks__*
        </span>
      }
    >
      {error && (
        <div className="mb-1 rounded bg-status-error/10 px-2 py-1 text-[10px] text-status-error">
          拉结构化 tasks 失败：{error}
        </div>
      )}
      {mcpTasks.length === 0 ? (
        <div className="rounded border border-deck-border/40 bg-white/[0.02] px-2 py-2 text-[10px] text-deck-muted/70">
          该 team 还没有结构化 task。Lead / teammate 可调
          <code className="mx-1 rounded bg-white/5 px-1">mcp__tasks__task_create</code>
          创建。
        </div>
      ) : (
        <ul className="flex flex-col gap-1">
          {mcpTasks.map((t) => (
            <li
              key={t.id}
              className="rounded border border-deck-border/40 bg-white/[0.02] px-2 py-1.5 text-[11px]"
            >
              <div className="flex items-start gap-1.5">
                <span
                  className={`shrink-0 rounded px-1 py-0.5 text-[9px] ${STATUS_CHIP_CLASS[t.status]}`}
                  title={t.status}
                >
                  {STATUS_LABEL[t.status]}
                </span>
                <span className="flex-1 font-medium leading-tight">{t.subject}</span>
                <span
                  className="shrink-0 rounded bg-white/8 px-1 py-0.5 font-mono text-[9px] text-deck-muted/80"
                  title="priority 0-10"
                >
                  P{t.priority}
                </span>
              </div>
              {(t.activeForm || t.labels.length > 0) && (
                <div className="mt-1 flex flex-wrap gap-1 text-[9px]">
                  {t.activeForm && (
                    <span
                      className="rounded bg-status-working/10 px-1 py-0.5 text-status-working"
                      title="active form / 当前认领方"
                    >
                      🤖 {t.activeForm}
                    </span>
                  )}
                  {t.labels.map((l) => (
                    <span key={l} className="rounded bg-white/8 px-1 py-0.5 text-deck-muted">
                      {l}
                    </span>
                  ))}
                </div>
              )}
              {t.description && (
                <div className="mt-1 line-clamp-2 text-[10px] leading-snug text-deck-muted/80">
                  {t.description}
                </div>
              )}
              <div className="mt-1 flex items-center justify-between font-mono text-[9px] text-deck-muted/50">
                <span title={t.id}>id: {t.id.slice(0, 8)}…</span>
                <span title={t.updatedAt}>
                  更新于 {new Date(t.updatedAt).toLocaleTimeString('zh-CN', { hour12: false })}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
