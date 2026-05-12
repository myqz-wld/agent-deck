import { type JSX } from 'react';
import type { AppSettings } from '@shared/types';
import { Toggle } from '../settings/controls';

/**
 * 资产库三 tab 顶部的「资产注入开关」横条（CHANGELOG_69）。
 *
 * 把原 SettingsDialog 三个资产 section（ClaudeMdSection / PluginAssetsSection /
 * CodexInjectionSection）的 5 个 toggle 整体迁来，按 tab 维度分发：
 *
 * - skills tab：claude 端 plugin 注入 + codex 端 skills 镜像
 * - agents tab：claude 端 plugin 注入（与 skills tab 是同一 settings key 的两个入口，
 *   状态自动同步——React 重渲染保证一致性，无需额外同步代码）
 * - claude-md tab：claude 端 system prompt 注入 + codex 端 AGENTS.md 同步
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
  tab: 'skills' | 'agents' | 'claude-md';
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

  return (
    <div className="mb-3 rounded-md border border-deck-border/60 bg-white/[0.03] p-2">
      <div className="mb-1.5 text-[9px] font-semibold uppercase tracking-widest text-deck-muted/60">
        注入开关
      </div>
      {tab === 'skills' && (
        <div className="flex flex-col gap-1.5">
          <Toggle
            label="注入到 Claude 会话（agent-deck plugin，含 skills + agents）"
            value={settings.injectAgentDeckPlugin}
            onChange={(v) => void update({ injectAgentDeckPlugin: v })}
          />
          <Toggle
            label="同步到 ~/.codex/skills/agent-deck/（Codex 会话）"
            value={settings.injectAgentDeckCodexSkills}
            onChange={(v) => void update({ injectAgentDeckCodexSkills: v })}
          />
          <div className="text-[10px] leading-snug text-deck-muted/60">
            关闭后**下次新建会话**不再注入；已运行会话已固化注入列表，关掉不会撤销。
          </div>
        </div>
      )}
      {tab === 'agents' && (
        <div className="flex flex-col gap-1.5">
          <Toggle
            label="注入到 Claude 会话（agent-deck plugin，含 skills + agents）"
            value={settings.injectAgentDeckPlugin}
            onChange={(v) => void update({ injectAgentDeckPlugin: v })}
          />
          <div className="text-[10px] leading-snug text-deck-muted/60">
            agents 与 skills 共用同一个 plugin 注入开关（在「Skills」tab 切换效果一致）。
            关闭后**下次新建会话**不再注入；已运行会话已固化注入列表。
          </div>
        </div>
      )}
      {tab === 'claude-md' && (
        <div className="flex flex-col gap-1.5">
          <Toggle
            label="注入到 Claude 会话（system prompt 末尾）"
            value={settings.injectAgentDeckClaudeMd}
            onChange={(v) => void update({ injectAgentDeckClaudeMd: v })}
          />
          <Toggle
            label="同步到 ~/.codex/AGENTS.md（marker 段，保留用户其他段）"
            value={settings.injectAgentDeckCodexAgentsMd}
            onChange={(v) => void update({ injectAgentDeckCodexAgentsMd: v })}
          />
          <div className="text-[10px] leading-snug text-deck-muted/60">
            关闭后**下次新建会话**不再注入；已运行会话已固化进 LLM 上下文，关掉不会回收。
          </div>
        </div>
      )}
    </div>
  );
}
