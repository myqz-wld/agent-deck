import { type JSX } from 'react';
import type { AppSettings } from '@shared/types';
import { Section, Toggle } from '../controls';

interface Props {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => Promise<void>;
  onOpenAssetsLibrary: () => void;
}

/**
 * 「应用约定（CLAUDE.md）」section。
 *
 * CHANGELOG_58：编辑器整体迁到 AssetsLibraryDialog「应用约定」tab，本 section 只剩注入
 * toggle + 跳资产库的链接，与下面 PluginAssetsSection 的「在资产库中查看」按钮文案对齐。
 *
 * 之所以保留 toggle 而不是连这个一起搬走：toggle 是「设置」语义（控制下次会话是否注入），
 * 编辑器是「内容」语义（编辑要注入的 markdown），分别属于「设置」和「资产」两个心智模型。
 */
export function ClaudeMdSection({
  settings,
  update,
  onOpenAssetsLibrary,
}: Props): JSX.Element {
  return (
    <Section title="应用约定（CLAUDE.md）" storageKey="claudemd" defaultOpen={false}>
      <Toggle
        label="启用 agent-deck CLAUDE.md 注入"
        value={settings.injectAgentDeckClaudeMd}
        onChange={(v) => void update({ injectAgentDeckClaudeMd: v })}
      />
      <div className="text-[10px] leading-snug text-deck-muted/70">
        关闭后下次新建会话不再注入；已运行的会话已固化进 LLM 上下文，关掉不会回收。
        编辑「应用约定」内容请到资产库。
      </div>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onOpenAssetsLibrary}
          className="no-drag rounded bg-white/8 px-2 py-0.5 text-[10px] text-deck-muted hover:bg-white/15 hover:text-deck-text"
          title="在资产库中查看（含内置 + 用户自定义 agents/skills/CLAUDE.md）"
        >
          在资产库中查看 ↗
        </button>
      </div>
    </Section>
  );
}
