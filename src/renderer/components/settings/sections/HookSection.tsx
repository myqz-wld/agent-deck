import { type JSX } from 'react';
import type { HookInstallStatus } from '@shared/types';
import { Section } from '../controls';

interface Props {
  hookStatus: HookInstallStatus | null;
  busy: boolean;
  installHook: () => Promise<void>;
  uninstallHook: () => Promise<void>;
}

export function HookSection({ hookStatus, busy, installHook, uninstallHook }: Props): JSX.Element {
  return (
    <Section title="Claude Code Hook（系统钩子）" storageKey="hook" defaultOpen={true}>
      {hookStatus ? (
        <div className="text-[11px] leading-relaxed">
          <div className="text-deck-muted">
            状态：{hookStatus.installed ? '已安装' : '未安装'}
          </div>
          <div className="break-all text-[10px] text-deck-muted/70">
            位置：{hookStatus.settingsPath}
          </div>
          <div className="mt-2 flex gap-2">
            {hookStatus.installed ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void uninstallHook()}
                className="rounded bg-status-waiting/20 px-2 py-1 text-[11px] text-status-waiting hover:bg-status-waiting/30 disabled:opacity-50"
              >
                卸载
              </button>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => void installHook()}
                className="rounded bg-status-working/20 px-2 py-1 text-[11px] text-status-working hover:bg-status-working/30 disabled:opacity-50"
              >
                安装到 ~/.claude/settings.json
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="text-[11px] text-deck-muted">读取中…</div>
      )}
    </Section>
  );
}
