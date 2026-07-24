import type { JSX } from 'react';
import type { AssetKind, AssetMeta } from '@shared/types';
import type { AssetAdapter } from './AdapterSubTab';
import { AssetCard } from './AssetCard';
import { PlusIcon } from '../icons';

interface Props {
  kind: AssetKind;
  adapter: AssetAdapter;
  bundled: AssetMeta[];
  user: AssetMeta[];
  onView: (asset: AssetMeta) => void;
  onEdit: (asset: AssetMeta) => void;
  onNew?: () => void;
}

/** Skills/Agents adapter-filtered view for bundled and user assets. */
export function AssetsTab({
  kind,
  adapter,
  bundled,
  user,
  onView,
  onEdit,
  onNew,
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
          : null;

  return (
    <div className="flex flex-col gap-3">
      <section>
        <div className="mb-1 text-[10px] uppercase tracking-wider text-deck-muted/70">
          内置（只读）
        </div>
        {filteredBundled.length === 0 ? (
          <div className="text-[10px] text-deck-muted/60">（无）</div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {filteredBundled.map((asset) => (
              <AssetCard
                key={`${asset.adapter}:${asset.qualifiedName}`}
                asset={asset}
                onView={onView}
              />
            ))}
          </div>
        )}
      </section>

      {adapter !== 'grok-build' && userPathHint && (
        <section>
          <div className="mb-1 flex items-center justify-between">
            <div className="text-[10px] uppercase tracking-wider text-deck-muted/70">
              用户自定义（{userPathHint}）
            </div>
            <button
              type="button"
              onClick={onNew}
              className="rounded bg-status-working/15 px-2 py-0.5 text-[10px] text-status-working hover:bg-status-working/25"
            >
              <PlusIcon className="mr-1 inline h-3 w-3" />新建
              {kind === 'agent' ? ' Agent' : ' Skill'}
            </button>
          </div>
          {filteredUser.length === 0 ? (
            <div className="text-[10px] text-deck-muted/60">
              暂无。点右上「新建」可创建第一个{kind === 'agent' ? ' Agent' : ' Skill'}
              ，文件会保存到 {userPathHint}
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {filteredUser.map((asset) => (
                <AssetCard
                  key={`${asset.adapter}:${asset.qualifiedName}`}
                  asset={asset}
                  onView={onView}
                  onEdit={onEdit}
                />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
