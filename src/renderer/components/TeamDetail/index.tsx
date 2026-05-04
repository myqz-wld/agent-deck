import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type { AgentEvent, TeamSnapshot } from '@shared/types';
import { MarkdownText } from '../MarkdownText';
import { pickLeadSession } from './lead-session';
import { SendToTeammate } from './SendToTeammate';
import { ForceCleanupButton } from './ForceCleanupButton';
import { TeamEventRow } from './TeamEventRow';
import { McpTasksSection } from './McpTasksSection';
import { Header, Section, Stat } from './chrome';

/**
 * Agent Teams M2 — 单 team 详情面板。
 *
 * 三段：
 * - 顶部 header：team 名 + back 按钮 + 简要统计
 * - 成员段（来自 ~/.claude/teams/<name>/config.json 解析的 members 数组 + 应用 DB sessions）
 * - 共享 task list 段（来自 ~/.claude/tasks/<name>/<task-list>.md 文件原文，markdown 渲染）
 *
 * mount 时调 `subscribeTeam(name)` 注册 fs 监听，任意变化（config / task-list / unlinked）
 * 触发 `getTeam` 重拉。unmount 时调返回的 unsubscribe 闭包。
 *
 * **用户残留 cleanup 提示**：Claude Code 的 in-process backend cleanup 是**异步延迟**
 * 的（teammate shutdown_approved 后 config.members 由 CLI 异步移除，实测延迟可达
 * 几分钟）→ 首次 TeamDelete 调用可能因「members 仍含 active」拒绝；等几分钟重试
 * 通常能成功，或用户手动 rm 残留。M3 已加 `<ForceCleanupButton>` 兜底入口（见 §残留清理
 * Section + ForceCleanupButton.tsx），按钮调 forceCleanupTeam IPC + 主动 unset
 * sessions.team_name（teamCoordinator.unsetTeamFromAllSessions 30s dedup）。
 */
export function TeamDetail({
  name,
  onBack,
  onOpenSession,
}: {
  name: string;
  onBack: () => void;
  onOpenSession: (sessionId: string) => void;
}): JSX.Element {
  const [snap, setSnap] = useState<TeamSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // REVIEW_17 R1 / M3：useEffect deps 不能含 snap（refresh 改 snap → effect 重跑
  // → unsubscribe + 重 subscribe + onAgentEvent 重 register，每次 inbox 写入翻一次）。
  // 用 ref 让 onAgentEvent listener 拿最新 snap（避免 stale closure），deps 仅 [name, refresh]。
  const snapRef = useRef<TeamSnapshot | null>(null);
  useEffect(() => {
    snapRef.current = snap;
  }, [snap]);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const s = await window.api.getTeam(name);
      setSnap(s);
      setError(null);
    } catch (err) {
      setError(`拉 team 详情失败：${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [name]);

  useEffect(() => {
    void refresh();
    // 订阅 fs 变化：config.json / task-list / 整个 team 目录被删 → 重拉
    const unsubscribe = window.api.subscribeTeam(name, () => {
      void refresh();
    });
    // M3：监听 agent-event 流，team-* event 来时（task created/completed/teammate idle）刷新
    // —— hook-server 写 events 表后 emit AgentEvent，不会触发 fs watch，必须独立 listener。
    // listener 内通过 snapRef.current 读最新 snap（不依赖 deps，避免 stale closure
    // + 反复 sub/unsub）。
    const unsubscribeEvents = window.api.onAgentEvent((ev: AgentEvent) => {
      if (
        ev.kind === 'team-task-created' ||
        ev.kind === 'team-task-completed' ||
        ev.kind === 'team-teammate-idle'
      ) {
        // 不按 teamName 过滤——payload.teamName 可能缺失（schema 演进），
        // 简单按 sessionId 是否属于当前 team 的 sessions 判断；snap 还没拉到时全放行。
        const cur = snapRef.current;
        if (!cur || cur.sessions.some((s) => s.id === ev.sessionId)) {
          void refresh();
        }
      }
    });
    return () => {
      unsubscribe();
      unsubscribeEvents();
    };
  }, [name, refresh]);

  if (loading && !snap) {
    return (
      <div className="flex h-full flex-col">
        <Header name={name} onBack={onBack} />
        <div className="flex-1 py-6 text-center text-[11px] text-deck-muted">读取中…</div>
      </div>
    );
  }

  if (!snap) {
    return (
      <div className="flex h-full flex-col">
        <Header name={name} onBack={onBack} />
        <div className="flex-1 px-3 py-2 text-[11px] text-deck-muted">
          {error ?? '没有数据'}
        </div>
      </div>
    );
  }

  const members = snap.config?.members ?? [];
  const memberSessionIds = new Set(
    members.map((m) => m.sessionId).filter((sid): sid is string => typeof sid === 'string'),
  );

  return (
    <div className="flex h-full flex-col">
      <Header name={name} onBack={onBack} />
      {error && (
        <div className="mx-3 mt-2 rounded bg-status-waiting/10 px-2 py-1 text-[11px] text-status-waiting">
          {error}
        </div>
      )}
      <div className="flex-1 overflow-y-auto scrollbar-deck px-3 py-2">
        {/* 概要 */}
        <Section title="概要">
          <div className="grid grid-cols-2 gap-1.5 text-[11px]">
            <Stat label="成员数（来自 config.json）" value={String(members.length)} />
            <Stat label="应用内会话数" value={String(snap.sessions.length)} />
            <Stat
              label="config.json"
              value={snap.config ? '已加载' : '不存在 / 未建队'}
              ok={snap.config !== null}
            />
            <Stat
              label="shared task list"
              value={snap.taskListFile ? '已加载' : '不存在'}
              ok={snap.taskListFile !== null}
            />
          </div>
          {snap.config !== null && members.length === 0 && (
            <div className="mt-1.5 rounded bg-status-waiting/10 px-2 py-1 text-[10px] text-status-waiting/90">
              config.json 存在但 members 数组为空——可能 Claude cleanup 后还没清掉 fs 残留，
              或者 schema 变更没解出。可手动 <code className="rounded bg-white/10 px-1">rm -rf ~/.claude/teams/{name} ~/.claude/tasks/{name}</code> 清残留
              （M3 hook 接入后会加自动清理按钮）。
            </div>
          )}
        </Section>

        {/* 成员（来自 config.json） */}
        {members.length > 0 && (
          <Section title="成员（config.json）">
            <ul className="flex flex-col gap-1">
              {members.map((m) => (
                <li
                  key={m.name}
                  className="rounded border border-deck-border/40 bg-white/[0.02] px-2 py-1 text-[11px]"
                >
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium">{m.name}</span>
                    {m.agentType && (
                      <span className="rounded bg-white/8 px-1 py-0.5 font-mono text-[9px] text-deck-muted">
                        {m.agentType}
                      </span>
                    )}
                    {m.sessionId && (
                      <span
                        className="ml-auto truncate font-mono text-[9px] text-deck-muted/60"
                        title={m.sessionId}
                      >
                        sid: {m.sessionId.slice(0, 8)}…
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {/* 应用内会话（DB sessions where team_name = name） */}
        {snap.sessions.length > 0 && (
          <Section title={`应用内会话 (${snap.sessions.length})`}>
            <ul className="flex flex-col gap-1">
              {snap.sessions.map((s) => {
                const isMember = memberSessionIds.has(s.id);
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => onOpenSession(s.id)}
                      className="flex w-full items-center gap-1.5 rounded border border-deck-border/40 bg-white/[0.02] px-2 py-1 text-left text-[11px] hover:bg-white/[0.06]"
                    >
                      <span
                        className={`text-[9px] ${
                          s.lifecycle === 'active'
                            ? 'text-status-working'
                            : s.lifecycle === 'dormant'
                              ? 'text-deck-muted'
                              : 'text-deck-muted/60'
                        }`}
                      >
                        ● {s.lifecycle}
                      </span>
                      <span className="flex-1 truncate">{s.title}</span>
                      {isMember && (
                        <span
                          className="rounded bg-status-working/15 px-1 py-0.5 text-[9px] text-status-working"
                          title="该 session_id 出现在 config.json 的 members"
                        >
                          ✓ 在 config
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </Section>
        )}

        {/* shared task list（来自 ~/.claude/tasks/<name>/<file>.md） */}
        <Section
          title="共享 task list"
          right={
            snap.taskListMtime !== null ? (
              <span className="text-[9px] text-deck-muted/60">
                更新于 {new Date(snap.taskListMtime).toLocaleTimeString('zh-CN', { hour12: false })}
              </span>
            ) : null
          }
        >
          {snap.taskListFile && (
            <div className="mb-1 truncate font-mono text-[9px] text-deck-muted/60" title={snap.taskListFile}>
              {snap.taskListFile.replace(/.*\/\.claude\//, '~/.claude/')}
            </div>
          )}
          <div className="rounded border border-deck-border/40 bg-black/20 p-2 text-[11px]">
            {snap.taskListMarkdown ? (
              <MarkdownText text={snap.taskListMarkdown} />
            ) : (
              <span className="text-deck-muted/70">
                没有 task list 文件。Claude 会在创建团队时自动写入到 <code className="rounded bg-white/5 px-1">~/.claude/tasks/{name}/</code>
              </span>
            )}
          </div>
        </Section>

        {/* 结构化 tasks (mcp__tasks__*)：SQLite tasks 表（CHANGELOG_43 task store + 本次接入 UI）。
            与上方「共享 task list」markdown 互补不同步。订阅 onTaskChanged 实时刷新。 */}
        <McpTasksSection name={name} />

        {/* M3：team-* hook event 时间线（TaskCreated / TaskCompleted / TeammateIdle）。
            空列表说明本 team 还没收到 hook event（要么 Claude 没用 team 工具，要么 CLI < v2.1.32）。
            mcp tools.ts 同样 ingest team-task-created/completed AgentEvent（CHANGELOG_<X>），
            走 events 表后被本 SQL 命中，所以 mcp 操作也会出现在这里。 */}
        <Section title={`hook 事件流 (${snap.events.length})`}>
          {snap.events.length === 0 ? (
            <div className="rounded border border-deck-border/40 bg-white/[0.02] px-2 py-2 text-[10px] text-deck-muted/70">
              没有 hook event。需要 Claude Code v2.1.32+ + 设置面板「安装到 ~/.claude/settings.json」hook
              （含 TaskCreated / TaskCompleted / TeammateIdle 三个新 event）。
            </div>
          ) : (
            <ul className="flex flex-col gap-1">
              {snap.events.map((ev, idx) => (
                <TeamEventRow key={`${ev.ts}-${idx}`} event={ev} />
              ))}
            </ul>
          )}
        </Section>

        {/* M3：「给 teammate 下指令」入口（应用包装：拼成 "Tell teammate <name>: <text>" 塞 lead.sendMessage） */}
        {snap.sessions.length > 0 && (
          <Section title="给 teammate 下指令">
            <SendToTeammate
              leadSession={pickLeadSession(snap)}
              members={snap.config?.members ?? []}
            />
          </Section>
        )}

        {/* M3：force-cleanup 残留按钮 */}
        <Section title="残留清理（兜底）">
          <ForceCleanupButton name={name} onCleaned={onBack} />
          <div className="mt-1 text-[10px] leading-snug text-deck-muted/70">
            Claude in-process backend cleanup 是**异步延迟**的：teammate shutdown_approved 后
            config.members 由 CLI 异步移除（实测延迟可达几分钟），首次 TeamDelete 可能因
            「members 仍含 active」拒绝。**等几分钟重试通常能成功**；该按钮直接
            <code className="rounded bg-white/5 px-1">rm -rf</code> ~/.claude/teams/{name} 与
            ~/.claude/tasks/{name} 兜底。**仅在等不及或 Claude 自身 cleanup 异常时用**——若 team 内有
            活跃 teammate 在跑，强删会让 Claude 内部状态机异常。
          </div>
        </Section>
      </div>
    </div>
  );
}
