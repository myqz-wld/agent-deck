import type { AgentEvent } from '@shared/types';

/** File changes and tool events use different payload fields for the same provider call. */
export function activityToolCallKey(event: AgentEvent): string | null {
  const payload = event.payload as { toolUseId?: unknown; toolCallId?: unknown } | null;
  const id = event.kind === 'file-changed' ? payload?.toolCallId
    : event.kind === 'tool-use-start' || event.kind === 'tool-use-end' ? payload?.toolUseId : null;
  return typeof id === 'string' && id
    ? JSON.stringify([event.sessionId, event.agentId, id]) : null;
}

/** View-only association; history and the Changes tab retain the original events. */
export function deriveToolCallPresentation(events: readonly AgentEvent[], isSdk: boolean) {
  const toolStartByUseId = new Map<string, AgentEvent>();
  const toolEndByUseId = new Map<string, AgentEvent>();
  const fileChangesByUseId = new Map<string, AgentEvent[]>();
  const standaloneFileChanges = new Map<AgentEvent, AgentEvent[]>();
  const standaloneAnchorByUseId = new Map<string, AgentEvent>();
  const attachedFileChanges = new Set<AgentEvent>();
  for (const event of events) {
    const key = activityToolCallKey(event);
    if (!key) continue;
    if (event.kind === 'tool-use-start') toolStartByUseId.set(key, event);
    if (event.kind === 'tool-use-end') toolEndByUseId.set(key, event);
  }
  for (const event of events) {
    if (event.kind !== 'file-changed') continue;
    const key = activityToolCallKey(event);
    if (!key || typeof (event.payload as { filePath?: unknown } | null)?.filePath !== 'string') continue;
    const tool = toolStartByUseId.get(key) ?? toolEndByUseId.get(key);
    const toolName = (tool?.payload as { toolName?: unknown } | null)?.toolName;
    // These SDK tools are represented by pending-request cards, not tool rows.
    if (!tool || (isSdk && (toolName === 'AskUserQuestion' || toolName === 'ExitPlanMode'))) {
      const anchor = standaloneAnchorByUseId.get(key);
      if (anchor) {
        standaloneFileChanges.get(anchor)!.push(event);
        attachedFileChanges.add(event);
      } else {
        standaloneAnchorByUseId.set(key, event);
        standaloneFileChanges.set(event, [event]);
      }
      continue;
    }
    const changes = fileChangesByUseId.get(key) ?? [];
    changes.push(event);
    fileChangesByUseId.set(key, changes);
    attachedFileChanges.add(event);
  }
  return { toolStartByUseId, toolEndByUseId, fileChangesByUseId, standaloneFileChanges, attachedFileChanges };
}
