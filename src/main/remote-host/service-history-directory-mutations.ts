import {
  parseSessionHistoryMutationResult,
  parseWorkspaceDirectoryCreateResult,
  type SessionHistoryMutationState,
} from '@contracts/index';
import type {
  RemoteHostSessionHistoryMutationDto,
  RemoteHostSessionHistoryMutationResultDto,
  RemoteHostWorkspaceDirectoryCreateDto,
  RemoteHostWorkspaceDirectoryCreateResultDto,
} from '@shared/remote-host';

import { REMOTE_HOST_INTERACTIVE_DEADLINE_MS, type RemoteHostScopedRequest } from './service-scope';

type MutationId = (operation: string, profileId: string, intentId: string) => string;

export class RemoteHostSessionHistoryMutationController {
  constructor(
    private readonly request: RemoteHostScopedRequest,
    private readonly mutationId: MutationId,
  ) {}

  archive(request: RemoteHostSessionHistoryMutationDto): Promise<RemoteHostSessionHistoryMutationResultDto> {
    return this.mutate('session.archive', 'archive', 'archived', request);
  }

  unarchive(request: RemoteHostSessionHistoryMutationDto): Promise<RemoteHostSessionHistoryMutationResultDto> {
    return this.mutate('session.unarchive', 'unarchive', 'unarchived', request);
  }

  delete(request: RemoteHostSessionHistoryMutationDto): Promise<RemoteHostSessionHistoryMutationResultDto> {
    return this.mutate('session.delete', 'delete', 'deleted', request);
  }

  private mutate(
    method: 'session.archive' | 'session.delete' | 'session.unarchive',
    operation: string,
    state: SessionHistoryMutationState,
    request: RemoteHostSessionHistoryMutationDto,
  ): Promise<RemoteHostSessionHistoryMutationResultDto> {
    return this.request(request.profileId, method, async (scope) =>
      parseSessionHistoryMutationResult(await scope.client.request(method, {
        sessionId: request.sessionId,
        expectedArchived: request.expectedArchived,
        expectedUpdatedAt: request.expectedUpdatedAt,
      }, {
        deadlineMs: REMOTE_HOST_INTERACTIVE_DEADLINE_MS,
        idempotencyKey: this.mutationId(operation, request.profileId, request.intentId),
      }), request.sessionId, state), [], request.expectedAuthority);
  }
}

export class RemoteHostWorkspaceDirectoryMutationController {
  constructor(
    private readonly request: RemoteHostScopedRequest,
    private readonly mutationId: MutationId,
  ) {}

  create(
    request: RemoteHostWorkspaceDirectoryCreateDto,
  ): Promise<RemoteHostWorkspaceDirectoryCreateResultDto> {
    const params = { parentDirectory: request.parentDirectory, name: request.name };
    return this.request(request.profileId, 'workspace.directory.create', async (scope) =>
      parseWorkspaceDirectoryCreateResult(await scope.client.request(
        'workspace.directory.create',
        params,
        {
          deadlineMs: REMOTE_HOST_INTERACTIVE_DEADLINE_MS,
          idempotencyKey: this.mutationId(
            'workspace-directory-create',
            request.profileId,
            request.intentId,
          ),
        },
      ), params), [], request.expectedAuthority);
  }
}
