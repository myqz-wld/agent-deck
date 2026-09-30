import { parseFeishuPreferencesResult } from '@contracts/index';
import type { RemoteHostFeishuPreferencesDto, RemoteHostFeishuPreferencesRequestDto,
  RemoteHostFeishuPreferencesUpdateDto } from '@shared/remote-host';
import { REMOTE_HOST_INTERACTIVE_DEADLINE_MS, type RemoteHostScopedRequest } from './service-scope';

export class RemoteHostFeishuPreferencesController {
  constructor(private readonly request: RemoteHostScopedRequest,
    private readonly mutationId: (operation: string, profileId: string, intentId: string) => string) {}
  get(request: RemoteHostFeishuPreferencesRequestDto): Promise<RemoteHostFeishuPreferencesDto> {
    return this.request(request.profileId, 'feishu.preferences.get', async (scope) =>
      parseFeishuPreferencesResult(await scope.client.request('feishu.preferences.get', {}, {
        deadlineMs: REMOTE_HOST_INTERACTIVE_DEADLINE_MS,
      })));
  }
  update(request: RemoteHostFeishuPreferencesUpdateDto): Promise<RemoteHostFeishuPreferencesDto> {
    return this.request(request.profileId, 'feishu.preferences.update', async (scope) =>
      parseFeishuPreferencesResult(await scope.client.request('feishu.preferences.update', {
        purpose: request.purpose, preference: request.preference, expectedSettingsRevision: request.expectedSettingsRevision,
      }, { deadlineMs: REMOTE_HOST_INTERACTIVE_DEADLINE_MS,
        idempotencyKey: this.mutationId('feishu-preferences-update', request.profileId, request.intentId),
      })), [], request.expectedAuthority);
  }
}
