import { CORE_METHOD_METADATA, type CoreMethod } from '@contracts/index';
import type { ElectronHostRegistry } from '@hosts/electron';
import type {
  RemoteHostMutationAuthorityDto,
  RemoteHostSourceMode,
} from '@shared/remote-host';
import { RemoteHostPublicError } from './errors';
import { remoteHostMutationId } from './mutation-identity';
import { isRemoteDesktopProductMethod } from './product-method-directory';
import {
  RemoteHostScopeEpochs,
  type RemoteHostScopedClient,
  type RemoteHostScopedRequest,
  type RemoteHostTerminalScopedRequest,
} from './service-scope';

interface Options {
  registry: ElectronHostRegistry;
  scopes: RemoteHostScopeEpochs;
  active(): boolean;
  source(): { mode: RemoteHostSourceMode; selectedProfileId: string | null };
}

/** Connected-only admission and identity fencing for desktop Remote business calls. */
export class RemoteHostRequestAuthority {
  constructor(private readonly options: Options) {}

  readonly request: RemoteHostScopedRequest = async (
    profileId,
    method,
    run,
    additionalMethods = [],
    expectedAuthority,
  ) => {
    const scope = this.begin(profileId, method, additionalMethods, expectedAuthority);
    try {
      const result = await run(scope);
      this.assertScope(scope);
      return result;
    } catch (error) {
      this.assertScope(scope);
      throw error;
    }
  };

  readonly requestTerminal: RemoteHostTerminalScopedRequest = async (
    profileId,
    method,
    run,
    onCurrent,
    additionalMethods = [],
    expectedAuthority,
  ) => {
    const scope = this.begin(profileId, method, additionalMethods, expectedAuthority);
    try {
      const result = await run(scope);
      const scopeCurrent = this.isCurrent(scope);
      if (scopeCurrent) onCurrent?.(result);
      return { result, scopeCurrent };
    } catch (error) {
      this.assertScope(scope);
      throw error;
    }
  };

  assertScope(scope: RemoteHostScopedClient): void {
    this.assertActive();
    if (!this.isCurrent(scope)) {
      throw new RemoteHostPublicError('stale_scope', '当前主机或连接已切换，请重试。');
    }
  }

  mutationId(scope: string, profileId: string, intentId: string): string {
    const { authoritativeCoreId, workerGeneration } = this.options.registry.state(profileId);
    return remoteHostMutationId(scope, profileId, authoritativeCoreId, workerGeneration, intentId);
  }

  private begin(
    profileId: string,
    method: CoreMethod,
    additionalMethods: readonly CoreMethod[],
    expectedAuthority?: RemoteHostMutationAuthorityDto,
  ): RemoteHostScopedClient {
    this.assertActive();
    const source = this.options.source();
    if (![method, ...additionalMethods].every(isRemoteDesktopProductMethod)) {
      throw new RemoteHostPublicError(
        'capability_unavailable',
        '远程 Core 不支持此操作。',
      );
    }
    if (source.mode !== 'remote' || source.selectedProfileId !== profileId) {
      throw new RemoteHostPublicError('stale_scope', '当前主机已切换，请重试。');
    }
    if (CORE_METHOD_METADATA[method].mutation && !expectedAuthority) {
      throw new RemoteHostPublicError('stale_scope', '远程写入缺少来源权威，请重试。');
    }
    const state = this.options.registry.state(profileId);
    if (state.status !== 'connected') {
      throw new RemoteHostPublicError('not_connected', '请先连接远程主机。');
    }
    if (
      expectedAuthority &&
      (
        state.authoritativeCoreId !== expectedAuthority.authoritativeCoreId ||
        state.workerGeneration !== expectedAuthority.workerGeneration
      )
    ) {
      throw new RemoteHostPublicError('stale_scope', '远程 Core 已切换，请重试。');
    }
    const client = this.options.registry.getClient(profileId);
    if (!client) throw new RemoteHostPublicError('not_connected', '请先连接远程主机。');
    for (const requiredMethod of [method, ...additionalMethods]) {
      const capability = CORE_METHOD_METADATA[requiredMethod].capability;
      if (!state.capabilities.includes(capability)) {
        throw new RemoteHostPublicError('capability_unavailable', '远程 Core 不支持此操作。');
      }
    }
    return this.options.scopes.capture(profileId, client);
  }

  private isCurrent(scope: RemoteHostScopedClient): boolean {
    const source = this.options.source();
    return this.options.active() &&
      this.options.scopes.isCurrent(scope) &&
      source.mode === 'remote' &&
      source.selectedProfileId === scope.profileId &&
      this.options.registry.getClient(scope.profileId) === scope.client;
  }

  private assertActive(): void {
    if (!this.options.active()) {
      throw new RemoteHostPublicError('service_stopped', '远程主机服务已停止。');
    }
  }
}
