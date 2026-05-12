import { type JSX } from 'react';
import type { AppSettings } from '@shared/types';
import { Section, NumberInput } from '../controls';

interface Props {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => Promise<void>;
}

export function LifecycleSection({ settings, update }: Props): JSX.Element {
  return (
    <Section title="生命周期" storageKey="lifecycle" defaultOpen={true}>
      <NumberInput
        label="活跃 → 休眠 阈值（分钟）"
        value={Math.round(settings.activeWindowMs / 60000)}
        min={1}
        onChange={(v) => void update({ activeWindowMs: v * 60_000 })}
      />
      <NumberInput
        label="休眠 → 关闭 阈值（小时）"
        value={Math.round(settings.closeAfterMs / 3600000)}
        min={1}
        onChange={(v) => void update({ closeAfterMs: v * 3_600_000 })}
      />
      <NumberInput
        label="权限请求超时（秒，0 = 不超时）"
        value={Math.round(settings.permissionTimeoutMs / 1000)}
        min={0}
        onChange={(v) => void update({ permissionTimeoutMs: v * 1000 })}
      />
      <NumberInput
        label="历史会话保留（天，0 = 永久保留）"
        value={settings.historyRetentionDays}
        min={0}
        onChange={(v) => void update({ historyRetentionDays: v })}
      />
    </Section>
  );
}
