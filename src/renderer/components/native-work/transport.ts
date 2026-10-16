import type { NativeWorkListParams, NativeWorkListResult, NativeWorkDetailParams, NativeWorkDetailResult, NativeWorkRef, NativeWorkStopResult } from '@shared/native-work';
import type { RemoteHostMutationAuthorityDto } from '@shared/remote-host';
export interface NativeWorkTransport {
  list(input: NativeWorkListParams): Promise<NativeWorkListResult>;
  details(input: NativeWorkDetailParams): Promise<NativeWorkDetailResult>;
  stop(ref: NativeWorkRef): Promise<NativeWorkStopResult>;
  subscribe?(sessionId: string, changed: () => void): () => void;
}
export const localNativeWorkTransport: NativeWorkTransport = {
  list: input => window.api.listNativeWork ? window.api.listNativeWork(input) : Promise.resolve({ tasks: [], revision: 0, nextCursor: null }),
  details: input => window.api.getNativeWorkDetails(input),
  stop: ref => window.api.stopNativeWork(ref),
  subscribe: (id, changed) => window.api.onAgentEvent?.(event => {
    if (event.sessionId === id && ['background-task', 'native-work-detail'].includes(event.kind)) changed();
  }) ?? (() => {}),
};
export function remoteNativeWorkTransport(profileId: string, authority: RemoteHostMutationAuthorityDto, canStop: boolean): NativeWorkTransport {
  return {
    list: async input => {
      const page = await window.api.listRemoteNativeWork({ profileId, ...input });
      return { ...page, tasks: canStop ? page.tasks : page.tasks.map(task => ({ ...task, canStop: false, controlReason: '此远程连接没有停止任务的权限' })) };
    },
    details: input => window.api.getRemoteNativeWorkDetails({ profileId, ...input }),
    stop: ref => canStop ? window.api.stopRemoteNativeWork({ profileId, ref, expectedAuthority: authority, intentId: crypto.randomUUID() })
      : Promise.resolve({ status: 'unsupported', reason: '此远程连接没有停止任务的权限' }),
  };
}
