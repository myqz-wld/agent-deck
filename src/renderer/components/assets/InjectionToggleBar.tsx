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
  | 'injectAgentDeckCodexAgentsMd';

const INJECTION_CONFIG: Record<
  InjectionTab,
  { assetLabel: string; claudeKey: InjectionSettingKey; codexKey: InjectionSettingKey }
> = {
  skills: {
    assetLabel: 'Skills',
    claudeKey: 'injectAgentDeckClaudeSkills',
    codexKey: 'injectAgentDeckCodexSkills',
  },
  agents: {
    assetLabel: 'Agents',
    claudeKey: 'injectAgentDeckClaudeAgents',
    codexKey: 'injectAgentDeckCodexAgents',
  },
  'claude-md': {
    assetLabel: '应用约定',
    claudeKey: 'injectAgentDeckClaudeMd',
    codexKey: 'injectAgentDeckCodexAgentsMd',
  },
};

/**
 * 资产库三 tab 顶部的「资产注入开关」横条（CHANGELOG_69）。
 *
 * 把原 SettingsDialog 三个资产 section（ClaudeMdSection / PluginAssetsSection /
 * CodexInjectionSection）的资产注入 toggle 整体迁来，按 tab 维度分发：
 *
 * - skills tab：claude 端 plugin skills 子目录 + codex 端 skills extraRoot 注入
 * - agents tab：claude 端 plugin agents 子目录 + codex 端 bundled custom agents 解析
 * - claude-md tab：claude 端 system prompt 注入 + codex 端 developerInstructions 注入
 *
 * 设计：
 * - 「资产编辑 + 注入开关」单一真源（资产库），与设置面板彻底解耦
 * - settings null 时显示 placeholder 不报错（mount 期间 fetch 未回）
 * - busy 期不 disable toggle UI（避免 toggle 在等 IPC 时变灰，体验割裂；
 *   update 内部已有 dedup seq 防止旧响应回写）
 */
export function InjectionToggleBar({
  tab,
  settings,
  update,
}: {
  tab: InjectionTab;
  settings: AppSettings | null;
  update: (patch: Partial<AppSettings>) => Promise<void>;
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
          label="注入到 Claude 会话"
          value={settings[config.claudeKey]}
          onChange={(value) => void update({ [config.claudeKey]: value })}
        />
        <Toggle
          label="注入到 Codex 会话"
          value={settings[config.codexKey]}
          onChange={(value) => void update({ [config.codexKey]: value })}
        />
        <div className="text-[10px] leading-snug text-deck-muted/60">
          {description}
        </div>
      </div>
    </div>
  );
}
