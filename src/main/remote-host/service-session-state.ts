import {
  parseSessionContextGetResult,
  parseSessionInputCapabilitiesResult,
} from '@contracts/index';
import type {
  RemoteHostPendingListDto,
  RemoteHostPendingResponseDto,
  RemoteHostPendingResponseResultDto,
  RemoteHostSessionContextDto,
  RemoteHostSessionInputCapabilitiesDto,
  RemoteHostSessionTargetDto,
} from '@shared/remote-host';

import {
  parseRemoteHostPendingListResult,
  parseRemoteHostPendingResponseResult,
} from './business-validation';
import { authorizeRemoteHostPendingResponse } from './pending-response-policy';
import { requestRemotePending } from './service-session-detail';
import {
  REMOTE_HOST_INTERACTIVE_DEADLINE_MS,
  type RemoteHostScopedClient,
  type RemoteHostScopedRequest,
} from './service-scope';

type MutationId = (operation: string, profileId: string, intentId: string) => string;

/** Session state reads and presentation-bound pending responses. */
export class RemoteHostSessionStateController {
  constructor(
    private readonly request: RemoteHostScopedRequest,
    private readonly assertScope: (scope: RemoteHostScopedClient) => void,
    private readonly mutationId: MutationId,
  ) {}

  context(request: RemoteHostSessionTargetDto): Promise<RemoteHostSessionContextDto> {
    return this.request(request.profileId, 'session.context.get', async (scope) =>
      parseSessionContextGetResult(await scope.client.request(
        'session.context.get',
        { sessionId: request.sessionId },
        { deadlineMs: REMOTE_HOST_INTERACTIVE_DEADLINE_MS },
      )));
  }

  inputCapabilities(
    request: RemoteHostSessionTargetDto,
  ): Promise<RemoteHostSessionInputCapabilitiesDto> {
    return this.request(request.profileId, 'session.input.capabilities', async (scope) =>
      parseSessionInputCapabilitiesResult(await scope.client.request(
        'session.input.capabilities',
        { sessionId: request.sessionId },
        { deadlineMs: REMOTE_HOST_INTERACTIVE_DEADLINE_MS },
      )));
  }

  pending(request: RemoteHostSessionTargetDto): Promise<RemoteHostPendingListDto> {
    return this.request(request.profileId, 'pending.list', (scope) =>
      requestRemotePending(scope, request));
  }

  respond(request: RemoteHostPendingResponseDto): Promise<RemoteHostPendingResponseResultDto> {
    return this.request(request.profileId, 'pending.respond', async (scope) => {
      const pendingValue = await scope.client.request(
        'pending.list',
        { sessionId: request.sessionId },
        { deadlineMs: REMOTE_HOST_INTERACTIVE_DEADLINE_MS },
      );
      this.assertScope(scope);
      const pending = parseRemoteHostPendingListResult(pendingValue, request.sessionId);
      const expectedRevision = authorizeRemoteHostPendingResponse(pending, request);
      this.assertScope(scope);
      const value = await scope.client.request(
        'pending.respond',
        {
          sessionId: request.sessionId,
          requestId: request.requestId,
          action: request.action,
          ...(request.value === undefined ? {} : { value: request.value }),
        },
        {
          deadlineMs: REMOTE_HOST_INTERACTIVE_DEADLINE_MS,
          idempotencyKey: this.mutationId('pending', request.profileId, request.intentId),
          expectedRevision,
        },
      );
      return parseRemoteHostPendingResponseResult(value);
    }, ['pending.list']);
  }
}
