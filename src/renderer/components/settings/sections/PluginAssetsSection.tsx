import { type JSX } from 'react';
import type { AppSettings } from '@shared/types';
import { Section, Toggle } from '../controls';

interface Props {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => Promise<void>;
  onOpenAssetsLibrary: () => void;
}

/**
 * 「内置 Skill 与 Agent（agent-deck plugin）」section。
 *
 * 描述区瘦身（CHANGELOG_57 B5）：原本整段在罗列 deep-code-review / reviewer-claude /
 * reviewer-codex 是干啥（用户在设置面板里看不懂这些技术名字），改为一句话 + header
 * 「📚 资产库」按钮跳转到 AssetsLibraryDialog 看完整列表 + 触发关键词 + frontmatter
 * 元数据。
 */
export function PluginAssetsSection({ settings, update, onOpenAssetsLibrary }: Props): JSX.Element {
  return (
    <Section
      title="内置 Skill 与 Agent（agent-deck plugin）"
      storageKey="plugin"
      defaultOpen={false}
    >
      <Toggle
        label="启用 agent-deck plugin 注入（skill + agents 绑定生效）"
        value={settings.injectAgentDeckPlugin}
        onChange={(v) => void update({ injectAgentDeckPlugin: v })}
      />
      <div className="text-[10px] leading-snug text-deck-muted/70">
        关闭后下次新建会话不再注入 agent-deck plugin（含内置 skill 与 reviewer 子 agent）。
        已运行的会话已经在启动时拿到 plugin 列表，关掉不会撤销。
      </div>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onOpenAssetsLibrary}
          className="no-drag rounded bg-white/8 px-2 py-0.5 text-[10px] text-deck-muted hover:bg-white/15 hover:text-deck-text"
          title="查看内置 skill / agent 完整清单与触发关键词"
        >
          查看内置资产 ↗
        </button>
      </div>
    </Section>
  );
}
