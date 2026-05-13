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
 * - 「窗口透明」由独立 toggle / 全局快捷键 Cmd+Alt+T 控制（Phase 5 Step 5.6 解耦：透明
 *   不再依赖 pin 状态，独立切换；与 alwaysOnTop 平级）。
 */
export function WindowSection({ settings, update }: Props): JSX.Element {
  return (
    <Section title="窗口" storageKey="window" defaultOpen={false}>
      <Toggle
        label="窗口透明（看到下层桌面）"
        value={settings.windowTransparent}
        onChange={(v) => void update({ windowTransparent: v })}
      />
      <div className="text-[10px] leading-snug text-deck-muted/70">
        {IS_DARWIN ? (
          <>
            开启后 macOS vibrancy 关闭、CSS frosted-frame 主导通透感，看得到下层桌面 / 其它 app。
            关掉后保留 under-window 实玻璃。Phase 5 Step 5.6 起独立于「置顶」开关 ——
            不置顶时也能开透明（视觉效果不变，仍是 vibrancy null + CSS frosted）。
            切换后立即生效，无需重启。快捷键 <code>Cmd+Alt+T</code>。
          </>
        ) : (
          <>
            非 macOS 平台无 vibrancy 效果，本设置仅影响 CSS 背景透明度。Phase 5 Step 5.6 起
            独立于「置顶」开关。切换后立即生效，无需重启。
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
