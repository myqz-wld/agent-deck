import {
  parseSessionMessagesListResult,
  parseSessionOutgoingListResult,
  parseSessionOutgoingRemoveResult,
} from '@contracts/index';
import type {
  RemoteHostSessionMessagesDto,
  RemoteHostSessionMessagesRequestDto,
  RemoteHostSessionOutgoingDto,
  RemoteHostSessionOutgoingRemoveDto,
  RemoteHostSessionOutgoingRemoveRequestDto,
  RemoteHostSessionOutgoingRequestDto,
} from '@shared/remote-host';

import {
  REMOTE_HOST_INTERACTIVE_DEADLINE_MS,
  type RemoteHostScopedRequest,
} from './service-scope';

/** Main-process identity fence and second parser for detail metadata projections. */
export class RemoteHostSessionMetadataController {
  constructor(
    private readonly request: RemoteHostScopedRequest,
    private readonly mutationId: (operation: string, profileId: string, intentId: string) => string,
  ) {}

  messages(request: RemoteHostSessionMessagesRequestDto): Promise<RemoteHostSessionMessagesDto> {
    return this.request(request.profileId, 'session.messages.list', async (scope) =>
      parseSessionMessagesListResult(await scope.client.request(
        'session.messages.list',
        { sessionId: request.sessionId, limit: request.limit },
        { deadlineMs: REMOTE_HOST_INTERACTIVE_DEADLINE_MS },
      ), request.sessionId, request.limit));
  }

  outgoing(request: RemoteHostSessionOutgoingRequestDto): Promise<RemoteHostSessionOutgoingDto> {
    return this.request(request.profileId, 'session.outgoing.list', async (scope) => {
      const parsed = parseSessionOutgoingListResult(await scope.client.request(
        'session.outgoing.list',
        { sessionId: request.sessionId },
        { deadlineMs: REMOTE_HOST_INTERACTIVE_DEADLINE_MS },
      ));
      if (parsed.sessionId !== request.sessionId || parsed.adapterId !== request.adapterId) {
        throw new Error('Remote outgoing queue identity changed');
      }
      return parsed;
    });
  }

  removeOutgoing(
    request: RemoteHostSessionOutgoingRemoveRequestDto,
  ): Promise<RemoteHostSessionOutgoingRemoveDto> {
    return this.request(request.profileId, 'session.outgoing.remove', async (scope) =>
      parseSessionOutgoingRemoveResult(await scope.client.request(
        'session.outgoing.remove',
        { sessionId: request.sessionId, messageId: request.messageId },
        {
          deadlineMs: REMOTE_HOST_INTERACTIVE_DEADLINE_MS,
          idempotencyKey: this.mutationId('outgoing-remove', request.profileId, request.intentId),
        },
      )), [], request.expectedAuthority);
  }
}
