/**
 * 「Codex 注入」section（CHANGELOG_<X> D4）。
 *
 * 与 ClaudeMd / PluginAssets 平行：控制 Agent Deck 在 codex 一侧（`~/.codex/`）的
 * 自动注入。两个 toggle：
 *
 * 1. AGENTS.md 注入：把内置 CLAUDE.md 内容同步到 `~/.codex/AGENTS.md` 的 marker 段
 *    （CHANGELOG_<X> D1）。
 * 2. skills 同步：把内置 plugin skills 镜像到 `~/.codex/skills/agent-deck/`
 *    （CHANGELOG_<X> D2）。
 *
 * 注入的 CLAUDE.md 内容跟 claude 一侧共享同一份用户副本 / 内置回落 ——
 * 编辑请到资产库「应用约定」tab。
 *
 * 关闭后**移除**对应的 marker 段 / agent-deck 子目录（保留用户在 ~/.codex/AGENTS.md
 * 或 ~/.codex/skills/ 的其他内容）。
 */
import { type JSX } from 'react';
import type { AppSettings } from '@shared/types';
import { Section, Toggle } from '../controls';

interface Props {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => Promise<void>;
}

export function CodexInjectionSection({ settings, update }: Props): JSX.Element {
  return (
    <Section title="Codex 注入" storageKey="codex-injection" defaultOpen={false}>
      <Toggle
        label="AGENTS.md 注入到 ~/.codex/AGENTS.md"
        value={settings.injectAgentDeckCodexAgentsMd}
        onChange={(v) => void update({ injectAgentDeckCodexAgentsMd: v })}
      />
      <div className="text-[10px] leading-snug text-deck-muted/70">
        把内置「应用约定」（与 claude 端共享）写到 codex 一侧的{' '}
        <code className="rounded bg-white/5 px-1">~/.codex/AGENTS.md</code> 的{' '}
        <code className="rounded bg-white/5 px-1">&lt;!-- === Agent Deck === --&gt;</code>{' '}
        marker 段。**用户手写的其他段严格保留**（marker 之外不动）。
      </div>
      <Toggle
        label="Skills 同步到 ~/.codex/skills/agent-deck/"
        value={settings.injectAgentDeckCodexSkills}
        onChange={(v) => void update({ injectAgentDeckCodexSkills: v })}
      />
      <div className="text-[10px] leading-snug text-deck-muted/70">
        镜像 Agent Deck 内置 plugin 的 skills（含 deep-code-review / hello-from-deck）
        到 codex 端，让 codex 会话也能{' '}
        <code className="rounded bg-white/5 px-1">/agent-deck:&lt;skill&gt;</code>{' '}
        触发同名 skill。
      </div>
      <div className="text-[10px] leading-snug text-deck-muted/60 mt-1">
        改后**下次新建 codex 会话**生效；已 spawn 的 thread 已加载当时的 AGENTS.md /
        skills，关掉不会回收。
      </div>
    </Section>
  );
}
