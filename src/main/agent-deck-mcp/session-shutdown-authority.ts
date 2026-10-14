import type { SessionRecord } from '@shared/types';
import type { AskUserArgs, AskUserResult } from './tools/schemas/ask-user';

export const SHUTDOWN_APPROVAL_TIMEOUT_MS = 300_000;
const APPROVE = '确认关闭';

export interface SessionShutdownAuthority {
  get(id: string): SessionRecord | null;
  successor(id: string): string | null;
  lineage(id: string): readonly string[];
  request(callerId: string, args: AskUserArgs, signal: AbortSignal): Promise<AskUserResult>;
  displayCwd?(target: SessionRecord): string;
}

/** Direction matters: team peers and ancestors are not managed descendants. */
export function isManagedSession(
  callerId: string, targetId: string,
  ports: Pick<SessionShutdownAuthority, 'get' | 'lineage'>,
): boolean {
  const owners = new Set(ports.lineage(callerId));
  for (const target of ports.lineage(targetId)) {
    const seen = new Set<string>();
    let parent = ports.get(target)?.spawnedBy;
    for (let depth = 0; parent && depth < 1024; depth++) {
      if (owners.has(parent)) return true;
      if (seen.has(parent)) break;
      seen.add(parent);
      parent = ports.get(parent)?.spawnedBy;
    }
  }
  return false;
}

function identity(row: SessionRecord): string {
  return JSON.stringify([row.id, row.startedAt, row.agentId, row.cwd, row.title, row.archivedAt, row.endedAt]);
}

/** A private host-owned question authorizes one exact invocation, never an agent-supplied flag. */
export async function authorizeSessionShutdown(
  callerId: string, targetId: string, ports: SessionShutdownAuthority, signal?: AbortSignal,
): Promise<() => SessionRecord> {
  const caller = ports.get(callerId);
  const target = ports.get(targetId);
  if (!caller || caller.lifecycle === 'closed' || caller.archivedAt != null || ports.successor(callerId)) {
    throw new Error('Shutdown caller is unavailable or has handed off');
  }
  if (callerId === targetId) throw new Error('Cannot shut down the caller session');
  if (!target) throw new Error('Shutdown target was not found');
  if (signal?.aborted) throw new Error('Shutdown was cancelled; nothing was closed');
  const callerIdentity = identity(caller);
  const targetIdentity = identity(target);
  const targetSuccessor = ports.successor(targetId);
  const grant = (requireManaged = false) => {
    let consumed = false;
    return (): SessionRecord => {
      if (consumed) throw new Error('Shutdown authorization was already consumed');
      consumed = true;
      const currentCaller = ports.get(callerId);
      const currentTarget = ports.get(targetId);
      if (signal?.aborted || !currentCaller || currentCaller.lifecycle === 'closed' || currentCaller.archivedAt != null ||
        identity(currentCaller) !== callerIdentity || ports.successor(callerId) || !currentTarget ||
        identity(currentTarget) !== targetIdentity || ports.successor(targetId) !== targetSuccessor ||
        (requireManaged && !isManagedSession(callerId, targetId, ports))) {
        throw new Error('Shutdown authorization expired because the caller or target changed; discover the target again.');
      }
      return currentTarget;
    };
  };
  if (target.lifecycle === 'closed') return grant();
  if (isManagedSession(callerId, targetId, ports)) return grant(true);
  if (target.hiddenFromHistory) throw new Error('Internal sessions cannot be closed through unrelated-session approval');
  if (ports.successor(targetId)) throw new Error('Shutdown target has handed off; discover the current target first');
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, SHUTDOWN_APPROVAL_TIMEOUT_MS);
  timer.unref();
  let stopWait!: () => void;
  const cancelled = new Promise<AskUserResult>((resolve) => {
    stopWait = () => resolve({ status: 'cancelled', answers: [] });
    controller.signal.addEventListener('abort', stopWait, { once: true });
  });
  try {
    const args: AskUserArgs = { questions: [{
      header: '关闭其他会话',
      question: `是否中断并关闭以下会话？历史记录和文件将保留。本次确认仅适用于这个目标。\n名称：${target.title.slice(0,40)}\nID：${target.id}\n目录：${(ports.displayCwd?.(target) ?? target.cwd).slice(0,60)}`,
      options: [{ label: '取消' }, { label: APPROVE }],
    }] };
    const answer = await Promise.race([ports.request(callerId, args, controller.signal), cancelled]);
    if (controller.signal.aborted || answer.status !== 'answered' ||
      answer.answers[0]?.selected.length !== 1 || answer.answers[0].selected[0] !== APPROVE) {
      throw new Error('Shutdown was not approved; nothing was closed. Do not retry without a new user request.');
    }
    return grant();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', stopWait);
    controller.abort();
  }
}
