import { type JSX } from 'react';
import type { AppSettings } from '@shared/types';
import { Section, ExecutablePicker } from '../controls';

interface Props {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => Promise<void>;
}

export function ExternalToolsSection({ settings, update }: Props): JSX.Element {
  return (
    <Section title="外部工具" storageKey="external" defaultOpen={false}>
      <ExecutablePicker
        label="Codex 二进制路径"
        hint="留空 = 用应用内置 codex（推荐）。填路径 = 覆盖为外部 codex（如 `which codex` 给的路径）"
        path={settings.codexCliPath}
        onChange={(p) => void update({ codexCliPath: p })}
      />
      <ExecutablePicker
        label="Claude 二进制路径"
        hint="留空 = 用应用内置 Claude CLI（推荐）。填路径 = 覆盖为外部 Claude CLI（如 `which claude` 给的路径）"
        path={settings.claudeCliPath}
        onChange={(p) => void update({ claudeCliPath: p })}
      />
    </Section>
  );
}
