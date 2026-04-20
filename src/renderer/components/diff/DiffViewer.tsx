import type { JSX } from 'react';
import type { DiffPayload } from '@shared/types';
import { diffRegistry } from './registry';

interface Props {
  payload: DiffPayload;
}

export function DiffViewer({ payload }: Props): JSX.Element {
  const plugin = diffRegistry.resolve(payload);
  if (!plugin) {
    return (
      <div className="px-2 py-3 text-[11px] text-deck-muted">
        没有可用的 diff 渲染器（kind: <code>{payload.kind}</code>）
      </div>
    );
  }
  const Comp = plugin.Component;
  return <Comp payload={payload} />;
}
