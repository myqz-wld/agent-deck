import { type JSX } from 'react';
import type { AppSettings } from '@shared/types';
import { Section, Toggle, SoundPicker, NotificationTestRow } from '../controls';

interface Props {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => Promise<void>;
}

export function NotifySection({ settings, update }: Props): JSX.Element {
  return (
    <Section title="提醒" storageKey="notify" defaultOpen={false}>
      <Toggle
        label="启用声音"
        value={settings.enableSound}
        onChange={(v) => void update({ enableSound: v })}
      />
      <Toggle
        label="窗口聚焦时静音"
        value={settings.silentWhenFocused}
        onChange={(v) => void update({ silentWhenFocused: v })}
      />
      <Toggle
        label="启用系统通知"
        value={settings.enableSystemNotification}
        onChange={(v) => void update({ enableSystemNotification: v })}
      />
      <NotificationTestRow />
      <SoundPicker
        label="等待用户提示音"
        kind="waiting"
        path={settings.waitingSoundPath}
        onChange={(p) => void update({ waitingSoundPath: p })}
      />
      <SoundPicker
        label="完成提示音"
        kind="done"
        path={settings.finishedSoundPath}
        onChange={(p) => void update({ finishedSoundPath: p })}
      />
    </Section>
  );
}
