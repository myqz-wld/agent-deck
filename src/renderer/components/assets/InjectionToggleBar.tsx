import { type JSX } from 'react';
import type { AppSettings } from '@shared/types';
import { Toggle } from '../settings/controls';

type InjectionTab = 'skills' | 'agents' | 'claude-md';
type InjectionSettingKey =
  | 'injectAgentDeckClaudeSkills'
  | 'injectAgentDeckCodexSkills'
  | 'injectAgentDeckClaudeAgents'
  | 'injectAgentDeckCodexAgents'
  | 'injectAgentDeckClaudeMd'
  | 'injectAgentDeckCodexAgentsMd'
  | 'injectAgentDeckGrokSkills'
  | 'injectAgentDeckGrokAgents'
  | 'injectAgentDeckGrokAgentsMd';

const INJECTION_CONFIG: Record<
  InjectionTab,
  {
    assetLabel: string;
    claudeKey: InjectionSettingKey;
    codexKey: InjectionSettingKey;
    grokKey: InjectionSettingKey;
  }
> = {
  skills: {
    assetLabel: 'Skills',
    claudeKey: 'injectAgentDeckClaudeSkills',
    codexKey: 'injectAgentDeckCodexSkills',
    grokKey: 'injectAgentDeckGrokSkills',
  },
  agents: {
    assetLabel: 'Agents',
    claudeKey: 'injectAgentDeckClaudeAgents',
    codexKey: 'injectAgentDeckCodexAgents',
    grokKey: 'injectAgentDeckGrokAgents',
  },
  'claude-md': {
    assetLabel: '应用约定',
    claudeKey: 'injectAgentDeckClaudeMd',
    codexKey: 'injectAgentDeckCodexAgentsMd',
    grokKey: 'injectAgentDeckGrokAgentsMd',
  },
};

/** Injection settings affect only Agent Deck bundled assets in newly created sessions. */
export function InjectionToggleBar({
  tab,
  settings,
  update,
  readOnly = false,
}: {
  tab: InjectionTab;
  settings: AppSettings | null;
  update: (patch: Partial<AppSettings>) => Promise<void>;
  readOnly?: boolean;
}): JSX.Element {
  if (!settings) {
    return (
      <div className="mb-3 rounded-md border border-deck-border/60 bg-white/[0.02] p-2 text-[10px] text-deck-muted/60">
        读取设置中…
      </div>
    );
  }

  const config = INJECTION_CONFIG[tab];
  const description = `只控制 Agent Deck 内置 ${config.assetLabel}；用户和项目中的同类资产不受影响。仅对新建会话生效，已运行的会话不受影响。`;

  return (
    <div className="mb-3 rounded-md border border-deck-border/60 bg-white/[0.03] p-2">
      <div className="mb-1.5 text-[9px] font-semibold uppercase tracking-widest text-deck-muted/60">
        注入开关
      </div>
      <div className="flex flex-col gap-1.5">
        <Toggle
          label="注入到 Claude Code 会话"
          value={settings[config.claudeKey]}
          disabled={readOnly}
          onChange={(value) => void update({ [config.claudeKey]: value })}
        />
        <Toggle
          label="注入到 Codex CLI 会话"
          value={settings[config.codexKey]}
          disabled={readOnly}
          onChange={(value) => void update({ [config.codexKey]: value })}
        />
        <Toggle
          label="注入到 Grok Build 会话"
          value={settings[config.grokKey]}
          disabled={readOnly}
          onChange={(value) => void update({ [config.grokKey]: value })}
        />
        <div className="text-[10px] leading-snug text-deck-muted/60">
          {description}
        </div>
      </div>
    </div>
  );
}
