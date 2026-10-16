import type { NativeWorkDetailParams, NativeWorkListParams, NativeWorkRef } from '../../contracts/native-work';
import type { RemoteHostMutationIntentDto } from './session-request-types';
export type RemoteNativeWorkListRequest = NativeWorkListParams & { profileId: string };
export type RemoteNativeWorkDetailRequest = NativeWorkDetailParams & { profileId: string };
export type RemoteNativeWorkStopRequest = RemoteHostMutationIntentDto & { profileId: string; ref: NativeWorkRef };
