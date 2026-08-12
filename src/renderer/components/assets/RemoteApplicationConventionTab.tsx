import { useEffect, useRef, useState, type JSX } from 'react';

import { AdapterSubTab, type AssetAdapter } from './AdapterSubTab';
import { BoundedTextPreview } from './BoundedTextPreview';

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
          setError('Worker 资产目录已更新，正在重新读取；请稍后重试。');
          onCatalogChanged();
          return;
        }
        setContent(result.content);
      })
      .catch(() => {
        if (seq !== requestSeqRef.current) return;
        setError('Worker 应用约定读取失败，请确认远端连接后重试。');
      });
    return () => {
      ++requestSeqRef.current;
    };
  }, [adapter, catalogRevision, identity, onCatalogChanged, profileId]);

  return (
    <div className="flex min-h-[310px] flex-col gap-2">
      <AdapterSubTab current={adapter} onSelect={setAdapter} showGrok />
      <div className="text-[10px] leading-snug text-deck-muted/70">
        当前内容来自 Remote Worker「{label}」的打包资源，并实际注入该 Worker 新建的对应会话；远端协议当前只读。
      </div>
      {error ? (
        <div className="rounded border border-status-waiting/40 bg-status-waiting/10 p-2 text-[11px] text-status-waiting">
          {error}
        </div>
      ) : content === null ? (
        <div className="text-[11px] text-deck-muted">读取 Worker 应用约定中…</div>
      ) : (
        <BoundedTextPreview content={content} ariaLabel={`${adapter} Remote 应用约定`} />
      )}
    </div>
  );
}
