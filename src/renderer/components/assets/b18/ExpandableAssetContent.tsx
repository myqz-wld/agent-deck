import {
  useEffect,
  useRef,
  useState,
  type JSX,
} from 'react';
import log from '@renderer/utils/logger';
import type { AssetMeta } from '@shared/types';
import {
  ExpandableContent,
  type DiagnosticContentPayload,
} from '../../expandable-content';
import { AssetCard } from '../AssetCard';

const logger = log.scope('renderer-expandable-asset-content');

function safeErrorKind(reason: unknown): 'function' | 'null' | 'object' | 'primitive' | 'string' {
  if (reason === null) return 'null';
  if (typeof reason === 'object') return 'object';
  if (typeof reason === 'string') return 'string';
  if (typeof reason === 'function') return 'function';
  return 'primitive';
}

export function ExpandableAssetContent({
  asset,
  onView,
  onConfigure,
}: {
  asset: AssetMeta;
  onView: (asset: AssetMeta) => void;
  onConfigure?: (asset: AssetMeta) => void;
}): JSX.Element {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const requestSequenceRef = useRef(0);

  useEffect(() => () => {
    requestSequenceRef.current += 1;
  }, []);

  const loadContent = async (): Promise<void> => {
    const sequence = ++requestSequenceRef.current;
    setContent(null);
    setError(false);
    try {
      const result = await window.api.getAssetContent(
        asset.kind,
        asset.name,
        asset.source,
        asset.adapter,
        asset.absPath,
      );
      if (sequence !== requestSequenceRef.current) return;
      if (result.ok) {
        setContent(result.content);
      } else {
        logger.error('asset content read failed', {
          action: 'read',
          adapter: asset.adapter,
          assetKind: asset.kind,
          assetSource: asset.source,
          category: 'backend-rejected',
        });
        setError(true);
      }
    } catch (reason) {
      if (sequence === requestSequenceRef.current) {
        logger.error('asset content read failed', {
          action: 'read',
          adapter: asset.adapter,
          assetKind: asset.kind,
          assetSource: asset.source,
          category: 'request-rejected',
          errorKind: safeErrorKind(reason),
        });
        setError(true);
      }
    }
  };

  const payload: DiagnosticContentPayload = {
    kind: 'diagnostic',
    text: content ?? '',
    severity: error ? 'error' : 'info',
    metadata: {
      adapter: asset.adapter,
      assetKind: asset.kind,
      assetSource: asset.source,
      qualifiedName: asset.qualifiedName,
      loading: content === null && !error,
    },
  };

  return (
    <div className="relative min-w-0 pr-12">
      <AssetCard asset={asset} onView={onView} onConfigure={onConfigure} />
      <ExpandableContent<DiagnosticContentPayload>
        identity={{
          sessionId: `asset-library:${asset.adapter}`,
          kind: 'diagnostic',
          diagnosticId: `${asset.kind}:${asset.source}:${asset.qualifiedName}`,
        }}
        payload={payload}
        title={`${asset.qualifiedName} 完整内容`}
        triggerLabel={`展开查看 ${asset.qualifiedName} 完整内容`}
        onOpenChange={(open) => {
          if (open) {
            void loadContent();
          } else {
            requestSequenceRef.current += 1;
            setContent(null);
            setError(false);
          }
        }}
      >
        {({ payload: expandedPayload }) => {
          if (error) {
            return (
              <div
                role="alert"
                className="flex flex-wrap items-center gap-2 rounded border border-status-waiting/40 bg-status-waiting/10 p-3 text-sm text-status-waiting"
              >
                <span>读取失败，请稍后重试。</span>
                <button
                  type="button"
                  onClick={() => void loadContent()}
                  className="min-h-8 rounded bg-white/10 px-2 text-xs text-deck-text hover:bg-white/15"
                >
                  重试
                </button>
              </div>
            );
          }
          if (content === null) {
            return (
              <div role="status" className="text-sm text-deck-muted">
                正在读取完整内容…
              </div>
            );
          }
          return (
            <pre className="min-h-full whitespace-pre-wrap break-words rounded border border-deck-border bg-white/[0.04] p-3 font-mono text-xs leading-relaxed text-deck-text">
              {expandedPayload.text}
            </pre>
          );
        }}
      </ExpandableContent>
    </div>
  );
}
