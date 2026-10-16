import { createContext, useContext } from 'react';
import type { AgentEvent } from '@shared/types';
import type { NativeWorkSnapshot } from '@shared/native-work';
import type { NativeWorkTransport } from './transport';

export interface NativeCommandSource { tasks: readonly NativeWorkSnapshot[]; transport: NativeWorkTransport | null }
export const NativeCommandContext = createContext<NativeCommandSource | undefined>(undefined);

/** Associate only by an explicit native tool ID and owner, never command text or time. */
export function useNativeCommand(event: AgentEvent | undefined) {
  const source = useContext(NativeCommandContext);
  if (!event || !source?.transport) return null;
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const task = source.tasks.find(task => task.workKind === 'shell' && task.native.sessionId === event.sessionId &&
    task.native.provider === event.agentId && (payload.nativeWorkOwner
      ? task.parentTaskId === payload.nativeWorkOwner && !!task.toolUseKey && task.toolUseKey === payload.nativeWorkToolUseId
      : !task.parentTaskId && !!task.toolUseId && task.toolUseId === payload.toolUseId));
  return task ? { task, transport: source.transport } : null;
}

export function commandEvent(event: AgentEvent, task: NativeWorkSnapshot | undefined): AgentEvent {
  // Codex already sends commandExecution output and final state to its original tool row.
  if (!task || task.native.provider === 'codex-cli') return event;
  const status = { pending: 'pending', running: 'inProgress', paused: 'paused', completed: 'completed',
    failed: 'failed', stopped: 'cancelled', unknown: 'unknown' }[task.status];
  return { ...event, payload: { ...(event.payload as Record<string, unknown>), status,
    // The initial tool response only confirms background registration, not command exit/duration.
    exitCode: undefined, durationMs: undefined, error: task.error } };
}
