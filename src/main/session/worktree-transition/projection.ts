import { eventBus } from '@main/event-bus';
import { sessionManager } from '@main/session/manager';
import { sessionRepo } from '@main/store/session-repo';

export function emitWorktreeSessionUpsert(sessionId: string): void {
  const updated = sessionRepo.get(sessionId);
  if (updated) eventBus.emit('session-upserted', updated);
}

export function emitWorktreeTransitionStatus(
  sessionId: string,
  text: string,
  error: boolean,
  generation: number,
): void {
  const record = sessionRepo.get(sessionId);
  if (!record?.agentId) return;
  sessionManager.ingest({
    sessionId,
    agentId: record.agentId,
    kind: 'message',
    payload: {
      text,
      role: 'system',
      ...(error ? { error: true } : {}),
      worktreeTransitionStatus: { generation },
    },
    ts: Date.now(),
    source: 'sdk',
  });
}
