import type { AgentEventKind } from '@shared/types';
import type { CodexAppServerNotification } from './protocol';

/** Current app-server plan/progress and advisory notifications; never synthesize tool identity. */
export function translateCodexProgress(
  notification: CodexAppServerNotification,
  emit: (kind: AgentEventKind, payload: unknown) => void,
): boolean {
  const params = notification.params && typeof notification.params === 'object'
    ? notification.params as Record<string, unknown> : {};
  if (notification.method === 'turn/plan/updated') {
    if (typeof params.turnId !== 'string' || !Array.isArray(params.plan)) return true;
    const entries = params.plan.flatMap((step) => {
      if (!step || typeof step !== 'object' || typeof step.step !== 'string') return [];
      return [{ content: step.step, status: step.status }];
    });
    emit('thinking', { plan: true, planId: `codex:${String(params.threadId)}:${params.turnId}`, entries,
      text: entries.map((step) => `- [${step.status === 'completed' ? 'x' : ' '}] ${step.content}`).join('\n'),
      explanation: typeof params.explanation === 'string' ? params.explanation : undefined });
    return true;
  }
  if (notification.method === 'item/mcpToolCall/progress') {
    if (typeof params.itemId === 'string' && typeof params.message === 'string') {
      emit('tool-use-start', { toolUseId: params.itemId, progressMessage: params.message, status: 'inProgress' });
    }
    return true;
  }
  if (['warning', 'guardianWarning', 'configWarning', 'deprecationNotice'].includes(notification.method)) {
    const text = [params.message ?? params.summary, params.details]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0).join('\n');
    if (text) emit('message', { role: 'system', warning: true, text: `⚠ Codex · ${text}` });
    return true;
  }
  return false;
}
