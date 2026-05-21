import { type JSX } from 'react';
import type { AssetMeta } from '@shared/types';

/**
 * 资产库 Dialog 单条 AssetCard（plan assets-codex-user-and-ui-unify-20260521 §D6 简化:
 * 删 dedupBundledByName / NonEmptyAssetGroup / AdapterBadge 三件物,各 sub-tab 单 adapter 视图
 * 内 bundled / user 资产都是单条独立显示;同名跨 adapter 资产由 sub-tab 切换分别显)。
 *
 * 历史背景（已废弃）：plan reviewer-codex-cross-adapter-20260519 §Phase 4 Step 4.1 抽出双角标
 * 合并 UI。assets-codex-user-and-ui-unify-20260521 §Q1 用户答「全部 sub-tab 切换」后双角标合并
 * 不再适用 — Skills/Agents/应用约定 三 tab 全 sub-tab 切换，每条 AssetMeta 单条单角标显示。
 */

export function AssetCard({
  asset,
  onView,
  onEdit,
}: {
  /** 单条 AssetMeta（user / bundled 同款，按所在 sub-tab 单 adapter 视图）。 */
  asset: AssetMeta;
  onView: (asset: AssetMeta) => void;
  /** user-only edit；bundled 不传。 */
  onEdit?: (asset: AssetMeta) => void;
}): JSX.Element {
  return (
    <div className="rounded-md border border-deck-border bg-white/[0.03] p-2">
      <div className="flex items-start justify-between gap-2">
        <code className="text-[11px] font-medium text-deck-text">{asset.qualifiedName}</code>
        <div className="flex shrink-0 items-center gap-1 no-drag">
          <button
            type="button"
            onClick={() => onView(asset)}
            title="查看完整内容"
            className="rounded bg-white/8 px-1.5 py-0.5 text-[10px] text-deck-muted hover:bg-white/15 hover:text-deck-text"
          >
            查看
          </button>
          {onEdit && (
            <button
              type="button"
              onClick={() => onEdit(asset)}
              title="编辑（删除入口在编辑器内）"
              className="rounded bg-white/8 px-1.5 py-0.5 text-[10px] text-deck-muted hover:bg-white/15 hover:text-deck-text"
            >
              编辑
            </button>
          )}
        </div>
      </div>
      {asset.kind === 'agent' && (asset.model || asset.tools) && (
        <div className="mt-0.5 text-[10px] text-deck-muted/70">
          {asset.model && <span>model: <code className="rounded bg-white/5 px-1">{asset.model}</code> </span>}
          {asset.tools && <span>tools: <code className="rounded bg-white/5 px-1">{asset.tools}</code></span>}
        </div>
      )}
      {asset.description && (
        <div className="mt-1 text-[10px] leading-relaxed text-deck-muted line-clamp-3">
          {asset.description}
        </div>
      )}
      {asset.triggers && asset.triggers.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {asset.triggers.map((t) => (
            <code key={t} className="rounded bg-white/5 px-1 text-[10px] text-deck-muted/80">{t}</code>
          ))}
        </div>
      )}
    </div>
  );
}
