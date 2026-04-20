import { useMemo, type JSX } from 'react';
import { useSessionStore } from '@renderer/stores/session-store';
import { SessionCard } from './SessionCard';

export function SessionList(): JSX.Element {
  const sessions = useSessionStore((s) => s.sessions);
  const selected = useSessionStore((s) => s.selectedSessionId);
  const select = useSessionStore((s) => s.selectSession);

  const grouped = useMemo(() => {
    const all = [...sessions.values()].sort((a, b) => b.lastEventAt - a.lastEventAt);
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
          在「设置」里安装 Claude Code Hook，
          <br />
          然后在终端运行 <code className="rounded bg-white/5 px-1">claude</code> 即可看到会话。
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
