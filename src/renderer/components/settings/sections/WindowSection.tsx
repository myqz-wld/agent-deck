import { type JSX } from 'react';
import type { AppSettings } from '@shared/types';
import { Section, Toggle } from '../controls';

interface Props {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => Promise<void>;
}

/**
 * 「窗口」section。
 *
 * - 始终置顶由 header 的 📌 按钮 / 全局快捷键 Cmd+Alt+P 控制(详「快捷键」section);
 *   这里不放重复的「始终置顶」toggle,避免两处状态打架。
 * - 「窗口透明」toggle 已从本 section 移除(独立于 settings UI,user 通过全局快捷键
 *   Cmd+Alt+T 切换;settings.windowTransparent 字段仍持久化、运行时仍 honor;详「快捷键」
 *   section)。
 * - 「放大 / 缩小窗口」由全局快捷键 Cmd+Alt+= / Cmd+Alt+- 控制(详「快捷键」section)。
 */
export function WindowSection({ settings, update }: Props): JSX.Element {
  return (
    <Section title="窗口" storageKey="window" defaultOpen={false}>
      <Toggle
        label="开机自启"
        value={settings.startOnLogin}
        onChange={(v) => void update({ startOnLogin: v })}
      />
    </Section>
  );
}
