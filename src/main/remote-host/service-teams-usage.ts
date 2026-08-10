import {
  parseTeamAddMemberResult,
  parseTeamGetResult,
  parseTeamListResult,
  parseTeamMutationResult,
  parseTeamShutdownResult,
  parseUsageProviderResult,
  parseUsageTokenResult,
} from '@contracts/index';
import type {
  RemoteHostTeamAddMemberDto,
  RemoteHostTeamAddMemberResultDto,
  RemoteHostTeamGetDto,
  RemoteHostTeamListDto,
  RemoteHostTeamListRequestDto,
  RemoteHostTeamMutationResultDto,
  RemoteHostTeamMutationTargetDto,
  RemoteHostTeamShutdownResultDto,
  RemoteHostTeamTargetDto,
  RemoteHostUsageProviderDto,
  RemoteHostUsageProviderRequestDto,
  RemoteHostUsageTokenDto,
  RemoteHostUsageTokenRequestDto,
} from '@shared/remote-host';
import type { RemoteHostScopedRequest } from './service-detail-reader';
import { REMOTE_HOST_INTERACTIVE_DEADLINE_MS } from './service-scope';

type MutationId = (operation: string, profileId: string, intentId: string) => string;

export class RemoteHostTeamController {
  constructor(
    private readonly request: RemoteHostScopedRequest,
    private readonly mutationId: MutationId,
  ) {}

  list(request: RemoteHostTeamListRequestDto): Promise<RemoteHostTeamListDto> {
    return this.request(request.profileId, 'teams.list', async (scope) =>
      parseTeamListResult(await scope.client.request('teams.list', {
        includeArchived: request.includeArchived,
        limit: request.limit,
      }, { deadlineMs: REMOTE_HOST_INTERACTIVE_DEADLINE_MS }), request.limit,
      request.includeArchived));
  }

  get(request: RemoteHostTeamTargetDto): Promise<RemoteHostTeamGetDto> {
    return this.request(request.profileId, 'teams.get', async (scope) =>
      parseTeamGetResult(await scope.client.request(
        'teams.get',
        { teamId: request.teamId },
        { deadlineMs: REMOTE_HOST_INTERACTIVE_DEADLINE_MS },
      ), request.teamId));
  }

  archive(
    request: RemoteHostTeamMutationTargetDto,
  ): Promise<RemoteHostTeamMutationResultDto> {
    return this.request(request.profileId, 'teams.archive', async (scope) =>
      parseTeamMutationResult(await scope.client.request(
        'teams.archive',
        { teamId: request.teamId },
        this.options('archive', request),
      ), request.teamId));
  }

  addMember(request: RemoteHostTeamAddMemberDto): Promise<RemoteHostTeamAddMemberResultDto> {
    return this.request(request.profileId, 'teams.add-member', async (scope) =>
      parseTeamAddMemberResult(await scope.client.request('teams.add-member', {
        teamId: request.teamId,
        sessionId: request.sessionId,
        role: request.role,
      }, this.options('add-member', request)), request));
  }

  shutdownTeammates(
    request: RemoteHostTeamMutationTargetDto,
  ): Promise<RemoteHostTeamShutdownResultDto> {
    return this.request(request.profileId, 'teams.shutdown-teammates', async (scope) =>
      parseTeamShutdownResult(await scope.client.request(
        'teams.shutdown-teammates',
        { teamId: request.teamId },
        this.options('shutdown-teammates', request),
      )));
  }

  private options(
    operation: string,
    request: RemoteHostTeamMutationTargetDto,
  ): { deadlineMs: number; expectedRevision: number; idempotencyKey: string } {
    return {
      deadlineMs: REMOTE_HOST_INTERACTIVE_DEADLINE_MS,
      expectedRevision: request.expectedRevision,
      idempotencyKey: this.mutationId(operation, request.profileId, request.intentId),
    };
  }
}

export class RemoteHostUsageController {
  constructor(private readonly request: RemoteHostScopedRequest) {}

  tokens(request: RemoteHostUsageTokenRequestDto): Promise<RemoteHostUsageTokenDto> {
    return this.request(request.profileId, 'usage.tokens.get', async (scope) =>
      parseUsageTokenResult(await scope.client.request('usage.tokens.get', {
        includeDaily: request.includeDaily,
        dailyLimit: request.dailyLimit,
      }, { deadlineMs: REMOTE_HOST_INTERACTIVE_DEADLINE_MS }), request.dailyLimit));
  }

  providers(request: RemoteHostUsageProviderRequestDto): Promise<RemoteHostUsageProviderDto> {
    return this.request(request.profileId, 'usage.providers.get', async (scope) =>
      parseUsageProviderResult(await scope.client.request(
        'usage.providers.get',
        { force: request.force },
        { deadlineMs: REMOTE_HOST_INTERACTIVE_DEADLINE_MS },
      )));
  }
}
