import type { FeishuPreferencesResult, FeishuPreferencesUpdateParams } from '@contracts/index';
import type { RemoteHostMutationIntentDto } from './types';

export interface RemoteHostFeishuPreferencesRequestDto { profileId: string }
export interface RemoteHostFeishuPreferencesUpdateDto extends RemoteHostFeishuPreferencesRequestDto,
  RemoteHostMutationIntentDto, FeishuPreferencesUpdateParams {}
export type RemoteHostFeishuPreferencesDto = FeishuPreferencesResult;
