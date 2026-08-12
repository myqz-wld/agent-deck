import type {
  SessionConsoleAttachmentInput,
  SessionContextGetResult,
  SessionHandOffCommitResult,
  SessionHandOffPreviewResult,
  SessionHandOffTargetInputDto,
  SessionInputCapabilitiesResult,
  SessionMessagesListResult,
  SessionOutgoingListResult,
  SessionOutgoingRemoveResult,
  SessionPermissionsGetResult,
} from '@contracts/index';

export interface RemoteHostMutationAuthorityDto {
  authoritativeCoreId: string | null;
  workerGeneration: number | null;
}

export interface RemoteHostMutationIntentDto {
  expectedAuthority: RemoteHostMutationAuthorityDto;
  intentId: string;
}

export interface RemoteHostSessionTargetDto {
  profileId: string;
  sessionId: string;
}

export type RemoteHostSessionContextDto = SessionContextGetResult;
export type RemoteHostSessionInputCapabilitiesDto = SessionInputCapabilitiesResult;

export interface RemoteHostSessionPermissionsRequestDto extends RemoteHostSessionTargetDto {
  adapterId: 'claude-code' | 'codex-cli' | 'grok-build';
}
export type RemoteHostSessionPermissionsDto = SessionPermissionsGetResult;

export interface RemoteHostSessionMessagesRequestDto extends RemoteHostSessionTargetDto {
  limit: number;
}
export type RemoteHostSessionMessagesDto = SessionMessagesListResult;

export interface RemoteHostSessionOutgoingRequestDto extends RemoteHostSessionTargetDto {
  adapterId: 'claude-code' | 'codex-cli' | 'grok-build';
}
export type RemoteHostSessionOutgoingDto = SessionOutgoingListResult;
export interface RemoteHostSessionOutgoingRemoveRequestDto
  extends RemoteHostSessionTargetDto, RemoteHostMutationIntentDto {
  messageId: string;
}
export type RemoteHostSessionOutgoingRemoveDto = SessionOutgoingRemoveResult;

export interface RemoteHostHandOffPreviewRequestDto extends RemoteHostSessionTargetDto {
  continuationInstruction: string;
  target: SessionHandOffTargetInputDto;
}

export interface RemoteHostHandOffCommitRequestDto
  extends RemoteHostHandOffPreviewRequestDto, RemoteHostMutationIntentDto {
  expectedBindingDigest: string;
}

export type RemoteHostHandOffPreviewDto = SessionHandOffPreviewResult;
export type RemoteHostHandOffCommitDto = SessionHandOffCommitResult;

export interface RemoteHostMutationTargetDto
  extends RemoteHostSessionTargetDto, RemoteHostMutationIntentDto {}

export interface RemoteHostSendDto
  extends RemoteHostSessionTargetDto, RemoteHostMutationIntentDto {
  text: string;
  attachments?: SessionConsoleAttachmentInput[];
}

export interface RemoteHostSendResultDto {
  messageId: string;
  sequence: number;
  revision: number;
}
