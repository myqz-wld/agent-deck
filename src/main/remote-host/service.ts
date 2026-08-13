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
  RemoteHostPendingIndexDto,
  RemoteHostPendingIndexRequestDto,
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
  RemoteHostSessionPresentationPageDto,
  RemoteHostSessionPresentationRequestDto,
  RemoteHostSessionTargetDto,
  RemoteHostSessionContextDto,
  RemoteHostSessionInputCapabilitiesDto,
  RemoteHostSessionMessagesDto,
  RemoteHostSessionMessagesRequestDto,
  RemoteHostSessionPermissionsDto,
  RemoteHostSessionPermissionsRequestDto,
  RemoteHostSessionOutgoingDto,
  RemoteHostSessionOutgoingRemoveDto,
  RemoteHostSessionOutgoingRemoveRequestDto,
  RemoteHostSessionOutgoingRequestDto,
  RemoteHostSnapshotDto,
  RemoteHostSourceMode,
  RemoteHostWorkspaceDirectoryListDto,
  RemoteHostWorkspaceDirectoryRequestDto,
} from '@shared/remote-host';
import type { RemoteHostConnectionSelections } from './connection-selections';
import type { RemoteHostCredentialMaterialStore } from './credential-material-store';
import { RemoteHostPublicError } from './errors';
import { publishRemoteHostChanged } from './event-bridge';
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
import { RemoteHostNodeConfigurationController } from './service-node-configuration';
import { RemoteHostNodeAssetController } from './service-node-assets';
import { RemoteHostSessionMutationController } from './service-session-mutations';
import { RemoteHostSessionHandOffController } from './service-session-handoff';
import { RemoteHostSessionStateController } from './service-session-state';
import { RemoteHostSessionPresentationController } from './service-session-presentation';
import { RemoteHostSessionMetadataController } from './service-session-metadata';
import {
  RemoteHostSessionHistoryMutationController,
  RemoteHostWorkspaceDirectoryMutationController,
} from './service-history-directory-mutations';
import { requestRemoteHistory } from './service-session-detail';
import { RemoteHostScopeEpochs } from './service-scope';
import { RemoteHostRequestAuthority } from './service-request-authority';
import { remoteHostResourcesForCoreEvent } from './resource-invalidation';
import type { RemoteHostDesktopBrokerPort } from './desktop-browser-broker';
import type { RemoteHostResourceKind } from '@shared/remote-host';
import log from '@main/utils/logger';

const logger = log.scope('remote-host-transport');

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
  readonly nodeConfiguration: RemoteHostNodeConfigurationController;
  readonly nodeAssets: RemoteHostNodeAssetController;
  readonly handoff: RemoteHostSessionHandOffController;
  readonly historyMutations: RemoteHostSessionHistoryMutationController;
  readonly workspaceDirectories: RemoteHostWorkspaceDirectoryMutationController;
  private readonly sessionState: RemoteHostSessionStateController;
  private readonly sessionPresentation: RemoteHostSessionPresentationController;
  private readonly sessionMetadata: RemoteHostSessionMetadataController;
  private readonly sessionMutations: RemoteHostSessionMutationController;
  private readonly profiles: RemoteHostProfileController;
  private readonly requestAuthority: RemoteHostRequestAuthority;
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
    this.requestAuthority = new RemoteHostRequestAuthority({
      registry: options.registry,
      scopes: this.scopes,
      active: () => this.lifecycle === 'active',
      source: () => ({
        mode: this.profiles.sourceMode,
        selectedProfileId: this.profiles.selectedRemoteProfileId,
      }),
    });
    const requestScoped = this.requestAuthority.request;
    const mutationId = this.requestAuthority.mutationId.bind(this.requestAuthority);
    this.detail = new RemoteHostDetailReader(requestScoped);
    this.issues = new RemoteHostIssueController(requestScoped, mutationId);
    this.planReviews = new RemoteHostPlanReviewController(
      requestScoped,
      (scope) => this.requestAuthority.assertScope(scope),
      mutationId,
    );
    this.teams = new RemoteHostTeamController(requestScoped, mutationId);
    this.usage = new RemoteHostUsageController(requestScoped);
    this.nodeConfiguration = new RemoteHostNodeConfigurationController(requestScoped, mutationId);
    this.nodeAssets = new RemoteHostNodeAssetController(requestScoped);
    this.sessionMutations = new RemoteHostSessionMutationController(requestScoped, mutationId);
    this.sessionState = new RemoteHostSessionStateController(
      requestScoped,
      (scope) => this.requestAuthority.assertScope(scope),
      mutationId,
    );
    this.sessionPresentation = new RemoteHostSessionPresentationController(requestScoped);
    this.sessionMetadata = new RemoteHostSessionMetadataController(requestScoped, mutationId);
    this.historyMutations = new RemoteHostSessionHistoryMutationController(requestScoped, mutationId);
    this.workspaceDirectories = new RemoteHostWorkspaceDirectoryMutationController(
      requestScoped,
      mutationId,
    );
    this.handoff = new RemoteHostSessionHandOffController(
      requestScoped,
      this.requestAuthority.requestTerminal,
      mutationId,
      (profileId, sessionId) => options.registry.updateNavigation(
        profileId,
        { selectedSessionId: sessionId },
      ),
    );
    options.registry.onState((state) => {
      this.desktopBroker.handleState(state);
      if (state.error) {
        logger.warn('Remote transport state changed with an internal reason', {
          profileId: state.profileId,
          status: state.status,
          code: state.error.code,
          reason: state.error.message,
          authoritativeCoreId: state.authoritativeCoreId,
          workerGeneration: state.workerGeneration,
        });
      }
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
      this.changed('data', event.profileId, remoteHostResourcesForCoreEvent(event.kind));
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
    return this.requestAuthority.request(request.profileId, 'session.console.list', (scope) =>
      requestRemoteSessions(scope, request));
  }

  async listSessionPresentations(
    request: RemoteHostSessionPresentationRequestDto,
  ): Promise<RemoteHostSessionPresentationPageDto> {
    return this.sessionPresentation.list(request);
  }

  async listPendingIndex(
    request: RemoteHostPendingIndexRequestDto,
  ): Promise<RemoteHostPendingIndexDto> {
    return this.sessionPresentation.pending(request);
  }

  async getSession(request: RemoteHostSessionTargetDto): Promise<RemoteHostSessionSummaryDto | null> {
    return this.requestAuthority.request(request.profileId, 'session.console.get', (scope) =>
      requestRemoteSession(scope, request));
  }

  async listProjects(request: RemoteHostPageRequestDto): Promise<RemoteHostProjectPageDto> {
    return this.requestAuthority.request(request.profileId, 'project.list', (scope) =>
      requestRemoteProjects(scope, request));
  }

  async getSessionCapabilities(
    request: RemoteHostSessionCapabilitiesRequestDto,
  ): Promise<RemoteHostSessionCapabilitiesDto> {
    return this.requestAuthority.request(request.profileId, 'session.console.capabilities', (scope) =>
      requestRemoteSessionCapabilities(scope, request));
  }

  async listWorkspaceDirectories(
    request: RemoteHostWorkspaceDirectoryRequestDto,
  ): Promise<RemoteHostWorkspaceDirectoryListDto> {
    return this.requestAuthority.request(request.profileId, 'workspace.directory.list', (scope) =>
      requestRemoteWorkspaceDirectories(scope, request));
  }

  async createSession(request: RemoteHostCreateSessionDto): Promise<{ sessionId: string; revision: number }> {
    return this.requestAuthority.request(
      request.profileId,
      'session.console.create',
      async (scope) => {
        const parsed = await requestRemoteSessionCreate(
          scope,
          request,
          this.requestAuthority.mutationId('create', request.profileId, request.intentId),
        );
        this.options.registry.updateNavigation(
          request.profileId,
          { selectedSessionId: parsed.sessionId },
        );
        return parsed;
      },
      [],
      request.expectedAuthority,
    );
  }

  async listHistory(request: RemoteHostHistoryRequestDto): Promise<RemoteHostHistoryPageDto> {
    return this.requestAuthority.request(request.profileId, 'session.history', (scope) =>
      requestRemoteHistory(scope, request));
  }

  async send(request: RemoteHostSendDto): Promise<RemoteHostSendResultDto> {
    return this.sessionMutations.send(request);
  }

  async interrupt(request: RemoteHostMutationTargetDto): Promise<RemoteHostAcceptedResultDto> {
    return this.sessionMutations.interrupt(request);
  }

  async steer(request: RemoteHostSendDto): Promise<RemoteHostAcceptedResultDto> {
    return this.sessionMutations.steer(request);
  }

  async getSessionContext(
    request: RemoteHostSessionTargetDto,
  ): Promise<RemoteHostSessionContextDto> {
    return this.sessionState.context(request);
  }

  async getSessionInputCapabilities(
    request: RemoteHostSessionTargetDto,
  ): Promise<RemoteHostSessionInputCapabilitiesDto> {
    return this.sessionState.inputCapabilities(request);
  }

  async getSessionPermissions(
    request: RemoteHostSessionPermissionsRequestDto,
  ): Promise<RemoteHostSessionPermissionsDto> {
    return this.sessionMetadata.permissions(request);
  }

  async listSessionMessages(
    request: RemoteHostSessionMessagesRequestDto,
  ): Promise<RemoteHostSessionMessagesDto> {
    return this.sessionMetadata.messages(request);
  }

  async listSessionOutgoing(
    request: RemoteHostSessionOutgoingRequestDto,
  ): Promise<RemoteHostSessionOutgoingDto> {
    return this.sessionMetadata.outgoing(request);
  }

  async removeSessionOutgoing(
    request: RemoteHostSessionOutgoingRemoveRequestDto,
  ): Promise<RemoteHostSessionOutgoingRemoveDto> {
    return this.sessionMetadata.removeOutgoing(request);
  }

  async listPending(request: RemoteHostSessionTargetDto): Promise<RemoteHostPendingListDto> {
    return this.sessionState.pending(request);
  }

  async respondPending(
    request: RemoteHostPendingResponseDto,
  ): Promise<RemoteHostPendingResponseResultDto> {
    return this.sessionState.respond(request);
  }

  async getRuntime(request: RemoteHostSessionTargetDto): Promise<RemoteHostRuntimeControlsDto> {
    return this.sessionMutations.runtime(request);
  }

  async updateRuntime(
    request: RemoteHostRuntimeUpdateDto,
  ): Promise<RemoteHostRuntimeUpdateResultDto> {
    return this.sessionMutations.updateRuntime(request);
  }

  private snapshot(): RemoteHostSnapshotDto {
    return remoteHostSnapshot({
      registry: this.options.registry,
      revision: this.snapshotRevision,
      sourceMode: this.profiles.sourceMode,
      selectedRemoteProfileId: this.profiles.selectedRemoteProfileId,
    });
  }

  private assertActive(): void {
    if (this.lifecycle !== 'active') {
      throw new RemoteHostPublicError('service_stopped', '远程主机服务已停止。');
    }
  }

  private changed(
    reason: 'data' | 'profiles' | 'selection' | 'state',
    profileId: string | null,
    resources: readonly RemoteHostResourceKind[] = [],
  ): void {
    this.snapshotRevision += 1;
    publishRemoteHostChanged({
      revision: this.snapshotRevision,
      profileId,
      reason,
      resources: [...resources],
    });
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
