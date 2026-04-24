import type { AgentEvent } from '@shared/types';
import { sessionManager } from '@main/session/manager';
import { notifyUser } from './visual';

/**
 * 把 AgentEvent 翻成「是否要给用户系统通知 + 提示音」。
 * 拆离自 index.ts bootstrap 的 emit 回调（CHANGELOG_20 / F），让 bootstrap 回归装配胶水。
 *
 * 调用顺序：sessionManager.ingest(event) → routeEventToNotification(event)。
 * 如果以后要按事件 kind 加新通知规则，只动这个文件。
 */
export function routeEventToNotification(event: AgentEvent): void {
  if (event.kind === 'waiting-for-user') {
    // SDK 通道的 `*-cancelled` 事件（permission-cancelled / ask-question-cancelled /
    // exit-plan-cancelled）也复用 `waiting-for-user` 这个 kind，但语义是「撤掉那条 pending」
    // 而不是「又一次需要用户输入」。如果一律推系统通知 + 提示音，用户在点完按钮 / 超时 /
    // session-end 之后会收到一条多余的「Agent 等待你的输入」打扰。
    const payload = (event.payload ?? {}) as { type?: string; message?: string };
    const type = payload.type;
    if (typeof type === 'string' && type.endsWith('-cancelled')) {
      return;
    }
    const session = sessionManager.get(event.sessionId);
    notifyUser({
      title: 'Agent 等待你的输入',
      body: session ? `${session.title}：${payload.message ?? ''}` : '',
      level: 'waiting',
    });
    return;
  }

  if (event.kind === 'finished') {
    const session = sessionManager.get(event.sessionId);
    notifyUser({
      title: 'Agent 完成',
      body: session?.title ?? '',
      level: 'finished',
    });
  }
}
