import type { JSX } from 'react';
import type { AssetKind, AssetMeta } from '@shared/types';
import type { AssetAdapter } from './AdapterSubTab';
import { AssetCard } from './AssetCard';

interface Props {
  kind: AssetKind;
  adapter: AssetAdapter;
  bundled: AssetMeta[];
  user: AssetMeta[];
  onView: (asset: AssetMeta) => void;
  onConfigureBundledAgent?: (asset: AssetMeta) => void;
}

/** Skills/Agents adapter-filtered view for bundled and user assets. */
export function AssetsTab({
  kind,
  adapter,
  bundled,
  user,
  onView,
  onConfigureBundledAgent,
}: Props): JSX.Element {
  const filteredBundled = bundled.filter((asset) => asset.adapter === adapter);
  const filteredUser = user.filter((asset) => asset.adapter === adapter);
  const userPathHint =
    adapter === 'claude-code'
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
          {kind === 'agent' ? '内置' : '内置（只读）'}
        </div>
        {filteredBundled.length === 0 ? (
          <div className="text-[10px] text-deck-muted/60">（无）</div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {filteredBundled.map((asset) => (
              <AssetCard
                key={`${asset.adapter}:${asset.qualifiedName}:${asset.absPath}`}
                asset={asset}
                onView={onView}
                onConfigure={
                  kind === 'agent' ? onConfigureBundledAgent : undefined
                }
              />
            ))}
          </div>
        )}
      </section>

      {userPathHint && (
        <section>
          <div className="mb-1 text-[10px] uppercase tracking-wider text-deck-muted/70">
            用户与 Plugin（只读）
          </div>
          <div className="mb-1.5 text-[9px] text-deck-muted/55">
            直系目录：<code>{userPathHint}</code>
          </div>
          {filteredUser.length === 0 ? (
            <div className="text-[10px] text-deck-muted/60">
              未发现资产。请通过 {adapter === 'claude-code' ? 'Claude Code' : adapter === 'codex-cli' ? 'Codex CLI' : 'Grok Build'} 原生配置管理。
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {filteredUser.map((asset) => (
                <AssetCard
                  key={`${asset.adapter}:${asset.qualifiedName}:${asset.absPath}`}
                  asset={asset}
                  onView={onView}
                />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
