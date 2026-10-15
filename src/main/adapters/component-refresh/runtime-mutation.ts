import type { ComponentRefreshGate } from './gate';

interface Runtime { componentRefresh?: ComponentRefreshGate }
const mutations = new WeakMap<Runtime, number>();

export function assertComponentRefreshAvailable(runtime: Runtime): void {
  if (mutations.has(runtime)) throw new Error('会话运行设置正在切换，请完成后再刷新扩展。');
}

/** Explicit runtime changes supersede queued refreshes, but cannot overlap native application. */
export async function withComponentRuntimeMutation<T>(runtime: Runtime | undefined, work: () => Promise<T>): Promise<T> {
  if (!runtime) return work();
  runtime.componentRefresh?.assertNotApplying();
  mutations.set(runtime, (mutations.get(runtime) ?? 0) + 1);
  runtime.componentRefresh?.invalidate();
  try { return await work(); }
  finally {
    const remaining = (mutations.get(runtime) ?? 1) - 1;
    if (remaining) mutations.set(runtime, remaining); else mutations.delete(runtime);
  }
}
