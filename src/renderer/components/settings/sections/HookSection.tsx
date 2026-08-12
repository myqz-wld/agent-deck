import { type JSX } from 'react';
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
  targetDescription?: string;
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
  targetDescription,
  unavailableReason,
}: Props): JSX.Element {
  const partial = hookStatus?.state === 'partial';
  const installed = hookStatus?.state === 'installed';
  const unavailable = hookStatus?.state === 'unavailable';
  return (
    <Section title={title} storageKey={storageKey} defaultOpen={false}>
      {targetDescription && (
        <div className="mb-1 text-[10px] leading-relaxed text-deck-muted/75">
          {targetDescription}
        </div>
      )}
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
          {hookStatus.writeAllowed && (
            <div className="mt-2 flex gap-2">
            {installed ? (
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
                {partial ? '修复 Hook' : installLabel}
              </button>
            )}
            </div>
          )}
        </div>
      ) : (
        <div className="text-[11px] text-deck-muted">读取中…</div>
      )}
    </Section>
  );
}
