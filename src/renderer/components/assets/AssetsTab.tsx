import { useEffect, useState, type JSX } from 'react';
import type { AssetKind, AssetMeta } from '@shared/types';
import type { AssetAdapter } from './AdapterSubTab';
import { AssetCard } from './AssetCard';

interface Props {
  kind: AssetKind;
  adapter: AssetAdapter;
  bundled: AssetMeta[];
  user: AssetMeta[];
  sourceScope?: 'local' | 'remote';
  onView: (asset: AssetMeta) => void;
  onConfigureBundledAgent?: (asset: AssetMeta) => void;
}

const ASSET_PAGE_SIZE = 50;

/** Skills/Agents adapter-filtered view for bundled and user assets. */
export function AssetsTab({
  kind,
  adapter,
  bundled,
  user,
  sourceScope = 'local',
  onView,
  onConfigureBundledAgent,
}: Props): JSX.Element {
  const [bundledLimit, setBundledLimit] = useState(ASSET_PAGE_SIZE);
  const [userLimit, setUserLimit] = useState(ASSET_PAGE_SIZE);
  const filteredBundled = bundled.filter((asset) => asset.adapter === adapter);
  const filteredUser = user.filter((asset) => asset.adapter === adapter);
  const remote = sourceScope === 'remote';
  useEffect(() => {
    setBundledLimit(ASSET_PAGE_SIZE);
    setUserLimit(ASSET_PAGE_SIZE);
  }, [adapter, bundled, kind, user]);
  const userPathHint = remote
    ? null
    : adapter === 'claude-code'
      ? kind === 'agent'
        ? '~/.claude/agents/'
        : '~/.claude/skills/'
      : adapter === 'codex-cli' && kind === 'agent'
        ? '~/.codex/agents/'
        : adapter === 'codex-cli'
          ? '~/.codex/skills/'
          : kind === 'agent'
            ? '~/.grok/agents/'
            : '~/.grok/skills/';

  return (
    <div className="flex flex-col gap-3">
      <section>
        <div className="mb-1 text-[10px] uppercase tracking-wider text-deck-muted/70">
          {kind === 'agent' || remote ? '内置' : '内置（只读）'}
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
                showReadOnlyBadge={!remote}
                onConfigure={
                  kind === 'agent' ? onConfigureBundledAgent : undefined
                }
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

      {(remote || userPathHint) && (
        <section>
          <div className="mb-1 text-[10px] uppercase tracking-wider text-deck-muted/70">
            {remote ? '远端资产' : '用户与 Plugin（只读）'}
          </div>
          {userPathHint && (
            <div className="mb-1.5 text-[9px] text-deck-muted/55">
              直系目录：<code>{userPathHint}</code>
            </div>
          )}
          {filteredUser.length === 0 ? (
            <div className="text-[10px] text-deck-muted/60">
              {remote
                ? '当前远端环境中没有此类资产。'
                : `未发现资产。请通过 ${adapter === 'claude-code' ? 'Claude Code' : adapter === 'codex-cli' ? 'Codex CLI' : 'Grok Build'} 原生配置管理。`}
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {filteredUser.slice(0, userLimit).map((asset) => (
                <AssetCard
                  key={`${asset.adapter}:${asset.qualifiedName}:${asset.absPath}`}
                  asset={asset}
                  onView={onView}
                  showReadOnlyBadge={!remote}
                />
              ))}
              {filteredUser.length > userLimit && (
                <LoadMoreButton
                  remaining={filteredUser.length - userLimit}
                  onClick={() => setUserLimit((current) => current + ASSET_PAGE_SIZE)}
                />
              )}
            </div>
          )}
        </section>
      )}
    </div>
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
