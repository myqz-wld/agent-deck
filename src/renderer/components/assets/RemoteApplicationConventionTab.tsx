import { useEffect, useRef, useState, type JSX } from 'react';

import { ReadOnlyConventionDocument } from '../settings/b18/ConventionDocumentEditor';
import { AdapterSubTab, type AssetAdapter } from './AdapterSubTab';
import {
  useDeferredPendingIdentity,
  useInitialAsyncPresentation,
} from '@renderer/hooks/useDelayedAsyncFallback';

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

interface ConventionProjection {
  adapter: AssetAdapter;
  content: string;
  requestIdentity: string;
}

interface ConventionError {
  message: string;
  requestIdentity: string;
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
  const [projection, setProjection] = useState<ConventionProjection | null>(null);
  const [error, setError] = useState<ConventionError | null>(null);
  const requestSeqRef = useRef(0);
  const requestIdentity = `${identity}:${catalogRevision ?? 'none'}:${adapter}`;
  const currentError = error?.requestIdentity === requestIdentity ? error.message : null;
  const pending = projection?.requestIdentity !== requestIdentity && currentError === null;
  const visibleIdentity = useDeferredPendingIdentity(pending, requestIdentity);
  const initialPresentation = useInitialAsyncPresentation(
    projection === null && pending,
    requestIdentity,
  );
  const visibleProjection = projection?.requestIdentity === visibleIdentity ? projection : null;

  useEffect(() => {
    const seq = ++requestSeqRef.current;
    void window.api.getRemoteHostNodeAssetConvention({ profileId, adapterId: adapter })
      .then((result) => {
        if (seq !== requestSeqRef.current) return;
        if (result.adapterId !== adapter || result.revision !== catalogRevision) {
          setError({ requestIdentity, message: '远端资产已更新，请稍后重试。' });
          onCatalogChanged();
          return;
        }
        setProjection({ adapter, content: result.content, requestIdentity });
        setError(null);
      })
      .catch(() => {
        if (seq !== requestSeqRef.current) return;
        setError({
          requestIdentity,
          message: '应用约定读取失败，请检查远端连接后重试。',
        });
      });
    return () => {
      ++requestSeqRef.current;
    };
  }, [adapter, catalogRevision, identity, onCatalogChanged, profileId, requestIdentity]);

  return (
    <div className="flex min-h-[310px] flex-col gap-2">
      <AdapterSubTab current={adapter} onSelect={setAdapter} showGrok />
      {currentError ? (
        <div className="rounded border border-status-waiting/40 bg-status-waiting/10 p-2 text-[11px] text-status-waiting">
          {currentError}
        </div>
      ) : visibleProjection ? (
        <ReadOnlyConventionDocument
          adapter={visibleProjection.adapter}
          adapterName={ADAPTER_NAMES[visibleProjection.adapter]}
          content={visibleProjection.content}
          description={`当前显示「${label}」的应用约定；新建会话会使用这份内容。`}
          identity={`${identity}:${visibleProjection.requestIdentity}`}
        />
      ) : initialPresentation === 'deferred' ? (
        <div className="min-h-[1rem]" aria-hidden="true" />
      ) : (
        <div className="text-[11px] text-deck-muted">正在读取应用约定…</div>
      )}
    </div>
  );
}
