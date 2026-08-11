import {
  parseNodeConfigurationGetResult,
  parseNodeHookStatusResult,
} from '@contracts/index';
import type {
  RemoteHostNodeConfigurationDto,
  RemoteHostNodeConfigurationRequestDto,
  RemoteHostNodeHookMutationDto,
  RemoteHostNodeHookRequestDto,
  RemoteHostNodeHookStatusDto,
} from '@shared/remote-host';

import type { RemoteHostScopedRequest } from './service-detail-reader';
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
    return this.request(request.profileId, 'node.hook.status', async (scope) =>
      parseNodeHookStatusResult(await scope.client.request(
        'node.hook.status',
        { adapterId: request.adapterId },
        { deadlineMs: REMOTE_HOST_INTERACTIVE_DEADLINE_MS },
      )));
  }

  install(request: RemoteHostNodeHookMutationDto): Promise<RemoteHostNodeHookStatusDto> {
    return this.mutate('install', 'node.hook.install', request);
  }

  uninstall(request: RemoteHostNodeHookMutationDto): Promise<RemoteHostNodeHookStatusDto> {
    return this.mutate('uninstall', 'node.hook.uninstall', request);
  }

  private mutate(
    operation: 'install' | 'uninstall',
    method: 'node.hook.install' | 'node.hook.uninstall',
    request: RemoteHostNodeHookMutationDto,
  ): Promise<RemoteHostNodeHookStatusDto> {
    return this.request(request.profileId, method, async (scope) =>
      parseNodeHookStatusResult(await scope.client.request(
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
      )));
  }
}
