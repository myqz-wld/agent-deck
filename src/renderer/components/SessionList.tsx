import { useMemo, type JSX } from 'react';
import { useSessionStore } from '@renderer/stores/session-store';
import { selectLiveSessions } from '@renderer/lib/session-selectors';
import { SessionCard } from './SessionCard';

export function SessionList(): JSX.Element {
  const sessions = useSessionStore((s) => s.sessions);
  const selected = useSessionStore((s) => s.selectedSessionId);
  const select = useSessionStore((s) => s.selectSession);

  const grouped = useMemo(() => {
    // 实时面板只显示未归档的 active/dormant；归档与 lifecycle 正交（详见 CLAUDE.md），
    // 必须显式过滤 archivedAt，否则在当前会话内归档后，session-upserted 推送的
    // record 仍带原 lifecycle，会一直留在实时列表里直到下次重启 setSessions 重灌。
    // 与 App.tsx header stats 共用 selectLiveSessions，确保两处计数完全一致。
    const all = selectLiveSessions(sessions);
    return {
      active: all.filter((s) => s.lifecycle === 'active'),
      dormant: all.filter((s) => s.lifecycle === 'dormant'),
    };
  }, [sessions]);

  if (grouped.active.length === 0 && grouped.dormant.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 px-6 py-10 text-center text-deck-muted">
        <div className="text-[12px]">暂无活跃会话</div>
        <div className="text-[10px] leading-relaxed">
          点 ＋ 新建会话（可选 Claude / Codex），或：
          <br />
          在「设置」装 Claude Hook 后终端跑 <code className="rounded bg-white/5 px-1">claude</code>
          <br />
          也可终端跑 <code className="rounded bg-white/5 px-1">agent-deck new --agent codex-cli</code>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {grouped.active.length > 0 && (
        <section>
          <div className="mb-1.5 px-1 text-[10px] uppercase tracking-wider text-deck-muted/70">
            活跃 · {grouped.active.length}
          </div>
          <div className="flex flex-col gap-1.5">
            {grouped.active.map((s) => (
              <SessionCard
                key={s.id}
                session={s}
                selected={selected === s.id}
                onSelect={() => select(s.id)}
              />
            ))}
          </div>
        </section>
      )}
      {grouped.dormant.length > 0 && (
        <section>
          <div className="mb-1.5 px-1 text-[10px] uppercase tracking-wider text-deck-muted/70">
            休眠 · {grouped.dormant.length}
          </div>
          <div className="flex flex-col gap-1.5">
            {grouped.dormant.map((s) => (
              <SessionCard
                key={s.id}
                session={s}
                selected={selected === s.id}
                onSelect={() => select(s.id)}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
