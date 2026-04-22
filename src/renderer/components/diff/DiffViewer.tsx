import type { JSX } from 'react';
import type { DiffPayload } from '@shared/types';
import { diffRegistry } from './registry';
import { SessionIdProvider } from './SessionContext';

interface Props {
  payload: DiffPayload;
  /**
   * 当前会话 id；ImageDiffRenderer 通过 useDiffSessionId() 拿来调 loadImageBlob。
   * 文本 / pdf 渲染不需要，传不传都行。
   */
  sessionId?: string;
}

export function DiffViewer({ payload, sessionId }: Props): JSX.Element {
  const plugin = diffRegistry.resolve(payload);
  if (!plugin) {
    return (
      <div className="px-2 py-3 text-[11px] text-deck-muted">
        没有可用的 diff 渲染器（kind: <code>{payload.kind}</code>）
      </div>
    );
  }
  const Comp = plugin.Component;
  return (
    <SessionIdProvider value={sessionId ?? ''}>
      <Comp payload={payload} />
    </SessionIdProvider>
  );
}
