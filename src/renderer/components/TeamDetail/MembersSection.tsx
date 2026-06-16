import { useMemo, useState, type JSX } from 'react';
import type { AgentDeckTeamMember, AgentDeckTeamMemberRole, SessionRecord } from '@shared/types';
import { DeckSelect } from '@renderer/components/DeckSelect';
import { useSessionStore } from '@renderer/stores/session-store';
import { Section, EmptyState } from './Header';
import { lifecycleLabel, agentIdLabel } from './helpers';
import { selectJoinableTeamSessions } from './member-candidates';

/**
 * plan team-cohesion-fix-20260513 Phase C：成员清单 section。
 *
 * 列出 team 内所有 active 成员（含 left_at 不为 null 的「已退出」灰显示）。每项展示：
 * - displayName（fallback session.title / sid 前 8 字符）
 * - role（lead / teammate）
 * - 跨 adapter 标识（agentId）+ lifecycle
 * - 点击跳转 SessionDetail
 *
 * 数据从父组件传入 members（IPC 已含 includeLeft=false 的 active 列表 + left 列表，本组件
 * 直接渲染 props 不再做 fs / IPC 调用）。
 */
interface Props {
  teamId: string;
  members: AgentDeckTeamMember[];
  onOpenSession: (sessionId: string) => void;
  canAddMember: boolean;
  onMemberAdded: () => Promise<void>;
}

const ROLE_OPTIONS: { value: AgentDeckTeamMemberRole; label: string }[] = [
  { value: 'teammate', label: '协作者' },
  { value: 'lead', label: '负责人' },
];

export function MembersSection({
  teamId,
  members,
  onOpenSession,
  canAddMember,
  onMemberAdded,
}: Props): JSX.Element {
  const sessions = useSessionStore((s) => s.sessions);
  const [addSessionId, setAddSessionId] = useState('');
  const [addRole, setAddRole] = useState<AgentDeckTeamMemberRole>('teammate');
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const joinableSessions = useMemo(
    () => selectJoinableTeamSessions(sessions, members),
    [sessions, members],
  );
  const selectedSession =
    joinableSessions.find((session) => session.id === addSessionId) ?? joinableSessions[0] ?? null;
  const selectedSessionId = selectedSession?.id ?? '';

  const onAddMember = async (): Promise<void> => {
    if (!canAddMember || addBusy || !selectedSession) return;
    setAddBusy(true);
    setAddError(null);
    try {
      await window.api.addAgentDeckTeamMember({
        teamId,
        sessionId: selectedSession.id,
        role: addRole,
      });
      setAddSessionId('');
      try {
        await onMemberAdded();
      } catch (err) {
        setAddError(`已加入，刷新失败：${(err as Error).message ?? String(err)}`);
      }
    } catch (err) {
      setAddError(`加入失败：${(err as Error).message ?? String(err)}`);
    } finally {
      setAddBusy(false);
    }
  };

  if (members.length === 0) {
    return (
      <Section title="成员" count={0}>
        {canAddMember && (
          <AddMemberForm
            joinableSessions={joinableSessions}
            selectedSessionId={selectedSessionId}
            role={addRole}
            busy={addBusy}
            error={addError}
            onSessionChange={(value) => {
              setAddSessionId(value);
              setAddError(null);
            }}
            onRoleChange={(value) => {
              setAddRole(value);
              setAddError(null);
            }}
            onSubmit={() => void onAddMember()}
          />
        )}
        <EmptyState>尚无成员</EmptyState>
      </Section>
    );
  }

  return (
    <Section title="成员" count={members.length}>
      {canAddMember && (
        <AddMemberForm
          joinableSessions={joinableSessions}
          selectedSessionId={selectedSessionId}
          role={addRole}
          busy={addBusy}
          error={addError}
          onSessionChange={(value) => {
            setAddSessionId(value);
            setAddError(null);
          }}
          onRoleChange={(value) => {
            setAddRole(value);
            setAddError(null);
          }}
          onSubmit={() => void onAddMember()}
        />
      )}
      <ul className="flex flex-col gap-1">
        {members.map((m) => {
          const sess = sessions.get(m.sessionId);
          const label = m.displayName ?? sess?.title ?? m.sessionId.slice(0, 8);
          const isLeft = m.leftAt !== null;
          return (
            <li
              key={m.sessionId}
              className={`flex items-center justify-between rounded border border-deck-border/40 px-2 py-1 text-[11px] hover:bg-white/[0.04] cursor-pointer ${
                isLeft ? 'opacity-60' : ''
              }`}
              onClick={() => onOpenSession(m.sessionId)}
              title={`点击打开 ${label} 详情`}
            >
              <span className="truncate">
                <strong className="text-deck-text">{label}</strong>{' '}
                <RoleBadge role={m.role} />
                {isLeft && <span className="ml-1 text-deck-muted/60">已退出</span>}
              </span>
              <span className="ml-2 shrink-0 text-deck-muted/60">
                {agentIdLabel(sess?.agentId)} · {lifecycleLabel(sess?.lifecycle)}
              </span>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

function AddMemberForm({
  joinableSessions,
  selectedSessionId,
  role,
  busy,
  error,
  onSessionChange,
  onRoleChange,
  onSubmit,
}: {
  joinableSessions: SessionRecord[];
  selectedSessionId: string;
  role: AgentDeckTeamMemberRole;
  busy: boolean;
  error: string | null;
  onSessionChange: (value: string) => void;
  onRoleChange: (value: AgentDeckTeamMemberRole) => void;
  onSubmit: () => void;
}): JSX.Element {
  const disabled = busy || !selectedSessionId || joinableSessions.length === 0;
  const sessionOptions =
    joinableSessions.length === 0
      ? [{ value: '', label: '没有可加入的活跃会话', disabled: true }]
      : joinableSessions.map((session) => ({
          value: session.id,
          label: sessionOptionLabel(session),
        }));

  return (
    <form
      className="mb-2 flex flex-col gap-1 rounded border border-deck-border/40 bg-white/[0.02] px-2 py-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <DeckSelect
          ariaLabel="选择要加入团队的会话"
          value={selectedSessionId}
          onChange={onSessionChange}
          disabled={busy || joinableSessions.length === 0}
          options={sessionOptions}
          className="min-w-0 flex-1"
          buttonClassName="w-full rounded border border-deck-border bg-deck-bg px-1.5 py-0.5 text-left text-[10px] text-deck-text outline-none hover:bg-white/[0.04] disabled:cursor-not-allowed disabled:opacity-50"
          menuMinWidth={260}
        />
        <DeckSelect
          ariaLabel="成员角色"
          value={role}
          onChange={onRoleChange}
          disabled={busy || joinableSessions.length === 0}
          options={ROLE_OPTIONS}
          className="w-[72px]"
          buttonClassName="w-full rounded border border-deck-border bg-deck-bg px-1.5 py-0.5 text-left text-[10px] text-deck-text outline-none hover:bg-white/[0.04] disabled:cursor-not-allowed disabled:opacity-50"
          menuMinWidth={96}
        />
        <button
          type="submit"
          disabled={disabled}
          className="rounded bg-blue-400/15 px-2 py-0.5 text-[10px] font-medium text-blue-200 transition hover:bg-blue-400/25 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? '加入中…' : '+ 加入'}
        </button>
      </div>
      {error && <div className="text-[10px] text-status-waiting/90">{error}</div>}
    </form>
  );
}

function sessionOptionLabel(session: SessionRecord): string {
  const title = session.title.trim() || session.id.slice(0, 8);
  return `${title} · ${agentIdLabel(session.agentId)} · ${lifecycleLabel(session.lifecycle)}`;
}

function RoleBadge({ role }: { role: 'lead' | 'teammate' }): JSX.Element {
  if (role === 'lead') {
    return (
      <span className="ml-0.5 rounded bg-blue-400/15 px-1 py-0.5 text-[9px] font-medium text-blue-200">
        👑 负责人
      </span>
    );
  }
  return (
    <span className="ml-0.5 rounded bg-blue-400/10 px-1 py-0.5 text-[9px] font-medium text-blue-200/85">
      ↳ 协作者
    </span>
  );
}
