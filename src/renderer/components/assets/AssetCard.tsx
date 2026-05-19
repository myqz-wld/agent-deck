import { type JSX } from 'react';
import type { AssetMeta } from '@shared/types';

/**
 * 资产库 Dialog 单条 / 双角标 AssetCard（plan reviewer-codex-cross-adapter-20260519 §Phase 4
 * Step 4.1 抽出独立子组件）。
 *
 * 抽出动机：AssetsLibraryDialog.tsx 加 dual-adapter group dedup + badge 后突破单文件 ≤500 行
 * 阈值（538），按项目 CLAUDE.md「单文件大小护栏」选 1（抽 module-level pure function/子组件，
 * 风险最低）拆出 AssetCard + AdapterBadge + dedupBundledByName 三件零业务依赖的纯展示物到本
 * 文件，主文件回到 ~420 行。
 *
 * AssetCard 接 group（`AssetMeta[]`，1=single 或 2=dual-adapter SKILL）；display data 取 first
 * asset（dedupBundledByName 保证 claude-code 优先排序，dual-adapter SSOT 镜像 frontmatter 一致）。
 */

export function AssetCard({
  assets,
  onView,
  onEdit,
}: {
  /** 1=single（user / single-adapter bundled） 或 2=dual-adapter SKILL（同 kind+name 跨 adapter）。 */
  assets: AssetMeta[];
  onView: (assets: AssetMeta[]) => void;
  /** user-only edit；bundled 不传，dual-adapter SKILL 也不会有 edit（永远 bundled）。 */
  onEdit?: (asset: AssetMeta) => void;
}): JSX.Element {
  const first = assets[0];
  return (
    <div className="rounded-md border border-deck-border bg-white/[0.03] p-2">
      <div className="flex items-start justify-between gap-2">
        <code className="text-[11px] font-medium text-deck-text">{first.qualifiedName}</code>
        <div className="flex shrink-0 items-center gap-1 no-drag">
          {/* dual-adapter 双角标（仅当 group 含 ≥ 2 项跨 adapter 才显示，节省视觉空间） */}
          {assets.length > 1 && (
            <div className="flex gap-0.5">
              {assets.map((a) => (
                <AdapterBadge key={a.adapter ?? 'user'} adapter={a.adapter} />
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={() => onView(assets)}
            title="查看完整内容"
            className="rounded bg-white/8 px-1.5 py-0.5 text-[10px] text-deck-muted hover:bg-white/15 hover:text-deck-text"
          >
            查看
          </button>
          {onEdit && (
            <button
              type="button"
              onClick={() => onEdit(first)}
              title="编辑（删除入口在编辑器内）"
              className="rounded bg-white/8 px-1.5 py-0.5 text-[10px] text-deck-muted hover:bg-white/15 hover:text-deck-text"
            >
              编辑
            </button>
          )}
        </div>
      </div>
      {first.kind === 'agent' && (first.model || first.tools) && (
        <div className="mt-0.5 text-[10px] text-deck-muted/70">
          {first.model && <span>model: <code className="rounded bg-white/5 px-1">{first.model}</code> </span>}
          {first.tools && <span>tools: <code className="rounded bg-white/5 px-1">{first.tools}</code></span>}
        </div>
      )}
      {first.description && (
        <div className="mt-1 text-[10px] leading-relaxed text-deck-muted line-clamp-3">
          {first.description}
        </div>
      )}
      {first.triggers && first.triggers.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {first.triggers.map((t) => (
            <code key={t} className="rounded bg-white/5 px-1 text-[10px] text-deck-muted/80">{t}</code>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * dual-adapter 角标 chip（plan reviewer-codex-cross-adapter-20260519 §Phase 4 Step 4.1）。
 *
 * 仅在 dual-adapter SKILL group 内显示（同 kind+name 跨 adapter 合并为单条时显示「[claude]」+
 * 「[codex]」一对 chip）。改造后 agents 不再同 name 跨 adapter，每个 agent 单条单角标 ——
 * 单 group 不进 AdapterBadge 渲染分支（`assets.length > 1` 才显示）。
 */
export function AdapterBadge({ adapter }: { adapter: 'claude-code' | 'codex-cli' | null }): JSX.Element {
  const label = adapter === 'claude-code' ? '[claude]' : adapter === 'codex-cli' ? '[codex]' : '[user]';
  return (
    <code className="rounded bg-white/8 px-1 py-0.5 text-[9px] text-deck-muted/80">
      {label}
    </code>
  );
}

/**
 * bundled assets (kind+name) group dedup（plan reviewer-codex-cross-adapter-20260519 §Phase 4
 * Step 4.1）。同名同 kind 跨 adapter 合并为单 group，让 UI 单条双角标显示节省视觉空间。
 *
 * 排序约定（deterministic）：每组内 claude-code 先 / codex-cli 后 / user(null) 末尾。
 * default `[claude]` tab 按此排序自然落 first asset，与 ContentViewerModal default 选 first
 * adapter 对齐。
 *
 * 改造后（Phase 2 删 wrapper agent body 后）：
 * - bundled agents：reviewer-claude（claude-config 端 native）+ reviewer-codex（codex-config 端
 *   native）各只剩 1 份，自然单 group 单 asset，进 AssetCard 后 `assets.length === 1` 走旧 UI
 * - bundled skills：deep-review / hello-from-deck（Phase 3 build-time cp 两端 SSOT 镜像）每个
 *   形成 2-asset group，进 AssetCard 后 `assets.length === 2` 显示双角标
 */
export function dedupBundledByName(assets: AssetMeta[]): AssetMeta[][] {
  const groups = new Map<string, AssetMeta[]>();
  for (const a of assets) {
    const key = `${a.kind}:${a.name}`;
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
    }
    group.push(a);
  }
  // 每组按 adapter 排序：claude-code 先 / codex-cli 后 / null（user）末尾
  const order = (x: 'claude-code' | 'codex-cli' | null): number =>
    x === 'claude-code' ? 0 : x === 'codex-cli' ? 1 : 2;
  for (const group of groups.values()) {
    group.sort((a, b) => order(a.adapter) - order(b.adapter));
  }
  return Array.from(groups.values());
}
