import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type { AgentEvent, TeamSnapshot } from '@shared/types';
import { MarkdownText } from './MarkdownText';

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
 * 通常能成功，或用户手动 rm 残留。M2 不加 force-cleanup 按钮（M3 接 TeammateIdle hook 拿到
 * ground truth 后再加，避免误删活 team）。提示文案中告知用户路径。
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

        {/* M3：team-* hook event 时间线（TaskCreated / TaskCompleted / TeammateIdle）。
            空列表说明本 team 还没收到 hook event（要么 Claude 没用 team 工具，要么 CLI < v2.1.32）。 */}
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

/**
 * 取一个 lead session 候选给 SendToTeammate：
 * 优先 active > dormant > closed；同 lifecycle 取 lastEventAt 最大的（最新）。
 * 没有 sessions 返回 null（SendToTeammate 不渲染）。
 */
function pickLeadSession(snap: TeamSnapshot): { id: string; agentId: string; title: string } | null {
  if (snap.sessions.length === 0) return null;
  const ranked = [...snap.sessions].sort((a, b) => {
    const ord = (l: string): number => (l === 'active' ? 0 : l === 'dormant' ? 1 : 2);
    const diff = ord(a.lifecycle) - ord(b.lifecycle);
    if (diff !== 0) return diff;
    return b.lastEventAt - a.lastEventAt;
  });
  return { id: ranked[0].id, agentId: ranked[0].agentId, title: ranked[0].title };
}

function SendToTeammate({
  leadSession,
  members,
}: {
  leadSession: { id: string; agentId: string; title: string } | null;
  members: TeamSnapshot['config'] extends infer C ? (C extends { members: infer M } ? M : never) : never;
}): JSX.Element {
  const [target, setTarget] = useState<string>('');
  const [text, setText] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!leadSession) {
    return (
      <div className="text-[10px] text-deck-muted/70">没有 lead session 可用，无法发送。</div>
    );
  }

  const send = async (): Promise<void> => {
    setError(null);
    if (!text.trim()) {
      setError('指令不能为空');
      return;
    }
    if (!target.trim()) {
      setError('请填 teammate 名字（或直接选下面成员列表中的一个）');
      return;
    }
    setBusy(true);
    try {
      // REVIEW_17 R3 / M1-R3：原来 `Tell teammate ${target}: ${text}` 字符串拼接，
      // 用户输入含 newline / 仿造下一条 "Tell teammate evil: ..." 即可让 lead LLM 把整段
      // 解析成多条 SendMessage（典型 prompt-injection），手动 UI 风险有限但未来 CLI/API
      // 拼 wrapper 时意外行为概率高。改结构化包装（fenced code block 让 lead 一目了然
      // 看到边界，不会把 text 当指令解析）+ target 名走与 normalizeTeamName 同款 charset
      // 限制（防 target 字段同样被注入 newline）。
      const safeTarget = target.trim();
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(safeTarget)) {
        setError('teammate 名字含非法字符（仅字母 / 数字 / . _ - 允许，长度 ≤ 64）');
        setBusy(false);
        return;
      }
      const wrapped = [
        `Send the following message to teammate "${safeTarget}":`,
        '',
        '```',
        text.trim(),
        '```',
      ].join('\n');
      await window.api.sendAdapterMessage(leadSession.agentId, leadSession.id, wrapped);
      setText('');
    } catch (e) {
      setError(`发送失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[10px] text-deck-muted/70">
        发往 lead session：<span className="font-mono text-deck-text/85">{leadSession.title}</span>
      </div>
      <div className="flex gap-1">
        <input
          type="text"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder="teammate 名字（如 reviewer-1）"
          className="flex-1 rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-[11px] outline-none focus:border-white/20"
        />
      </div>
      {(members as Array<{ name: string }>).length > 0 && (
        <div className="flex flex-wrap gap-1">
          {(members as Array<{ name: string }>).map((m) => (
            <button
              key={m.name}
              type="button"
              onClick={() => setTarget(m.name)}
              className="rounded bg-white/8 px-1.5 py-0.5 text-[9px] text-deck-muted hover:bg-white/15 hover:text-deck-text"
            >
              {m.name}
            </button>
          ))}
        </div>
      )}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="给 teammate 的指令"
        rows={2}
        className="w-full resize-y rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-[11px] outline-none focus:border-white/20"
      />
      {error && (
        <div className="rounded bg-status-waiting/10 px-2 py-1 text-[10px] text-status-waiting">
          {error}
        </div>
      )}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void send()}
          disabled={busy || !text.trim() || !target.trim()}
          className="rounded bg-status-working/30 px-3 py-1 text-[11px] text-status-working hover:bg-status-working/40 disabled:opacity-50"
        >
          {busy ? '发送中…' : '发送'}
        </button>
      </div>
    </div>
  );
}

function ForceCleanupButton({
  name,
  onCleaned,
}: {
  name: string;
  onCleaned: () => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const cleanup = async (): Promise<void> => {
    const ok = await window.api.confirmDialog({
      title: `清理 team "${name}" 残留`,
      message: `确定要 rm -rf ~/.claude/teams/${name} 与 ~/.claude/tasks/${name} 吗？`,
      detail:
        '该操作不可恢复。仅在 Claude 自身 TeamDelete 失败、确认无活跃 teammate 在跑时使用。',
      okLabel: '强制清理',
      cancelLabel: '取消',
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await window.api.forceCleanupTeam(name);
      // 同时显示 fs 删除数 + DB 解绑数。任一非 0 都算「做了事」；都是 0 说明 fs 早就空 + DB 也没 team_name 残留（罕见）
      const parts: string[] = [];
      if (r.removed.length > 0) parts.push(`已删除 ${r.removed.length} 个目录`);
      if (r.unsetSessions > 0) parts.push(`解绑 ${r.unsetSessions} 个会话`);
      setResult(parts.length > 0 ? parts.join('，') : '没有残留可删');
      // 清理后让上层（TeamHub）刷新列表。延迟 1.2s 让用户看清绿字结果再跳回——
      // 之前用 300ms 太快，加上 chokidar unlinkDir 触发 refresh 让整页重渲染，
      // 用户根本看不到「已删除」反馈就被 onBack 切走了。
      setTimeout(onCleaned, 1200);
    } catch (e) {
      setResult(`清理失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <button
        type="button"
        onClick={() => void cleanup()}
        disabled={busy}
        className="rounded bg-status-waiting/20 px-2 py-1 text-[11px] text-status-waiting hover:bg-status-waiting/30 disabled:opacity-50"
      >
        {busy ? '清理中…' : '强制清理 fs 残留'}
      </button>
      {result && (
        <span
          className={`ml-2 text-[11px] font-medium ${
            result.startsWith('清理失败')
              ? 'text-status-waiting'
              : 'text-status-working'
          }`}
        >
          ✓ {result}
        </span>
      )}
    </div>
  );
}

/** team-* event 时间线一行渲染（图标 + 描述 + 时间）。 */
function TeamEventRow({ event }: { event: AgentEvent }): JSX.Element {
  const ts = new Date(event.ts).toLocaleTimeString('zh-CN', { hour12: false });
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const teammate = typeof p.teammateName === 'string' ? p.teammateName : '';
  const desc = typeof p.description === 'string' ? p.description : '';
  const reason = typeof p.reason === 'string' ? p.reason : '';
  const lastTask = typeof p.lastTask === 'string' ? p.lastTask : '';

  let icon = '·';
  let kindLabel = '';
  let body = '';
  switch (event.kind) {
    case 'team-task-created':
      icon = '➕';
      kindLabel = 'TaskCreated';
      body = teammate ? `${teammate} → ${desc || '(no desc)'}` : desc || '(no desc)';
      break;
    case 'team-task-completed':
      icon = '✅';
      kindLabel = 'TaskCompleted';
      body = teammate ? `${teammate} done: ${desc || '(no desc)'}` : `done: ${desc || '(no desc)'}`;
      break;
    case 'team-teammate-idle':
      icon = '💤';
      kindLabel = 'TeammateIdle';
      body =
        (teammate || 'teammate') +
        ' idle' +
        (lastTask ? `  (last: ${lastTask})` : '') +
        (reason ? `  [${reason}]` : '');
      break;
    default:
      kindLabel = event.kind;
      body = JSON.stringify(p).slice(0, 80);
  }

  return (
    <li className="flex items-start gap-1.5 rounded border border-deck-border/40 bg-white/[0.02] px-2 py-1 text-[10px]">
      <span className="shrink-0">{icon}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-[9px] text-deck-muted/70">{kindLabel}</span>
          <span className="ml-auto font-mono tabular-nums text-[9px] text-deck-muted/60">{ts}</span>
        </div>
        <div className="mt-0.5 truncate" title={body}>
          {body}
        </div>
      </div>
    </li>
  );
}

function Header({ name, onBack }: { name: string; onBack: () => void }): JSX.Element {
  return (
    <header className="flex items-center gap-2 border-b border-deck-border/40 px-3 py-2">
      <button
        type="button"
        onClick={onBack}
        className="rounded bg-white/8 px-2 py-0.5 text-[10px] text-deck-muted hover:bg-white/15"
      >
        ← 返回
      </button>
      <span className="text-[11px] text-deck-muted/70">🛡</span>
      <span className="flex-1 truncate text-[12px] font-medium">{name}</span>
    </header>
  );
}

function Section({
  title,
  right,
  children,
}: {
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section className="mb-3">
      <div className="mb-1 flex items-center gap-2">
        <h3 className="text-[10px] uppercase tracking-wider text-deck-muted/70">{title}</h3>
        {right && <div className="ml-auto">{right}</div>}
      </div>
      {children}
    </section>
  );
}

function Stat({
  label,
  value,
  ok,
}: {
  label: string;
  value: string;
  ok?: boolean;
}): JSX.Element {
  return (
    <div className="rounded border border-deck-border/40 bg-white/[0.02] px-2 py-1">
      <div className="text-[9px] uppercase tracking-wider text-deck-muted/60">{label}</div>
      <div
        className={`mt-0.5 text-[11px] ${
          ok === true ? 'text-status-working' : ok === false ? 'text-deck-muted/80' : ''
        }`}
      >
        {value}
      </div>
    </div>
  );
}
