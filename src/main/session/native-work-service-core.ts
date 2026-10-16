import type { AgentAdapter } from '@main/adapters/types';
import type { SessionRecord } from '@shared/types';
import { isTerminalNativeWork, sameNativeWorkRef, type NativeWorkDetailParams, type NativeWorkDetailResult,
  type NativeWorkListParams, type NativeWorkListResult, type NativeWorkRef, type NativeWorkStopResult } from '@shared/native-work';

export interface NativeWorkServicePort {
  list(input: NativeWorkListParams): Promise<NativeWorkListResult>;
  details(input: NativeWorkDetailParams): Promise<NativeWorkDetailResult>;
  stop(ref: NativeWorkRef): Promise<NativeWorkStopResult>;
}
export interface NativeWorkServiceOptions {
  session(id: string): SessionRecord | null;
  adapter(id: string): AgentAdapter | undefined;
  repository: {
    list(id: string, options?: Omit<NativeWorkListParams, 'sessionId'>): NativeWorkListResult;
    details(input: NativeWorkDetailParams): NativeWorkDetailResult;
  };
  stopTimeoutMs?: number;
}
export function createNativeWorkService(options: NativeWorkServiceOptions): NativeWorkServicePort {
  const pending = new Map<string, Promise<NativeWorkStopResult>>();
  const session = (id: string) => {
    const record = options.session(id);
    if (!record) throw new Error('会话不存在');
    return record;
  };
  return {
    async list(input) {
      const record = session(input.sessionId);
      const live = await options.adapter(record.agentId)?.listNativeWork?.(record.id) ?? [];
      const result = options.repository.list(input.sessionId, input);
      return { ...result, tasks: result.tasks.map(task => {
        const current = live.find(item => sameNativeWorkRef(item.native, task.native));
        if (current) return current;
        return { ...task, canStop: false, status: isTerminalNativeWork(task.status) ? task.status : 'unknown',
          controlReason: '当前没有可控制的运行实例' };
      }) };
    },
    async details(input) { session(input.ref.sessionId); return options.repository.details(input); },
    async stop(ref) {
      const record = session(ref.sessionId);
      if (record.agentId !== ref.provider || record.lifecycle === 'closed') return { status: 'stale' };
      const adapter = options.adapter(record.agentId);
      if (!adapter?.stopNativeWork) return { status: 'unsupported' };
      const live = await adapter.listNativeWork?.(record.id) ?? [];
      const task = live.find(item => sameNativeWorkRef(item.native, ref));
      if (!task) return { status: 'stale' };
      if (isTerminalNativeWork(task.status)) return { status: 'already-terminal' };
      if (!task.canStop) return { status: 'unsupported', reason: task.controlReason };
      const key = JSON.stringify(ref), existing = pending.get(key);
      if (existing) return existing;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const operation = Promise.race([
        adapter.stopNativeWork(ref),
        new Promise<NativeWorkStopResult>(resolve => { timer = setTimeout(() => resolve({ status: 'timed-out' }), options.stopTimeoutMs ?? 30000); }),
      ]).catch((): NativeWorkStopResult => ({ status: 'failed' })).finally(() => {
        if (timer) clearTimeout(timer); pending.delete(key);
      });
      pending.set(key, operation); return operation;
    },
  };
}
