import {
  parseIssueGetResult,
  parseIssueListResult,
  parseIssueMutationResult,
  parseIssueResolveInNewSessionResult,
} from '@contracts/index';
import type {
  RemoteHostIssueListDto,
  RemoteHostIssueListRequestDto,
  RemoteHostIssueGetDto,
  RemoteHostIssueMutationResultDto,
  RemoteHostIssueMutationTargetDto,
  RemoteHostIssueResolveSessionDto,
  RemoteHostIssueResolveSessionResultDto,
  RemoteHostIssueTargetDto,
  RemoteHostIssueUpdateDto,
} from '@shared/remote-host';
import type { RemoteHostScopedRequest } from './service-detail-reader';
import {
  REMOTE_HOST_INTERACTIVE_DEADLINE_MS,
  type RemoteHostScopedClient,
} from './service-scope';

export type RemoteHostIssueMutationId = (
  operation: string,
  profileId: string,
  intentId: string,
) => string;

/** Desktop Issue surface sharing the service's capability, identity and deadline fences. */
export class RemoteHostIssueController {
  constructor(
    private readonly request: RemoteHostScopedRequest,
    private readonly mutationId: RemoteHostIssueMutationId,
  ) {}

  list(request: RemoteHostIssueListRequestDto): Promise<RemoteHostIssueListDto> {
    return this.request(request.profileId, 'issues.list', async (scope) => {
      const value = await scope.client.request('issues.list', {
        statuses: request.statuses,
        kinds: request.kinds,
        titleKeyword: request.titleKeyword,
        includeDeleted: request.includeDeleted,
        limit: request.limit,
        offset: request.offset,
      }, { deadlineMs: REMOTE_HOST_INTERACTIVE_DEADLINE_MS });
      return parseIssueListResult(value, request.limit);
    });
  }

  get(request: RemoteHostIssueTargetDto): Promise<RemoteHostIssueGetDto> {
    return this.request(request.profileId, 'issues.get', async (scope) => {
      const value = await scope.client.request(
        'issues.get',
        { issueId: request.issueId },
        { deadlineMs: REMOTE_HOST_INTERACTIVE_DEADLINE_MS },
      );
      return parseIssueGetResult(value, request.issueId);
    });
  }

  update(request: RemoteHostIssueUpdateDto): Promise<RemoteHostIssueMutationResultDto> {
    return this.mutate('update', 'issues.update', request, (scope) =>
      scope.client.request('issues.update', {
        issueId: request.issueId,
        patch: request.patch,
      }, this.options('update', request)));
  }

  softDelete(request: RemoteHostIssueMutationTargetDto): Promise<RemoteHostIssueMutationResultDto> {
    return this.mutate('soft-delete', 'issues.soft-delete', request, (scope) =>
      scope.client.request(
        'issues.soft-delete',
        { issueId: request.issueId },
        this.options('soft-delete', request),
      ));
  }

  undelete(request: RemoteHostIssueMutationTargetDto): Promise<RemoteHostIssueMutationResultDto> {
    return this.mutate('undelete', 'issues.undelete', request, (scope) =>
      scope.client.request(
        'issues.undelete',
        { issueId: request.issueId },
        this.options('undelete', request),
      ));
  }

  resolveInNewSession(
    request: RemoteHostIssueResolveSessionDto,
  ): Promise<RemoteHostIssueResolveSessionResultDto> {
    return this.request(
      request.profileId,
      'issues.resolve-in-new-session',
      async (scope) => parseIssueResolveInNewSessionResult(await scope.client.request(
        'issues.resolve-in-new-session',
        {
          issueId: request.issueId,
          issueUpdatedAt: request.issueUpdatedAt,
          create: {
            adapterId: request.adapterId,
            attachments: request.attachments,
            capabilityRevision: request.capabilityRevision,
            initialMessage: request.initialMessage,
            projectTrust: request.projectTrust,
            options: request.options,
            workingDirectory: request.workingDirectory,
          },
        },
        this.options('resolve-in-new-session', request),
      ), request.issueId),
      ['session.console.create', 'session.console.capabilities'],
      request.expectedAuthority,
    );
  }

  private mutate(
    _operation: string,
    method: 'issues.update' | 'issues.soft-delete' | 'issues.undelete',
    request: RemoteHostIssueMutationTargetDto,
    invoke: (scope: RemoteHostScopedClient) => Promise<unknown>,
  ): Promise<RemoteHostIssueMutationResultDto> {
    return this.request(
      request.profileId,
      method,
      async (scope) => parseIssueMutationResult(await invoke(scope), request.issueId),
      [],
      request.expectedAuthority,
    );
  }

  private options(
    operation: string,
    request: RemoteHostIssueMutationTargetDto,
  ): { deadlineMs: number; expectedRevision: number; idempotencyKey: string } {
    return {
      deadlineMs: REMOTE_HOST_INTERACTIVE_DEADLINE_MS,
      expectedRevision: request.expectedRevision,
      idempotencyKey: this.mutationId(operation, request.profileId, request.intentId),
    };
  }
}
