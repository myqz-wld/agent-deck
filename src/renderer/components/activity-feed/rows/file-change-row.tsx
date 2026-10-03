import type { JSX } from 'react';
import type { AgentEvent } from '@shared/types';
import { ToolStartRow } from './tool-row';

/** Providers without a tool envelope still use the same file-operation card. */
export function FileChangeRow({ event, fileChanges = [event] }: {
  event: AgentEvent;
  fileChanges?: readonly AgentEvent[];
}): JSX.Element {
  const payload = event.payload as { metadata?: { patchStatus?: unknown } } | null;
  const status = payload?.metadata?.patchStatus;
  const summary: AgentEvent = {
    ...event,
    payload: { toolName: '文件改动', toolKind: 'edit', status: typeof status === 'string' ? status : 'completed' },
  };
  return <ToolStartRow event={summary} sessionId={event.sessionId} fileChanges={fileChanges} />;
}
