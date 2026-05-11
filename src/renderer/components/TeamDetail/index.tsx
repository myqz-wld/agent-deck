import { useEffect, useState, type JSX } from 'react';
import type { AgentDeckMessage, AgentDeckTeam, AgentDeckTeamMember } from '@shared/types';
import { useSessionStore } from '@renderer/stores/session-store';

/**
 * R3.E7 (PR-B) 重写 — Universal Team Backend TeamDetail。
 *
 * 走新 `agent-deck-team:get` IPC 拿 team + members + recentMessages snapshot；
 * 不再依赖 fs ~/.claude/teams/<name>/config.json 老协议。
 *
 * 当前是「最小可用」版本：列 members + recentMessages 时间线 + 跳转 session。
 * 完整 send_message UI / role 切换 / archive 入口待后续迭代细化。
 */

interface Props {
  teamId: string;
  onBack: () => void;
  onOpenSession: (sessionId: string) => void;
}

interface TeamSnapshot extends AgentDeckTeam {
  members: AgentDeckTeamMember[];
  recentMessages: AgentDeckMessage[];
}

export function TeamDetail({ teamId, onBack, onOpenSession }: Props): JSX.Element {
  const [snap, setSnap] = useState<TeamSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sessions = useSessionStore((s) => s.sessions);

  useEffect(() => {
    let aborted = false;
    const fetch = (): void => {
      void window.api
        .getAgentDeckTeam(teamId)
        .then((row) => {
          if (aborted) return;
          if (!row) {
            setError('Team 不存在或已删除');
          } else {
            setSnap(row);
          }
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (aborted) return;
          setError(`加载失败：${(err as Error).message ?? String(err)}`);
          setLoading(false);
        });
    };
    fetch();
    const offTeam = window.api.onAgentDeckTeamChanged(() => fetch());
    const offMsg = window.api.onAgentDeckMessageChanged(() => fetch());
    return () => {
      aborted = true;
      offTeam();
      offMsg();
    };
  }, [teamId]);

  if (loading) {
    return (
      <div className="flex h-full flex-col">
        <Header onBack={onBack}>加载中…</Header>
      </div>
    );
  }
  if (error || !snap) {
    return (
      <div className="flex h-full flex-col">
        <Header onBack={onBack}>错误</Header>
        <div className="px-3 py-2 text-[11px] text-status-waiting/90">{error ?? '未知错误'}</div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <Header onBack={onBack}>{snap.name}</Header>
      <div className="flex-1 overflow-y-auto scrollbar-deck px-3 py-2 text-[11px]">
        <Section title={`成员 (${snap.members.length})`}>
          {snap.members.length === 0 ? (
            <div className="text-deck-muted/70">尚无成员</div>
          ) : (
            <ul className="flex flex-col gap-1">
              {snap.members.map((m) => {
                const sess = sessions.get(m.sessionId);
                const label = m.displayName ?? sess?.title ?? m.sessionId.slice(0, 8);
                return (
                  <li
                    key={m.sessionId}
                    className="flex items-center justify-between rounded border border-deck-border/40 px-2 py-1 hover:bg-white/[0.04] cursor-pointer"
                    onClick={() => onOpenSession(m.sessionId)}
                  >
                    <span>
                      <strong className="text-deck-text">{label}</strong>{' '}
                      <span className="text-deck-muted">[{m.role}]</span>
                      {m.leftAt !== null && <span className="ml-1 text-deck-muted/60">已退出</span>}
                    </span>
                    <span className="text-deck-muted/60">
                      {sess?.agentId ?? 'unknown'} · {sess?.lifecycle ?? '?'}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
        <Section title={`最近消息 (${snap.recentMessages.length})`}>
          {snap.recentMessages.length === 0 ? (
            <div className="text-deck-muted/70">尚无 cross-adapter 消息</div>
          ) : (
            <ol className="flex flex-col gap-1">
              {snap.recentMessages.slice(0, 30).map((msg) => {
                const fromSess = sessions.get(msg.fromSessionId);
                const toSess = sessions.get(msg.toSessionId);
                return (
                  <li
                    key={msg.id}
                    className="rounded border border-deck-border/40 bg-white/[0.02] px-2 py-1"
                  >
                    <div className="flex items-center justify-between text-[10px] text-deck-muted">
                      <span>
                        {fromSess?.title ?? msg.fromSessionId.slice(0, 8)} →{' '}
                        {toSess?.title ?? msg.toSessionId.slice(0, 8)}
                      </span>
                      <span>{statusBadge(msg.status)}</span>
                    </div>
                    <div className="mt-1 text-deck-text whitespace-pre-wrap break-words text-[11px]">
                      {msg.body.length > 240 ? `${msg.body.slice(0, 240)}…` : msg.body}
                    </div>
                    {msg.statusReason && (
                      <div className="mt-1 text-[10px] text-status-waiting/70">
                        {msg.statusReason}
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </Section>
      </div>
    </div>
  );
}

function Header({ onBack, children }: { onBack: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex items-center gap-2 border-b border-deck-border px-3 py-2">
      <button
        type="button"
        onClick={onBack}
        className="no-drag text-[11px] text-deck-muted hover:text-deck-text"
      >
        ← 返回
      </button>
      <div className="flex-1 text-[12px] text-deck-text truncate">{children}</div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section className="mb-3">
      <h3 className="mb-1 text-[10px] uppercase tracking-wider text-deck-muted">{title}</h3>
      {children}
    </section>
  );
}

function statusBadge(status: AgentDeckMessage['status']): string {
  switch (status) {
    case 'pending':
      return '⏳ pending';
    case 'delivering':
      return '📤 delivering';
    case 'delivered':
      return '✅ delivered';
    case 'failed':
      return '❌ failed';
    case 'cancelled':
      return '⊘ cancelled';
    default:
      return status;
  }
}
