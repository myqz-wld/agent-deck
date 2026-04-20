import type { EventEmitter } from 'node:events';

/**
 * 类型化的事件总线封装。其它模块通过 emit/on/off 与之交互，
 * 避免直接依赖 Node EventEmitter 的非类型化签名。
 */

import { EventEmitter as NodeEventEmitter } from 'node:events';
import type { AgentEvent, SessionRecord, SummaryRecord } from '@shared/types';

export interface EventMap {
  'agent-event': [AgentEvent];
  'session-upserted': [SessionRecord];
  'session-removed': [string];
  /** SDK fallback 路径：from=tempKey, to=真实 SDK session_id */
  'session-renamed': [{ from: string; to: string }];
  'summary-added': [SummaryRecord];
  /** CLI 子命令新建会话后请求 renderer 切到「实时」并选中该 sessionId。 */
  'session-focus-request': [string];
}

export class TypedEventBus {
  private inner: EventEmitter = new NodeEventEmitter();

  emit<K extends keyof EventMap>(event: K, ...args: EventMap[K]): void {
    this.inner.emit(event, ...args);
  }

  on<K extends keyof EventMap>(
    event: K,
    listener: (...args: EventMap[K]) => void,
  ): () => void {
    this.inner.on(event, listener as (...a: unknown[]) => void);
    return () => this.inner.off(event, listener as (...a: unknown[]) => void);
  }

  off<K extends keyof EventMap>(
    event: K,
    listener: (...args: EventMap[K]) => void,
  ): void {
    this.inner.off(event, listener as (...a: unknown[]) => void);
  }

  removeAllListeners(): void {
    this.inner.removeAllListeners();
  }
}

export const eventBus = new TypedEventBus();
