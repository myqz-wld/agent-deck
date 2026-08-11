import type {
  RemoteHostAcceptedResultDto,
  RemoteHostMutationTargetDto,
  RemoteHostRuntimeControlsDto,
  RemoteHostRuntimeUpdateDto,
  RemoteHostRuntimeUpdateResultDto,
  RemoteHostSendDto,
  RemoteHostSendResultDto,
  RemoteHostSessionTargetDto,
} from '@shared/remote-host';

import {
  parseRemoteHostAcceptedResult,
  parseRemoteHostRuntimeUpdateResult,
  parseRemoteHostSendResult,
} from './business-validation';
import type { RemoteHostScopedRequest } from './service-detail-reader';
import { requestRemoteRuntime } from './service-session-detail';
import { REMOTE_HOST_INTERACTIVE_DEADLINE_MS } from './service-scope';

type MutationId = (operation: string, profileId: string, intentId: string) => string;

/** Session mutations share one Remote scope, deadline, and idempotency boundary. */
export class RemoteHostSessionMutationController {
  constructor(
    private readonly request: RemoteHostScopedRequest,
    private readonly mutationId: MutationId,
  ) {}

  send(request: RemoteHostSendDto): Promise<RemoteHostSendResultDto> {
    return this.request(request.profileId, 'session.send', async (scope) =>
      parseRemoteHostSendResult(await scope.client.request('session.send', {
        sessionId: request.sessionId,
        text: request.text,
        ...(request.attachments === undefined ? {} : { attachments: request.attachments }),
      }, this.options('send', request))));
  }

  interrupt(request: RemoteHostMutationTargetDto): Promise<RemoteHostAcceptedResultDto> {
    return this.request(request.profileId, 'session.interrupt', async (scope) =>
      parseRemoteHostAcceptedResult(await scope.client.request(
        'session.interrupt',
        { sessionId: request.sessionId },
        this.options('interrupt', request),
      )));
  }

  steer(request: RemoteHostSendDto): Promise<RemoteHostAcceptedResultDto> {
    return this.request(request.profileId, 'session.steer', async (scope) =>
      parseRemoteHostAcceptedResult(await scope.client.request(
        'session.steer',
        {
          sessionId: request.sessionId,
          text: request.text,
          ...(request.attachments === undefined ? {} : { attachments: request.attachments }),
        },
        this.options('steer', request),
      )));
  }

  runtime(request: RemoteHostSessionTargetDto): Promise<RemoteHostRuntimeControlsDto> {
    return this.request(request.profileId, 'session.runtime.get', (scope) =>
      requestRemoteRuntime(scope, request));
  }

  updateRuntime(
    request: RemoteHostRuntimeUpdateDto,
  ): Promise<RemoteHostRuntimeUpdateResultDto> {
    return this.request(request.profileId, 'session.runtime.update', async (scope) =>
      parseRemoteHostRuntimeUpdateResult(await scope.client.request(
        'session.runtime.update',
        { sessionId: request.sessionId, patch: request.patch },
        {
          ...this.options('runtime', request),
          expectedRevision: request.expectedRevision,
        },
      )));
  }

  private options(
    operation: string,
    request: RemoteHostMutationTargetDto,
  ): { deadlineMs: number; idempotencyKey: string } {
    return {
      deadlineMs: REMOTE_HOST_INTERACTIVE_DEADLINE_MS,
      idempotencyKey: this.mutationId(operation, request.profileId, request.intentId),
    };
  }
}
