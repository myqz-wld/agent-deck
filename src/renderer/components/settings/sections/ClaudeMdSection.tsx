import { type JSX } from 'react';
import type { AppSettings } from '@shared/types';
import { Section, Toggle } from '../controls';
import { ClaudeMdEditor } from '../ClaudeMdEditor';

interface Props {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => Promise<void>;
  onClaudeMdDirtyChange: (dirty: boolean) => void;
  onOpenAssetsLibrary: () => void;
}

/**
 * 「应用约定（CLAUDE.md）」section。
 *
 * 描述区瘦身（CHANGELOG_57 B5）：从「关闭后下次新建会话不再注入；已运行的会话已固化进 LLM
 * 上下文，关掉不会回收。」减到一句话同义；编辑器 + 「在资产库中查看」按钮分两个落点。
 *
 * dirty 契约：onClaudeMdDirtyChange 透传到 ClaudeMdEditor，父级 SettingsDialog 用 ref
 * 拦截关闭。**不要在中间加 useState 或 useCallback 一层**——会破坏 ref 同步性
 * （REVIEW_4 M11 教训）。父级用 useCallback 稳定 identity，子级直接消费。
 */
export function ClaudeMdSection({
  settings,
  update,
  onClaudeMdDirtyChange,
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
      <ClaudeMdEditor onDirtyChange={onClaudeMdDirtyChange} />
    </Section>
  );
}
