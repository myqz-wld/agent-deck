import { type JSX } from 'react';
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/types';
import { RefreshIcon } from '../icons';

/** 保留安装级鉴权身份，只把用户可配置项恢复为默认值。 */
export function buildDefaultSettingsPatch(): Partial<AppSettings> {
  const {
    hookServerToken: _hookServerToken,
    mcpServerToken: _mcpServerToken,
    ...defaults
  } = DEFAULT_SETTINGS;
  return defaults;
}

export function ResetSettingsButton({
  busy,
  update,
}: {
  busy: boolean;
  update: (patch: Partial<AppSettings>) => Promise<void>;
}): JSX.Element {
  const reset = async (): Promise<void> => {
    const confirmed = await window.api.confirmDialog({
      title: '重置到默认配置',
      message: '确定要重置 Agent Deck 配置吗？',
      detail:
        '通用、Claude Code 和 Codex CLI 页的可配置项将恢复默认值。本机鉴权 token 会保留，已安装的终端 Hook 不会被卸载。',
      okLabel: '重置配置',
      cancelLabel: '取消',
      destructive: true,
    });
    if (confirmed) await update(buildDefaultSettingsPatch());
  };

  return (
    <div className="mt-2 border-t border-deck-border pt-3">
      <button
        type="button"
        disabled={busy}
        onClick={() => void reset()}
        className="no-drag w-full rounded border border-status-waiting/30 bg-status-waiting/10 px-3 py-1.5 text-[11px] text-status-waiting/90 hover:bg-status-waiting/20 disabled:opacity-50"
      >
        <RefreshIcon className="mr-1 inline h-3 w-3" />
        重置到默认配置
      </button>
    </div>
  );
}
