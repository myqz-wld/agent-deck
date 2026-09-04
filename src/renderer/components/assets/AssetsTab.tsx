import { useEffect, useState, type JSX } from 'react';
import type { AssetKind, AssetMeta } from '@shared/types';
import type { AssetAdapter } from './AdapterSubTab';
import { AssetCard } from './AssetCard';

interface Props {
  kind: AssetKind;
  adapter: AssetAdapter;
  bundled: AssetMeta[];
  onView: (asset: AssetMeta) => void;
  onConfigureBundledAgent?: (asset: AssetMeta) => void;
}

const ASSET_PAGE_SIZE = 50;

/** Skills/Agents adapter-filtered view for Agent Deck bundled assets. */
export function AssetsTab({
  kind,
  adapter,
  bundled,
  onView,
  onConfigureBundledAgent,
}: Props): JSX.Element {
  const [bundledLimit, setBundledLimit] = useState(ASSET_PAGE_SIZE);
  const filteredBundled = bundled.filter((asset) => asset.adapter === adapter);
  useEffect(() => {
    setBundledLimit(ASSET_PAGE_SIZE);
  }, [adapter, bundled, kind]);

  return (
    <section>
      <div className="mb-1 text-[10px] uppercase tracking-wider text-deck-muted/70">
        {kind === 'agent' ? '内置' : '内置（只读）'}
      </div>
      {filteredBundled.length === 0 ? (
        <div className="text-[10px] text-deck-muted/60">（无）</div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {filteredBundled.slice(0, bundledLimit).map((asset) => (
            <AssetCard
              key={`${asset.adapter}:${asset.qualifiedName}:${asset.absPath}`}
              asset={asset}
              onView={onView}
              onConfigure={kind === 'agent' ? onConfigureBundledAgent : undefined}
            />
          ))}
          {filteredBundled.length > bundledLimit && (
            <LoadMoreButton
              remaining={filteredBundled.length - bundledLimit}
              onClick={() => setBundledLimit((current) => current + ASSET_PAGE_SIZE)}
            />
          )}
        </div>
      )}
    </section>
  );
}

function LoadMoreButton({ remaining, onClick }: { remaining: number; onClick(): void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="self-start rounded bg-white/8 px-2 py-1 text-[10px] text-deck-muted hover:bg-white/15 hover:text-deck-text"
    >
      再显示 {Math.min(ASSET_PAGE_SIZE, remaining)} 项
    </button>
  );
}
