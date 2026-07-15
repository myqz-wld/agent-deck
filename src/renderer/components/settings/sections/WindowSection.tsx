import { type JSX } from 'react';
import type { AppSettings } from '@shared/types';
import { Section, Toggle } from '../controls';

interface Props {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => Promise<void>;
}

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
