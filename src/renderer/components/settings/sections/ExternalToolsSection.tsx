import { type JSX } from 'react';
import type { AppSettings } from '@shared/types';
import { Section, ExecutablePicker } from '../controls';

interface Props {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => Promise<void>;
  readOnly?: boolean;
}

export function ExternalToolsSection({ settings, update, readOnly = false }: Props): JSX.Element {
  return (
    <Section title="外部工具" storageKey="external" defaultOpen={false}>
      <ExecutablePicker
        label="Codex CLI 二进制路径"
        hint="留空会使用应用内置 Codex CLI（推荐）。要指定外部程序，可在终端运行 which codex 后填入返回路径。"
        path={settings.codexCliPath}
        disabled={readOnly}
        onChange={(p) => void update({ codexCliPath: p })}
      />
      <ExecutablePicker
        label="Claude Code 二进制路径"
        hint="留空会使用应用内置 Claude Code（推荐）。要指定外部程序，可在终端运行 which claude 后填入返回路径。"
        path={settings.claudeCliPath}
        disabled={readOnly}
        onChange={(p) => void update({ claudeCliPath: p })}
      />
      <ExecutablePicker
        label="Grok Build 二进制路径"
        hint="留空会使用应用内置 Grok Build（推荐）。要指定外部程序，可在终端运行 which grok 后填入返回路径。"
        path={settings.grokCliPath}
        disabled={readOnly}
        onChange={(p) => void update({ grokCliPath: p })}
      />
    </Section>
  );
}
