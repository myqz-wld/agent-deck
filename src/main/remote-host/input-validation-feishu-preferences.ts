import { isJsonObject, parseFeishuPreferencesUpdate } from '@contracts/index';
import type { RemoteHostFeishuPreferencesUpdateDto } from '@shared/remote-host';
import { parseRemoteHostMutationAuthority, parseRemoteHostProfileId, RemoteHostInputError } from './input-validation';

export function parseRemoteHostFeishuPreferencesUpdate(value: unknown): RemoteHostFeishuPreferencesUpdateDto {
  if (!isJsonObject(value) || Object.keys(value).sort().join(',') !==
    'expectedAuthority,expectedSettingsRevision,intentId,preference,profileId,purpose') {
    throw new RemoteHostInputError('preferences', 'invalid fields');
  }
  if (typeof value.intentId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(value.intentId)) {
    throw new RemoteHostInputError('intentId', 'invalid intent');
  }
  try {
    return { ...parseFeishuPreferencesUpdate({ purpose: value.purpose, preference: value.preference,
      expectedSettingsRevision: value.expectedSettingsRevision }),
      profileId: parseRemoteHostProfileId(value.profileId), intentId: value.intentId,
      expectedAuthority: parseRemoteHostMutationAuthority(value.expectedAuthority) };
  } catch { throw new RemoteHostInputError('preferences', 'invalid model selection or authority'); }
}
