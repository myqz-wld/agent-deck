import { useEffect, useRef, useState, type JSX } from 'react';

import { AdapterSubTab, type AssetAdapter } from './AdapterSubTab';

interface Props {
  identity: string;
  label: string;
  profileId: string;
}

/** Read-only application conventions sourced exclusively from the selected Remote Worker. */
export function RemoteApplicationConventionTab({
  identity,
  label,
  profileId,
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
        setContent(result.content);
      })
      .catch(() => {
        if (seq !== requestSeqRef.current) return;
        setError('Worker 应用约定读取失败，请确认远端连接后重试。');
      });
    return () => {
      ++requestSeqRef.current;
    };
  }, [adapter, identity, profileId]);

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
        <pre
          aria-label={`${adapter} Remote 应用约定`}
          className="min-h-0 flex-1 overflow-y-auto scrollbar-deck whitespace-pre-wrap rounded border border-deck-border bg-white/[0.04] p-2 font-mono text-[10px] leading-relaxed text-deck-text"
          style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
        >
          {content}
        </pre>
      )}
    </div>
  );
}
