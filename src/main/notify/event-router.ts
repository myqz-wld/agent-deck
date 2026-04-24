import type { AgentEvent } from '@shared/types';
import { sessionManager } from '@main/session/manager';
import { notifyUser } from './visual';

/**
 * 把 AgentEvent 翻成「是否要给用户系统通知 + 提示音」。
 * 拆离自 index.ts bootstrap 的 emit 回调（CHANGELOG_20 / F），让 bootstrap 回归装配胶水。
 *
 * 调用顺序：sessionManager.ingest(event) → routeEventToNotification(event)。
 * 如果以后要按事件 kind 加新通知规则，只动这个文件。
 *
 * REVIEW_4 M6：整段 try/catch — `notifyUser` 内 Notification / dock.bounce / playSoundOnce
 * 任一抛错（macOS 无通知权限 / Notification.isSupported 误判 / dock 已 release）都会
 * 冒泡到 adapter for-await emit 循环把后续事件流整条切断；这里吞错只 console.error，
 * 通知失败不应影响事件入库 / UI 渲染主链路。
 *
 * REVIEW_4 M7：finished 看 `payload.ok / subtype`，error/interrupted 走「中断 / 出错」
 * 标题，避免与 H1 删除复活复合让用户看到莫名的「Agent 完成」通知。
 */
export function routeEventToNotification(event: AgentEvent): void {
  try {
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
      // ok=false 的 finished 通常意味着「中断 / 异常」，不该用「完成」措辞混淆用户。
      const payload = (event.payload ?? {}) as { ok?: boolean; subtype?: string };
      const session = sessionManager.get(event.sessionId);
      const isError = payload.ok === false;
      const subtype = payload.subtype;
      const title = isError
        ? subtype === 'interrupted'
          ? 'Agent 已中断'
          : 'Agent 出错'
        : 'Agent 完成';
      notifyUser({
        title,
        body: session?.title ?? '',
        level: 'finished',
      });
    }
  } catch (err) {
    // 通知失败（无系统权限 / dock 已 release / 音频文件被删 / Notification.show 抛错）
    // 不应反噬主链路。adapter for-await emit 循环对 throw 敏感，这里必须吞。
    console.error('[event-router] notification dispatch failed:', err);
  }
}
