import { type JSX } from 'react';
import { StableButtonContent } from '../../StableButtonContent';
import { Section } from '../controls';

export interface HookStatusPresentation {
  state: 'installed' | 'partial' | 'not-installed' | 'unavailable';
  locationLabel: string | null;
  writeAllowed: boolean;
  disabledReason: string | null;
}

interface Props {
  title: string;
  storageKey: string;
  installLabel: string;
  hookStatus: HookStatusPresentation | null;
  busy: boolean;
  installHook: () => Promise<void>;
  uninstallHook: () => Promise<void>;
  unavailableReason?: string | null;
}

export function HookSection({
  title,
  storageKey,
  installLabel,
  hookStatus,
  busy,
  installHook,
  uninstallHook,
  unavailableReason,
}: Props): JSX.Element {
  const partial = hookStatus?.state === 'partial';
  const installed = hookStatus?.state === 'installed';
  const unavailable = hookStatus?.state === 'unavailable';
  return (
    <Section title={title} storageKey={storageKey} defaultOpen={false}>
      {unavailableReason ? (
        <div role="status" className="text-[11px] leading-relaxed text-deck-muted">
          {unavailableReason}
        </div>
      ) : hookStatus ? (
        <div className="text-[11px] leading-relaxed">
          <div className="text-deck-muted">
            状态：{installed ? '已安装' : partial ? '安装不完整' : unavailable ? '不可用' : '未安装'}
          </div>
          {hookStatus.locationLabel && (
            <div className="break-all text-[10px] text-deck-muted/70">
              位置：{hookStatus.locationLabel}
            </div>
          )}
          {hookStatus.disabledReason && (
            <div role="status" className="mt-1 text-[10px] text-deck-muted/75">
              {hookStatus.disabledReason}
            </div>
          )}
          <div className="mt-2 flex gap-2">
            {installed ? (
              <button
                type="button"
                disabled={busy || !hookStatus.writeAllowed}
                onClick={() => void uninstallHook()}
                className="rounded bg-status-waiting/20 px-2 py-1 text-[11px] text-status-waiting hover:bg-status-waiting/30 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <StableButtonContent
                  activeKey="uninstall"
                  variants={[
                    { key: 'install', content: installLabel },
                    { key: 'repair', content: '修复 Hook' },
                    { key: 'uninstall', content: '卸载' },
                  ]}
                />
              </button>
            ) : (
              <button
                type="button"
                disabled={busy || !hookStatus.writeAllowed}
                onClick={() => void installHook()}
                className="rounded bg-status-working/20 px-2 py-1 text-[11px] text-status-working hover:bg-status-working/30 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <StableButtonContent
                  activeKey={partial ? 'repair' : 'install'}
                  variants={[
                    { key: 'install', content: installLabel },
                    { key: 'repair', content: '修复 Hook' },
                    { key: 'uninstall', content: '卸载' },
                  ]}
                />
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
