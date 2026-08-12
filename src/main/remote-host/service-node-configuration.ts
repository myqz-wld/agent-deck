import {
  parseNodeConfigurationGetResult,
  parseNodeHookProjectionResult,
} from '@contracts/index';
import type {
  RemoteHostNodeConfigurationDto,
  RemoteHostNodeConfigurationRequestDto,
  RemoteHostNodeHookMutationDto,
  RemoteHostNodeHookRequestDto,
  RemoteHostNodeHookStatusDto,
} from '@shared/remote-host';

import type { RemoteHostScopedRequest } from './service-detail-reader';
import { RemoteHostPublicError } from './errors';
import { REMOTE_HOST_INTERACTIVE_DEADLINE_MS } from './service-scope';

type MutationId = (operation: string, profileId: string, intentId: string) => string;

/** Reads and mutates only the selected Remote Core's execution-node configuration. */
export class RemoteHostNodeConfigurationController {
  constructor(
    private readonly request: RemoteHostScopedRequest,
    private readonly mutationId: MutationId,
  ) {}

  get(
    request: RemoteHostNodeConfigurationRequestDto,
  ): Promise<RemoteHostNodeConfigurationDto> {
    return this.request(request.profileId, 'node.configuration.get', async (scope) =>
      parseNodeConfigurationGetResult(await scope.client.request(
        'node.configuration.get',
        {},
        { deadlineMs: REMOTE_HOST_INTERACTIVE_DEADLINE_MS },
      )));
  }

  status(request: RemoteHostNodeHookRequestDto): Promise<RemoteHostNodeHookStatusDto> {
    return this.request(request.profileId, 'node.hook.projection.get', async (scope) =>
      this.assertAdapter(request.adapterId, parseNodeHookProjectionResult(await scope.client.request(
        'node.hook.projection.get',
        { adapterId: request.adapterId },
        { deadlineMs: REMOTE_HOST_INTERACTIVE_DEADLINE_MS },
      ))));
  }

  install(request: RemoteHostNodeHookMutationDto): Promise<RemoteHostNodeHookStatusDto> {
    return this.mutate('install', 'node.hook.projection.install', request);
  }

  uninstall(request: RemoteHostNodeHookMutationDto): Promise<RemoteHostNodeHookStatusDto> {
    return this.mutate('uninstall', 'node.hook.projection.uninstall', request);
  }

  private mutate(
    operation: 'install' | 'uninstall',
    method: 'node.hook.projection.install' | 'node.hook.projection.uninstall',
    request: RemoteHostNodeHookMutationDto,
  ): Promise<RemoteHostNodeHookStatusDto> {
    return this.request(
      request.profileId,
      method,
      async (scope) => this.assertAdapter(
        request.adapterId,
        parseNodeHookProjectionResult(await scope.client.request(
          method,
          { adapterId: request.adapterId },
          {
            deadlineMs: REMOTE_HOST_INTERACTIVE_DEADLINE_MS,
            idempotencyKey: this.mutationId(
              `node-hook-${operation}`,
              request.profileId,
              request.intentId,
            ),
          },
        )),
      ),
      [],
      request.expectedAuthority,
    );
  }

  private assertAdapter(
    expected: RemoteHostNodeHookRequestDto['adapterId'],
    result: RemoteHostNodeHookStatusDto,
  ): RemoteHostNodeHookStatusDto {
    if (result.adapterId !== expected) {
      throw new RemoteHostPublicError(
        'protocol_violation',
        '远程 Hook 状态与请求的 Provider 不一致。',
      );
    }
    return result;
  }
}
