import { IpcInvoke } from '@shared/ipc-channels';
import { parseNativeWorkListParams, parseNativeWorkDetailParams, parseNativeWorkStopParams } from '@contracts/native-work';
import { getNativeWorkService } from '@main/session/native-work-service-host';
import { on } from './_helpers';
export function registerNativeWorkIpc(): void {
  on(IpcInvoke.NativeWorkList, (_event, input) => getNativeWorkService().list(parseNativeWorkListParams(input)));
  on(IpcInvoke.NativeWorkDetails, (_event, input) => getNativeWorkService().details(parseNativeWorkDetailParams(input)));
  on(IpcInvoke.NativeWorkStop, (_event, input) => getNativeWorkService().stop(parseNativeWorkStopParams(input).ref));
}
