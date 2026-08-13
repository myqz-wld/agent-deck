import { type JSX } from 'react';
import type { AssetMeta } from '@shared/types';
import { EyeIcon, PencilIcon } from '../icons';

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
  onConfigure,
  showReadOnlyBadge = true,
}: {
  /** 单条 AssetMeta（user / bundled 同款，按所在 sub-tab 单 adapter 视图）。 */
  asset: AssetMeta;
  onView: (asset: AssetMeta) => void;
  /** bundled Agent only：只改 app-owned model/thinking/provider 差异。 */
  onConfigure?: (asset: AssetMeta) => void;
  showReadOnlyBadge?: boolean;
}): JSX.Element {
  return (
    <div className="min-w-0 overflow-hidden rounded-md border border-deck-border bg-white/[0.03] p-2">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <code className="min-w-0 flex-1 break-all text-[11px] font-medium text-deck-text">
          {asset.qualifiedName}
        </code>
        <div className="flex max-w-[60%] shrink-0 flex-wrap items-center justify-end gap-1 no-drag">
          {asset.pluginName && (
            <span
              className="max-w-32 truncate rounded bg-white/5 px-1.5 py-0.5 text-[9px] text-deck-muted/70"
              title={`Plugin · ${asset.pluginName}`}
            >
              Plugin · {asset.pluginName}
            </span>
          )}
          {showReadOnlyBadge && asset.source === 'user' && (
            <span className="rounded bg-white/5 px-1.5 py-0.5 text-[9px] text-deck-muted/70">
              只读
            </span>
          )}
          <button
            type="button"
            onClick={() => onView(asset)}
            title="查看完整内容"
            className="rounded bg-white/8 px-1.5 py-0.5 text-[10px] text-deck-muted hover:bg-white/15 hover:text-deck-text"
          >
            <EyeIcon className="mr-1 inline h-3 w-3" />查看
          </button>
          {onConfigure && (
            <button
              type="button"
              onClick={() => onConfigure(asset)}
              title="配置内置 Agent 的模型、思考等级和 provider"
              className="rounded bg-white/8 px-1.5 py-0.5 text-[10px] text-deck-muted hover:bg-white/15 hover:text-deck-text"
            >
              <PencilIcon className="mr-1 inline h-3 w-3" />配置
            </button>
          )}
        </div>
      </div>
      {asset.kind === 'agent' && (asset.model || asset.thinking || asset.provider || asset.tools) && (
        <div className="mt-0.5 text-[10px] text-deck-muted/70">
          {asset.model && <span>模型：<code className="rounded bg-white/5 px-1">{asset.model}</code> </span>}
          {asset.thinking && <span>思考程度：<code className="rounded bg-white/5 px-1">{asset.thinking}</code> </span>}
          {asset.provider && (
            <span>
              {asset.adapter === 'claude-code' ? 'gateway' : 'provider'}：
              <code className="rounded bg-white/5 px-1">{asset.provider}</code>{' '}
            </span>
          )}
          {asset.tools && <span>工具：<code className="rounded bg-white/5 px-1">{asset.tools}</code></span>}
        </div>
      )}
      {asset.bundledAgentRuntime && Object.keys(asset.bundledAgentRuntime.override).length > 0 && (
        <div className="mt-1 text-[9px] text-status-working">已修改内建 Agent</div>
      )}
      {asset.origin === 'plugin' && asset.kind === 'agent' && asset.runtimeName && (
        <div className="mt-1 text-[9px] text-deck-muted/65">
          启动名：<code className="rounded bg-white/5 px-1">{asset.runtimeName}</code>
        </div>
      )}
      {asset.description && (
        <div className="mt-1 line-clamp-3 break-words text-[10px] leading-relaxed text-deck-muted [overflow-wrap:anywhere]">
          {asset.description}
        </div>
      )}
    </div>
  );
}
