import type { JSX } from 'react';
import type { AgentDeckTeamMember } from '@shared/types';
import { useSessionStore } from '@renderer/stores/session-store';
import { Section, EmptyState } from './Header';

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
  members: AgentDeckTeamMember[];
  onOpenSession: (sessionId: string) => void;
}

export function MembersSection({ members, onOpenSession }: Props): JSX.Element {
  const sessions = useSessionStore((s) => s.sessions);

  if (members.length === 0) {
    return (
      <Section title="成员" count={0}>
        <EmptyState>尚无成员</EmptyState>
      </Section>
    );
  }

  return (
    <Section title="成员" count={members.length}>
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
                {sess?.agentId ?? 'unknown'} · {sess?.lifecycle ?? '?'}
              </span>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

function RoleBadge({ role }: { role: 'lead' | 'teammate' }): JSX.Element {
  if (role === 'lead') {
    return (
      <span className="ml-0.5 rounded bg-blue-400/15 px-1 py-0.5 text-[9px] font-medium text-blue-200">
        👑 lead
      </span>
    );
  }
  return (
    <span className="ml-0.5 rounded bg-blue-400/10 px-1 py-0.5 text-[9px] font-medium text-blue-200/85">
      ↳ teammate
    </span>
  );
}
