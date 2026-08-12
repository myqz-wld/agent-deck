import {
  parseSessionHandOffCommitResult,
  parseSessionHandOffPreviewResult,
} from '@contracts/index';
import type {
  RemoteHostHandOffCommitDto,
  RemoteHostHandOffCommitRequestDto,
  RemoteHostHandOffPreviewDto,
  RemoteHostHandOffPreviewRequestDto,
} from '@shared/remote-host';

import type {
  RemoteHostScopedRequest,
  RemoteHostTerminalScopedRequest,
} from './service-scope';
import { REMOTE_HOST_HANDOFF_DEADLINE_MS } from './service-scope';

type MutationId = (operation: string, profileId: string, intentId: string) => string;

/** Desktop authority for Core-owned, preview-bound Remote handoff. */
export class RemoteHostSessionHandOffController {
  constructor(
    private readonly request: RemoteHostScopedRequest,
    private readonly requestTerminal: RemoteHostTerminalScopedRequest,
    private readonly mutationId: MutationId,
    private readonly selectSuccessor: (profileId: string, sessionId: string) => void,
  ) {}

  preview(request: RemoteHostHandOffPreviewRequestDto): Promise<RemoteHostHandOffPreviewDto> {
    return this.request(request.profileId, 'session.handoff.preview', async (scope) =>
      parseSessionHandOffPreviewResult(await scope.client.request(
        'session.handoff.preview',
        this.params(request),
        { deadlineMs: REMOTE_HOST_HANDOFF_DEADLINE_MS },
      )));
  }

  commit(request: RemoteHostHandOffCommitRequestDto): Promise<RemoteHostHandOffCommitDto> {
    return this.requestTerminal(
      request.profileId,
      'session.handoff.commit',
      async (scope) => parseSessionHandOffCommitResult(await scope.client.request(
        'session.handoff.commit',
        {
          ...this.params(request),
          expectedBindingDigest: request.expectedBindingDigest,
        },
        {
          deadlineMs: REMOTE_HOST_HANDOFF_DEADLINE_MS,
          idempotencyKey: this.mutationId('handoff', request.profileId, request.intentId),
        },
      )),
      (result) => this.selectSuccessor(request.profileId, result.successorSessionId),
      [],
      request.expectedAuthority,
    ).then(({ result }) => result);
  }

  private params(request: RemoteHostHandOffPreviewRequestDto) {
    return {
      sessionId: request.sessionId,
      continuationInstruction: request.continuationInstruction,
      target: request.target,
    };
  }
}
