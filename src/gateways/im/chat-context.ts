import type { FeishuChatContext } from './types';

export function removeFeishuSessionBinding(
  context: FeishuChatContext, sessionId: string, updatedAt: number,
): FeishuChatContext {
  const work = context.activeSessionId === sessionId;
  const assistant = context.assistantSessionId === sessionId;
  if (!work && !assistant) return context;
  return { ...context,
    activeSessionId: work ? null : context.activeSessionId,
    assistantSessionId: assistant ? null : context.assistantSessionId,
    assistantGeneration: Math.min(Number.MAX_SAFE_INTEGER, context.assistantGeneration + Number(assistant)),
    updatedAt: Math.max(updatedAt, context.updatedAt + 1),
  };
}
