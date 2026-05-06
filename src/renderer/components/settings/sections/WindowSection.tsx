import { type JSX } from 'react';
import type { AppSettings } from '@shared/types';
import { Section, Toggle } from '../controls';
import { IS_DARWIN } from '@renderer/lib/platform';

interface Props {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => Promise<void>;
}

/**
 * 「窗口」section。包含 B3 #1 透明窗口描述与 #4 快捷键注释两处平台分流（CHANGELOG_57）。
 *
 * - 始终置顶由 header 的 📌 按钮 / 全局快捷键控制（mac: Cmd+Alt+P；win/linux: Ctrl+Alt+P
 *   —— Electron 注册 `CommandOrControl+Alt+P` 自动适配，UI 文案按平台条件渲染）。
 * - 这里不放重复的「始终置顶」toggle，避免两处状态打架。
 */
export function WindowSection({ settings, update }: Props): JSX.Element {
  return (
    <Section title="窗口" storageKey="window" defaultOpen={false}>
      <Toggle
        label="置顶时透明（看到下层桌面）"
        value={settings.transparentWhenPinned}
        onChange={(v) => void update({ transparentWhenPinned: v })}
      />
      <div className="text-[10px] leading-snug text-deck-muted/70">
        {IS_DARWIN ? (
          <>
            关掉后置顶时仍是实玻璃（macOS under-window vibrancy），看不到下层桌面 / 其他 app。
            切换后立即生效，无需重启。仅 macOS 有视觉差异。
          </>
        ) : (
          <>
            关掉后置顶时为不透明窗口背景；非 macOS 平台无 vibrancy 效果，本设置仅影响背景透明度。
            切换后立即生效，无需重启。
          </>
        )}
      </div>
      <Toggle
        label="开机自启"
        value={settings.startOnLogin}
        onChange={(v) => void update({ startOnLogin: v })}
      />
    </Section>
  );
}
