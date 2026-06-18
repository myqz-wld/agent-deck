import type { JSX } from 'react';
import type { DiffPayload } from '@shared/types';
import log from '@renderer/utils/logger';
import { diffRegistry } from './registry';
import { SessionIdProvider } from './SessionContext';
import { ExpandedProvider } from './ExpandedContext';

const logger = log.scope('renderer-diff-viewer');

interface Props {
  payload: DiffPayload;
  /**
   * 当前会话 id；ImageDiffRenderer 通过 useDiffSessionId() 拿来调 loadImageBlob。
   * 文本 / pdf 渲染不需要，传不传都行。
   */
  sessionId?: string;
  /** 放大模式下传 true；渲染器会隐藏内部 DiffHeader 避免路径重复显示。 */
  expanded?: boolean;
}

export function DiffViewer({ payload, sessionId, expanded }: Props): JSX.Element {
  const plugin = diffRegistry.resolve(payload);
  if (!plugin) {
    // 内部 kind 字段不暴露给用户;开发者要排查时看 console.warn
    if (typeof console !== 'undefined') {
      logger.warn('[DiffViewer] no renderer for diff kind:', payload.kind);
    }
    return (
      <div className="px-2 py-3 text-[11px] text-deck-muted">
        无法显示此类型的差异
      </div>
    );
  }
  const Comp = plugin.Component;
  return (
    <SessionIdProvider value={sessionId ?? ''}>
      <ExpandedProvider value={expanded ?? false}>
        <Comp payload={payload} />
      </ExpandedProvider>
    </SessionIdProvider>
  );
}
