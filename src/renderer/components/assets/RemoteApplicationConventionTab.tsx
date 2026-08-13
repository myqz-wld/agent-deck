import { useEffect, useRef, useState, type JSX } from 'react';

import { ReadOnlyConventionDocument } from '../settings/b18/ConventionDocumentEditor';
import { AdapterSubTab, type AssetAdapter } from './AdapterSubTab';

const ADAPTER_NAMES = {
  'claude-code': 'Claude Code',
  'codex-cli': 'Codex CLI',
  'grok-build': 'Grok Build',
} as const;

interface Props {
  catalogRevision: number | null;
  identity: string;
  label: string;
  profileId: string;
  onCatalogChanged(): void;
}

/** Read-only application conventions sourced exclusively from the selected Remote Worker. */
export function RemoteApplicationConventionTab({
  catalogRevision,
  identity,
  label,
  profileId,
  onCatalogChanged,
}: Props): JSX.Element {
  const [adapter, setAdapter] = useState<AssetAdapter>('claude-code');
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestSeqRef = useRef(0);

  useEffect(() => {
    const seq = ++requestSeqRef.current;
    setContent(null);
    setError(null);
    void window.api.getRemoteHostNodeAssetConvention({ profileId, adapterId: adapter })
      .then((result) => {
        if (seq !== requestSeqRef.current) return;
        if (result.adapterId !== adapter || result.revision !== catalogRevision) {
          setError('远端资产已更新，请稍后重试。');
          onCatalogChanged();
          return;
        }
        setContent(result.content);
      })
      .catch(() => {
        if (seq !== requestSeqRef.current) return;
        setError('应用约定读取失败，请检查远端连接后重试。');
      });
    return () => {
      ++requestSeqRef.current;
    };
  }, [adapter, catalogRevision, identity, onCatalogChanged, profileId]);

  return (
    <div className="flex min-h-[310px] flex-col gap-2">
      <AdapterSubTab current={adapter} onSelect={setAdapter} showGrok />
      {error ? (
        <div className="rounded border border-status-waiting/40 bg-status-waiting/10 p-2 text-[11px] text-status-waiting">
          {error}
        </div>
      ) : content === null ? (
        <div className="text-[11px] text-deck-muted">正在读取应用约定…</div>
      ) : (
        <ReadOnlyConventionDocument
          adapter={adapter}
          adapterName={ADAPTER_NAMES[adapter]}
          content={content}
          description={`当前显示「${label}」的应用约定；新建会话会使用这份内容。`}
          identity={identity}
        />
      )}
    </div>
  );
}
