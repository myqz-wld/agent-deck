/**
 * 测试用 eventBus mock factory（R37 P2-F Step 3.1）。
 *
 * 抽自 `src/main/session/__tests__/manager-test-setup.ts` 的 `makeEventBusMock`，
 * 加 `removeAllListeners` 让 task-manager / team-coordinator 等 test 也能复用。
 *
 * **stateful 容器**：
 * 默认 factory 内部建一个 `emits: { name, payload }[]` 数组，caller 通过 `__emits` 拿引用。
 * caller 也可显式传 `emits` 让多个 mock 共享同一数组。
 *
 * **on / off 默认**：
 * `on()` 默认返一个 noop unsubscribe (`() => undefined`)，匹配 TypedEventBus.on 真实签名
 * （subscriber 可调返回值取消订阅）。caller 想跟踪订阅 / 触发 listener 时 override。
 */

import { vi } from 'vitest';

export interface EventBusEmit {
  name: string;
  payload: unknown;
}

export interface EventBusMockOptions {
  /** 外部 state 容器；不传则 factory 内部建一个新数组 */
  emits?: EventBusEmit[];
  /** 部分覆盖 default method 实现 */
  overrides?: Record<string, unknown>;
}

export type EventBusMock = Record<string, unknown> & {
  /** factory 内部 / caller 共享的 emits 数组（caller 直接 push / clear） */
  __emits: EventBusEmit[];
};

export function makeEventBusMock(opts: EventBusMockOptions = {}): EventBusMock {
  const emits = opts.emits ?? [];

  const base = {
    emit: (name: string, payload: unknown) => {
      emits.push({ name, payload });
    },
    on: vi.fn(() => () => undefined),
    off: vi.fn(),
    removeAllListeners: vi.fn(),
  };

  return Object.assign(base, opts.overrides ?? {}, { __emits: emits });
}
