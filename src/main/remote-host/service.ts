import { CORE_METHOD_METADATA, type CoreMethod } from '@contracts/index';
import type { ElectronHostRegistry } from '@hosts/electron';
import type {
  RemoteHostAcceptedResultDto,
  RemoteHostCreateSessionDto,
  RemoteHostConnectionSelectionDto,
  RemoteHostHistoryPageDto,
  RemoteHostHistoryRequestDto,
  RemoteHostMutationTargetDto,
  RemoteHostPageRequestDto,
  RemoteHostPendingListDto,
  RemoteHostPendingResponseDto,
  RemoteHostPendingResponseResultDto,
  RemoteHostProfileDraftDto,
  RemoteHostProjectPageDto,
  RemoteHostRuntimeControlsDto,
  RemoteHostRuntimeUpdateDto,
  RemoteHostRuntimeUpdateResultDto,
  RemoteHostSendDto,
  RemoteHostSendResultDto,
  RemoteHostSessionPageDto,
  RemoteHostSessionPageRequestDto,
  RemoteHostSessionCapabilitiesDto,
  RemoteHostSessionCapabilitiesRequestDto,
  RemoteHostSessionSummaryDto,
  RemoteHostSessionTargetDto,
  RemoteHostSnapshotDto,
  RemoteHostSourceMode,
  RemoteHostWorkspaceDirectoryListDto,
  RemoteHostWorkspaceDirectoryRequestDto,
} from '@shared/remote-host';
import { isRecoverableRelayWorkerOffline } from '@shared/remote-host';
import {
  parseRemoteHostAcceptedResult,
  parseRemoteHostPendingListResult,
  parseRemoteHostPendingResponseResult,
  parseRemoteHostRuntimeUpdateResult,
  parseRemoteHostSendResult,
} from './business-validation';
import type { RemoteHostConnectionSelections } from './connection-selections';
import type { RemoteHostCredentialMaterialStore } from './credential-material-store';
import { RemoteHostPublicError } from './errors';
import { publishRemoteHostChanged } from './event-bridge';
import { authorizeRemoteHostPendingResponse } from './pending-response-policy';
import { remoteHostMutationId } from './mutation-identity';
import { RemoteHostProfileController } from './profile-controller';
import type { RemoteHostProfileStore } from './profile-store';
import { remoteHostSnapshot } from './service-snapshot';
import {
  requestRemoteProjects,
  requestRemoteSession,
  requestRemoteSessionCapabilities,
  requestRemoteSessionCreate,
  requestRemoteSessions,
  requestRemoteWorkspaceDirectories,
} from './service-session-console';
import { RemoteHostDetailReader } from './service-detail-reader';
import { RemoteHostIssueController } from './service-issues';
import { RemoteHostPlanReviewController } from './service-plan-review';
import { RemoteHostTeamController, RemoteHostUsageController } from './service-teams-usage';
import {
  requestRemoteHistory,
  requestRemotePending,
  requestRemoteRuntime,
} from './service-session-detail';
import {
  REMOTE_HOST_INTERACTIVE_DEADLINE_MS,
  RemoteHostScopeEpochs,
  type RemoteHostScopedClient,
} from './service-scope';
import type { RemoteHostDesktopBrokerPort } from './desktop-browser-broker';

export interface RemoteHostServiceOptions {
  registry: ElectronHostRegistry;
  store: RemoteHostProfileStore;
  connections: RemoteHostConnectionSelections;
  materials: RemoteHostCredentialMaterialStore;
  createId: () => string;
  desktopBroker?: RemoteHostDesktopBrokerPort;
}
export class RemoteHostService {
  readonly detail: RemoteHostDetailReader; readonly issues: RemoteHostIssueController;
  readonly planReviews: RemoteHostPlanReviewController;
  readonly teams: RemoteHostTeamController; readonly usage: RemoteHostUsageController;
  private readonly profiles: RemoteHostProfileController;
  private mutationTail: Promise<void> = Promise.resolve();
  private lifecycle: 'active' | 'shutting-down' | 'stopped' = 'active';
  private shutdownPromise: Promise<void> | null = null;
  private snapshotRevision = 0;
  private readonly scopes = new RemoteHostScopeEpochs();
  private readonly hostIdentityByProfile = new Map<string, string>();
  private readonly desktopBroker: RemoteHostDesktopBrokerPort;
  constructor(private readonly options: RemoteHostServiceOptions) {
    this.desktopBroker = options.desktopBroker ?? {
      handleState: () => undefined,
      handleEvent: () => undefined,
      stop: () => Promise.resolve(),
    };
    const requestScoped = this.requestScoped.bind(this);
    const mutationId = this.mutationId.bind(this);
    this.detail = new RemoteHostDetailReader(requestScoped);
    this.issues = new RemoteHostIssueController(requestScoped, mutationId);
    this.planReviews = new RemoteHostPlanReviewController(
      requestScoped,
      (scope) => this.assertScope(scope),
      mutationId,
    );
    this.teams = new RemoteHostTeamController(requestScoped, mutationId);
    this.usage = new RemoteHostUsageController(requestScoped);
    const document = options.store.load();
    this.profiles = new RemoteHostProfileController(document, {
      registry: options.registry,
      store: options.store,
      connections: options.connections,
      materials: options.materials,
      createId: options.createId,
      onProfileRescope: (profileId) => this.scopes.bumpProfile(profileId),
      onSourceRescope: () => this.scopes.bumpSource(),
    });
    options.registry.onState((state) => {
      this.desktopBroker.handleState(state);
      const identity = `${state.authoritativeCoreId ?? ''}:${state.workerGeneration ?? ''}`;
      const previousIdentity = this.hostIdentityByProfile.get(state.profileId);
      this.hostIdentityByProfile.set(state.profileId, identity);
      if (
        state.status === 'connecting' ||
        state.status === 'reconnecting' ||
        (previousIdentity !== undefined && previousIdentity !== identity)
      ) {
        this.scopes.bumpProfile(state.profileId);
      }
      this.changed('state', state.profileId);
    });
    options.registry.onEvent((event) => {
      this.desktopBroker.handleEvent(event);
      this.changed('data', event.profileId);
    });
  }
  getSnapshot(): Promise<RemoteHostSnapshotDto> {
    return this.mutationTail.then(() => this.snapshot());
  }

  addProfile(draft: RemoteHostProfileDraftDto): Promise<RemoteHostSnapshotDto> {
    return this.mutateActive(async () => {
      await this.profiles.add(draft);
      this.changed('profiles', null);
      return this.snapshot();
    });
  }

  updateProfile(
    profileId: string,
    draft: RemoteHostProfileDraftDto,
  ): Promise<RemoteHostSnapshotDto> {
    return this.mutateActive(async () => {
      await this.profiles.update(profileId, draft);
      this.changed('profiles', profileId);
      return this.snapshot();
    });
  }

  removeProfile(profileId: string): Promise<RemoteHostSnapshotDto> {
    return this.mutateActive(async () => {
      await this.profiles.remove(profileId);
      this.changed('profiles', profileId);
      return this.snapshot();
    });
  }

  selectProfile(profileId: string): Promise<RemoteHostSnapshotDto> {
    return this.mutateActive(() => {
      this.profiles.select(profileId);
      this.changed('selection', profileId);
      return this.snapshot();
    });
  }

  setSourceMode(mode: RemoteHostSourceMode): Promise<RemoteHostSnapshotDto> {
    return this.mutateActive(() => {
      this.profiles.setSourceMode(mode);
      this.changed('selection', this.profiles.selectedRemoteProfileId);
      return this.snapshot();
    });
  }

  connect(profileId: string): Promise<RemoteHostSnapshotDto> {
    try {
      this.assertActive();
    } catch (error) {
      return Promise.reject(error);
    }
    const wasActiveSource = (
      this.profiles.sourceMode === 'remote' &&
      this.profiles.selectedRemoteProfileId === profileId
    );
    const sourceEpoch = this.scopes.captureSource();
    this.scopes.bumpProfile(profileId);
    return this.profiles.connect(profileId).then(() => {
      this.assertActive();
      if (
        wasActiveSource &&
        (!this.scopes.isSourceCurrent(sourceEpoch) ||
          this.profiles.sourceMode !== 'remote' ||
          this.profiles.selectedRemoteProfileId !== profileId)
      ) {
        throw new RemoteHostPublicError('stale_scope', '当前主机已切换，请重试。');
      }
      return this.snapshot();
    });
  }

  disconnect(profileId: string): Promise<RemoteHostSnapshotDto> {
    return this.mutateActive(async () => {
      await this.profiles.disconnect(profileId);
      return this.snapshot();
    });
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.lifecycle = 'shutting-down';
    this.scopes.bumpSource();
    const retirement = Promise.resolve().then(async () => {
      const runCleanup = async (cleanup: () => Promise<void>): Promise<void> => cleanup();
      const results = await Promise.allSettled([
        runCleanup(() => this.desktopBroker.stop()),
        runCleanup(() => this.profiles.stopAll()),
      ]);
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []);
      if (failures.length > 0) throw new AggregateError(failures, 'Remote host cleanup failed');
    });
    this.shutdownPromise = retirement.then(
      () => { this.lifecycle = 'stopped'; },
      (error: unknown) => {
        this.lifecycle = 'stopped';
        throw error;
      },
    );
    return this.shutdownPromise;
  }

  captureConnection(path: string): RemoteHostConnectionSelectionDto {
    this.assertActive();
    return this.options.connections.capture(path);
  }

  async listSessions(request: RemoteHostSessionPageRequestDto): Promise<RemoteHostSessionPageDto> {
    return this.requestScoped(request.profileId, 'session.console.list', (scope) =>
      requestRemoteSessions(scope, request));
  }

  async getSession(request: RemoteHostSessionTargetDto): Promise<RemoteHostSessionSummaryDto | null> {
    return this.requestScoped(request.profileId, 'session.console.get', (scope) =>
      requestRemoteSession(scope, request));
  }

  async listProjects(request: RemoteHostPageRequestDto): Promise<RemoteHostProjectPageDto> {
    return this.requestScoped(request.profileId, 'project.list', (scope) =>
      requestRemoteProjects(scope, request));
  }

  async getSessionCapabilities(
    request: RemoteHostSessionCapabilitiesRequestDto,
  ): Promise<RemoteHostSessionCapabilitiesDto> {
    return this.requestScoped(request.profileId, 'session.console.capabilities', (scope) =>
      requestRemoteSessionCapabilities(scope, request));
  }

  async listWorkspaceDirectories(
    request: RemoteHostWorkspaceDirectoryRequestDto,
  ): Promise<RemoteHostWorkspaceDirectoryListDto> {
    return this.requestScoped(request.profileId, 'workspace.directory.list', (scope) =>
      requestRemoteWorkspaceDirectories(scope, request));
  }

  async createSession(request: RemoteHostCreateSessionDto): Promise<{ sessionId: string; revision: number }> {
    return this.requestScoped(request.profileId, 'session.console.create', async (scope) => {
      const parsed = await requestRemoteSessionCreate(
        scope,
        request,
        this.mutationId('create', request.profileId, request.intentId),
      );
      this.options.registry.updateNavigation(request.profileId, { selectedSessionId: parsed.sessionId });
      return parsed;
    });
  }

  async listHistory(request: RemoteHostHistoryRequestDto): Promise<RemoteHostHistoryPageDto> {
    return this.requestScoped(request.profileId, 'session.history', (scope) =>
      requestRemoteHistory(scope, request));
  }

  async send(request: RemoteHostSendDto): Promise<RemoteHostSendResultDto> {
    return this.requestScoped(request.profileId, 'session.send', async (scope) => {
      const value = await scope.client.request(
        'session.send',
        { sessionId: request.sessionId, text: request.text },
        {
          deadlineMs: REMOTE_HOST_INTERACTIVE_DEADLINE_MS,
          idempotencyKey: this.mutationId('send', request.profileId, request.intentId),
        },
      );
      return parseRemoteHostSendResult(value);
    });
  }

  async interrupt(request: RemoteHostMutationTargetDto): Promise<RemoteHostAcceptedResultDto> {
    return this.requestScoped(request.profileId, 'session.interrupt', async (scope) => {
      const value = await scope.client.request(
        'session.interrupt',
        { sessionId: request.sessionId },
        {
          deadlineMs: REMOTE_HOST_INTERACTIVE_DEADLINE_MS,
          idempotencyKey: this.mutationId('interrupt', request.profileId, request.intentId),
        },
      );
      return parseRemoteHostAcceptedResult(value);
    });
  }

  async steer(request: RemoteHostSendDto): Promise<RemoteHostAcceptedResultDto> {
    return this.requestScoped(request.profileId, 'session.steer', async (scope) => {
      const value = await scope.client.request(
        'session.steer',
        { sessionId: request.sessionId, text: request.text },
        {
          deadlineMs: REMOTE_HOST_INTERACTIVE_DEADLINE_MS,
          idempotencyKey: this.mutationId('steer', request.profileId, request.intentId),
        },
      );
      return parseRemoteHostAcceptedResult(value);
    });
  }

  async listPending(request: RemoteHostSessionTargetDto): Promise<RemoteHostPendingListDto> {
    return this.requestScoped(request.profileId, 'pending.list', (scope) =>
      requestRemotePending(scope, request));
  }

  async respondPending(
    request: RemoteHostPendingResponseDto,
  ): Promise<RemoteHostPendingResponseResultDto> {
    return this.requestScoped(request.profileId, 'pending.respond', async (scope) => {
      const pendingValue = await scope.client.request('pending.list', {
        sessionId: request.sessionId,
      }, { deadlineMs: REMOTE_HOST_INTERACTIVE_DEADLINE_MS });
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

  async getRuntime(request: RemoteHostSessionTargetDto): Promise<RemoteHostRuntimeControlsDto> {
    return this.requestScoped(request.profileId, 'session.runtime.get', (scope) =>
      requestRemoteRuntime(scope, request));
  }

  async updateRuntime(
    request: RemoteHostRuntimeUpdateDto,
  ): Promise<RemoteHostRuntimeUpdateResultDto> {
    return this.requestScoped(request.profileId, 'session.runtime.update', async (scope) => {
      const value = await scope.client.request(
        'session.runtime.update',
        { sessionId: request.sessionId, patch: request.patch },
        {
          deadlineMs: REMOTE_HOST_INTERACTIVE_DEADLINE_MS,
          idempotencyKey: this.mutationId('runtime', request.profileId, request.intentId),
          expectedRevision: request.expectedRevision,
        },
      );
      return parseRemoteHostRuntimeUpdateResult(value);
    });
  }

  private snapshot(): RemoteHostSnapshotDto {
    return remoteHostSnapshot({
      registry: this.options.registry,
      revision: this.snapshotRevision,
      sourceMode: this.profiles.sourceMode,
      selectedRemoteProfileId: this.profiles.selectedRemoteProfileId,
    });
  }

  private beginScope(
    profileId: string,
    method: CoreMethod,
    additionalMethods: readonly CoreMethod[],
  ): RemoteHostScopedClient {
    this.assertActive();
    if (
      this.profiles.sourceMode !== 'remote' ||
      this.profiles.selectedRemoteProfileId !== profileId
    ) {
      throw new RemoteHostPublicError('stale_scope', '当前主机已切换，请重试。');
    }
    const state = this.options.registry.state(profileId);
    const client = this.options.registry.getClient(profileId);
    const canRequest = (
      ['connected', 'reconnecting'].includes(state.status) ||
      (client !== null && isRecoverableRelayWorkerOffline(state))
    );
    if (!canRequest || !client) {
      throw new RemoteHostPublicError('not_connected', '请先连接远程主机。');
    }
    for (const requiredMethod of [method, ...additionalMethods]) {
      const capability = CORE_METHOD_METADATA[requiredMethod].capability;
      if (!state.capabilities.includes(capability)) {
        throw new RemoteHostPublicError('capability_unavailable', '远程 Core 不支持此操作。');
      }
    }
    return this.scopes.capture(profileId, client);
  }

  private assertScope(scope: RemoteHostScopedClient): void {
    this.assertActive();
    if (
      !this.scopes.isCurrent(scope) ||
      this.profiles.sourceMode !== 'remote' ||
      this.profiles.selectedRemoteProfileId !== scope.profileId ||
      this.options.registry.getClient(scope.profileId) !== scope.client
    ) {
      throw new RemoteHostPublicError('stale_scope', '当前主机或连接已切换，请重试。');
    }
  }

  private async requestScoped<T>(
    profileId: string,
    method: CoreMethod,
    run: (scope: RemoteHostScopedClient) => Promise<T>,
    additionalMethods: readonly CoreMethod[] = [],
  ): Promise<T> {
    const scope = this.beginScope(profileId, method, additionalMethods);
    try {
      const result = await run(scope);
      this.assertScope(scope);
      return result;
    } catch (error) {
      this.assertScope(scope);
      throw error;
    }
  }

  private mutationId(scope: string, profileId: string, intentId: string): string {
    const { authoritativeCoreId, workerGeneration } = this.options.registry.state(profileId);
    return remoteHostMutationId(scope, profileId, authoritativeCoreId, workerGeneration, intentId);
  }

  private assertActive(): void {
    if (this.lifecycle !== 'active') {
      throw new RemoteHostPublicError('service_stopped', '远程主机服务已停止。');
    }
  }

  private changed(
    reason: 'data' | 'profiles' | 'selection' | 'state',
    profileId: string | null,
  ): void {
    this.snapshotRevision += 1;
    publishRemoteHostChanged({ revision: this.snapshotRevision, profileId, reason });
  }

  private mutate<T>(run: () => Promise<T> | T): Promise<T> {
    const result = this.mutationTail.then(run);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private mutateActive<T>(run: () => Promise<T> | T): Promise<T> {
    try {
      this.assertActive();
    } catch (error) {
      return Promise.reject(error);
    }
    return this.mutate(async () => {
      this.assertActive();
      const result = await run();
      this.assertActive();
      return result;
    });
  }
}
