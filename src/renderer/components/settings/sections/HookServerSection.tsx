import { type JSX } from 'react';
import type { AppSettings } from '@shared/types';
import { Section, NumberInput } from '../controls';

interface Props {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => Promise<void>;
}

export function HookServerSection({ settings, update }: Props): JSX.Element {
  return (
    <Section title="Hook Server（本地端口）" storageKey="hookserver" defaultOpen={false}>
      <NumberInput
        label="端口（重启生效）"
        value={settings.hookServerPort}
        min={1024}
        max={65535}
        onChange={(v) => void update({ hookServerPort: v })}
      />
    </Section>
  );
}
