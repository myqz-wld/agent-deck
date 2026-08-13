import { AgentDeckCapability, type AgentDeckCapability as Capability } from './capabilities';
import type { JsonObject, JsonValue } from './json';
import type {
  SessionConsoleCapabilitiesParams,
  SessionConsoleCapabilitiesResult,
} from './session-console-capabilities';
import type {
  SessionFileChangeGetParams,
  SessionFileChangeGetResult,
  SessionFileChangeListParams,
  SessionFileChangeListResult,
  SessionFileFinalDiffParams,
  SessionFileFinalDiffResult,
  SessionSummaryListParams,
  SessionSummaryListResult,
} from './session-detail';
import type { SessionTaskListParams, SessionTaskListResult } from './session-tasks';
import type {
  SessionImageAssetReadParams,
  SessionImageAssetReadResult,
} from './session-image-assets';
import type { SessionEventListParams, SessionEventListResult } from './session-events';
import type {
  IssueGetParams,
  IssueGetResult,
  IssueListParams,
  IssueListResult,
  IssueMutationResult,
  IssueResolveInNewSessionParams,
  IssueResolveInNewSessionResult,
  IssueUpdateParams,
} from './issues';
import type {
  WorkspaceDirectoryCreateParams,
  WorkspaceDirectoryCreateResult,
  WorkspaceDirectoryListParams,
  WorkspaceDirectoryListResult,
} from './session-console-directories';
import type {
  SessionHistoryMutationParams,
  SessionHistoryMutationResult,
} from './session-history-mutations';
import type {
  ProjectListParams,
  ProjectListResult,
  ProjectResolveResult,
  SessionConsoleCreateParams,
  SessionConsoleCreateResult,
  SessionConsoleGetResult,
  SessionConsoleListParams,
  SessionConsoleListResult,
} from './session-console';
import type { SessionConsoleAttachmentInput } from './session-console-attachments';
import type {
  DesktopBrokerNextParams,
  DesktopBrokerNextResult,
  DesktopBrokerRespondParams,
  DesktopBrokerRespondResult,
} from './desktop-broker';
import type {
  TeamAddMemberParams,
  TeamAddMemberResult,
  TeamArchiveParams,
  TeamGetParams,
  TeamGetResult,
  TeamListParams,
  TeamListResult,
  TeamMutationResult,
  TeamShutdownParams,
  TeamShutdownResult,
} from './teams';
import type {
  UsageProviderParams,
  UsageProviderResult,
  UsageTokenParams,
  UsageTokenResult,
} from './usage';
import type {
  NodeConfigurationGetResult,
  NodeHookParams,
  NodeHookProjectionResult,
} from './node-configuration';
import type {
  NodeAssetContentParams,
  NodeAssetContentResult,
  NodeAssetConventionParams,
  NodeAssetConventionResult,
  NodeAssetListResult,
} from './node-assets';
import type { SessionContextGetParams, SessionContextGetResult } from './session-context';
import type {
  SessionInputCapabilitiesParams,
  SessionInputCapabilitiesResult,
} from './session-input';
import type {
  SessionHandOffCommitParams,
  SessionHandOffCommitResult,
  SessionHandOffPreviewParams,
  SessionHandOffPreviewResult,
} from './session-handoff';
import type {
  SessionPresentationListParams,
  SessionPresentationListResult,
} from './session-presentation';
import type { PendingIndexListParams, PendingIndexListResult } from './pending-index';
import type { SessionMessagesListParams, SessionMessagesListResult } from './session-messages';
import type { SessionPermissionsGetParams, SessionPermissionsGetResult } from './session-permissions';
import type {
  SessionOutgoingListParams,
  SessionOutgoingListResult,
  SessionOutgoingRemoveParams,
  SessionOutgoingRemoveResult,
} from './session-outgoing';
import type {
  PendingRequestDto,
  SessionHistoryEntryDto,
  SessionListItemDto,
  SessionRuntimeControlsDto,
} from './runtime-dtos';

export * from './runtime-dtos';

export type CoreMethodMap = {
  'desktop.broker.next': {
    params: DesktopBrokerNextParams;
    result: DesktopBrokerNextResult;
  };
  'desktop.broker.respond': {
    params: DesktopBrokerRespondParams;
    result: DesktopBrokerRespondResult;
  };
  'system.health': {
    params: Record<string, never>;
    result: { ok: true; revision: number };
  };
  'session.list': {
    params: { includeArchived?: boolean };
    result: { sessions: SessionListItemDto[]; revision: number };
  };
  'session.get': {
    params: { sessionId: string };
    result: { session: SessionListItemDto | null; revision: number };
  };
  'session.create': {
    params: { adapterId: string; cwd: string; options: JsonObject };
    result: { sessionId: string; revision: number };
  };
  'session.console.list': {
    params: SessionConsoleListParams;
    result: SessionConsoleListResult;
  };
  'session.console.get': {
    params: { sessionId: string };
    result: SessionConsoleGetResult;
  };
  'project.list': {
    params: ProjectListParams;
    result: ProjectListResult;
  };
  'project.resolve': {
    params: { alias: string };
    result: ProjectResolveResult;
  };
  'session.console.create': {
    params: SessionConsoleCreateParams;
    result: SessionConsoleCreateResult;
  };
  'session.presentation.list': {
    params: SessionPresentationListParams;
    result: SessionPresentationListResult;
  };
  'session.messages.list': {
    params: SessionMessagesListParams;
    result: SessionMessagesListResult;
  };
  'session.permissions.get': {
    params: SessionPermissionsGetParams;
    result: SessionPermissionsGetResult;
  };
  'session.outgoing.list': {
    params: SessionOutgoingListParams;
    result: SessionOutgoingListResult;
  };
  'session.outgoing.remove': {
    params: SessionOutgoingRemoveParams;
    result: SessionOutgoingRemoveResult;
  };
  'session.console.capabilities': {
    params: SessionConsoleCapabilitiesParams;
    result: SessionConsoleCapabilitiesResult;
  };
  'workspace.directory.list': {
    params: WorkspaceDirectoryListParams;
    result: WorkspaceDirectoryListResult;
  };
  'workspace.directory.create': {
    params: WorkspaceDirectoryCreateParams;
    result: WorkspaceDirectoryCreateResult;
  };
  'session.archive': {
    params: SessionHistoryMutationParams;
    result: SessionHistoryMutationResult;
  };
  'session.unarchive': {
    params: SessionHistoryMutationParams;
    result: SessionHistoryMutationResult;
  };
  'session.delete': {
    params: SessionHistoryMutationParams;
    result: SessionHistoryMutationResult;
  };
  'session.history': {
    params: { sessionId: string; cursor?: string; limit?: number };
    result: { entries: SessionHistoryEntryDto[]; nextCursor: string | null; revision: number };
  };
  'session.events.list': {
    params: SessionEventListParams;
    result: SessionEventListResult;
  };
  'session.summaries.list': {
    params: SessionSummaryListParams;
    result: SessionSummaryListResult;
  };
  'session.file-changes.list': {
    params: SessionFileChangeListParams;
    result: SessionFileChangeListResult;
  };
  'session.file-changes.get': {
    params: SessionFileChangeGetParams;
    result: SessionFileChangeGetResult;
  };
  'session.file-changes.final-diff': {
    params: SessionFileFinalDiffParams;
    result: SessionFileFinalDiffResult;
  };
  'session.assets.image-chunk.read': {
    params: SessionImageAssetReadParams;
    result: SessionImageAssetReadResult;
  };
  'session.tasks.list': {
    params: SessionTaskListParams;
    result: SessionTaskListResult;
  };
  'teams.list': { params: TeamListParams; result: TeamListResult };
  'teams.get': { params: TeamGetParams; result: TeamGetResult };
  'teams.archive': { params: TeamArchiveParams; result: TeamMutationResult };
  'teams.add-member': { params: TeamAddMemberParams; result: TeamAddMemberResult };
  'teams.shutdown-teammates': { params: TeamShutdownParams; result: TeamShutdownResult };
  'usage.tokens.get': { params: UsageTokenParams; result: UsageTokenResult };
  'usage.providers.get': { params: UsageProviderParams; result: UsageProviderResult };
  'node.configuration.get': {
    params: Record<string, never>;
    result: NodeConfigurationGetResult;
  };
  'node.hook.projection.get': { params: NodeHookParams; result: NodeHookProjectionResult };
  'node.hook.projection.install': { params: NodeHookParams; result: NodeHookProjectionResult };
  'node.hook.projection.uninstall': { params: NodeHookParams; result: NodeHookProjectionResult };
  'node.assets.list': { params: Record<string, never>; result: NodeAssetListResult };
  'node.assets.catalog.list': { params: Record<string, never>; result: NodeAssetListResult };
  'node.assets.content': { params: NodeAssetContentParams; result: NodeAssetContentResult };
  'node.assets.convention': {
    params: NodeAssetConventionParams;
    result: NodeAssetConventionResult;
  };
  'issues.list': {
    params: IssueListParams;
    result: IssueListResult;
  };
  'issues.get': {
    params: IssueGetParams;
    result: IssueGetResult;
  };
  'issues.update': {
    params: IssueUpdateParams;
    result: IssueMutationResult;
  };
  'issues.soft-delete': {
    params: IssueGetParams;
    result: IssueMutationResult;
  };
  'issues.undelete': {
    params: IssueGetParams;
    result: IssueMutationResult;
  };
  'issues.resolve-in-new-session': {
    params: IssueResolveInNewSessionParams;
    result: IssueResolveInNewSessionResult;
  };
  'session.send': {
    params: { sessionId: string; text: string; attachments?: SessionConsoleAttachmentInput[] };
    result: { messageId: string; sequence: number; revision: number };
  };
  'session.interrupt': {
    params: { sessionId: string };
    result: { accepted: boolean; revision: number };
  };
  'session.steer': {
    params: { sessionId: string; text: string; attachments?: SessionConsoleAttachmentInput[] };
    result: { accepted: boolean; revision: number };
  };
  'pending.list': {
    params: { sessionId: string };
    result: { requests: PendingRequestDto[]; revision: number };
  };
  'pending.index.list': {
    params: PendingIndexListParams;
    result: PendingIndexListResult;
  };
  'pending.respond': {
    params: { sessionId: string; requestId: string; action: string; value?: JsonValue };
    result: { status: Exclude<PendingRequestDto['status'], 'pending'>; revision: number };
  };
  'plan.review.start': {
    params: { sessionId: string; requestId: string };
    result: { sessionId: string; agentId: string; revision: number };
  };
  'plan.review.ask': {
    params: { sessionId: string; requestId: string; question: string };
    result: { accepted: true; revision: number };
  };
  'plan.review.feedback': {
    params: { sessionId: string; requestId: string };
    result: { feedback: string; revision: number };
  };
  'session.runtime.get': {
    params: { sessionId: string };
    result: SessionRuntimeControlsDto;
  };
  'session.runtime.update': {
    params: { sessionId: string; patch: JsonObject };
    result: {
      controls: SessionRuntimeControlsDto;
      effect: 'hot-applied' | 'handoff-required' | 'restart-required';
      replacementSessionId: string | null;
    };
  };
  'session.context.get': {
    params: SessionContextGetParams;
    result: SessionContextGetResult;
  };
  'session.input.capabilities': {
    params: SessionInputCapabilitiesParams;
    result: SessionInputCapabilitiesResult;
  };
  'session.handoff.preview': {
    params: SessionHandOffPreviewParams;
    result: SessionHandOffPreviewResult;
  };
  'session.handoff.commit': {
    params: SessionHandOffCommitParams;
    result: SessionHandOffCommitResult;
  };
  'subscription.set': {
    params: { sessionId: string; subscribed: boolean };
    result: { subscribed: boolean; revision: number };
  };
};

export interface CoreMethodMetadata {
  capability: Capability;
  mutation: boolean;
  idempotency: 'forbidden' | 'required';
  expectedRevision: 'none' | 'optional' | 'required';
  feishu: 'none' | 'session-console';
}

const readMethod = (
  capability: Capability,
  feishu: CoreMethodMetadata['feishu'] = 'session-console',
): CoreMethodMetadata => ({
  capability,
  mutation: false,
  idempotency: 'forbidden',
  expectedRevision: 'none',
  feishu,
});

const mutationMethod = (
  capability: Capability,
  expectedRevision: CoreMethodMetadata['expectedRevision'] = 'optional',
  feishu: CoreMethodMetadata['feishu'] = 'session-console',
): CoreMethodMetadata => ({
  capability,
  mutation: true,
  idempotency: 'required',
  expectedRevision,
  feishu,
});

export const CORE_METHOD_METADATA = {
  'desktop.broker.next': readMethod(AgentDeckCapability.Browser, 'none'),
  'desktop.broker.respond': {
    capability: AgentDeckCapability.Browser,
    mutation: true,
    idempotency: 'forbidden',
    expectedRevision: 'none',
    feishu: 'none',
  },
  'system.health': readMethod(AgentDeckCapability.SessionsRead, 'none'),
  'session.list': readMethod(AgentDeckCapability.SessionsRead, 'none'),
  'session.get': readMethod(AgentDeckCapability.SessionsRead, 'none'),
  'session.create': mutationMethod(AgentDeckCapability.SessionsWrite, 'optional', 'none'),
  'session.console.list': readMethod(AgentDeckCapability.SessionConsoleRead),
  'session.console.get': readMethod(AgentDeckCapability.SessionConsoleRead),
  'session.console.capabilities': readMethod(AgentDeckCapability.SessionConsoleRead),
  'workspace.directory.list': readMethod(AgentDeckCapability.SessionConsoleRead, 'none'),
  'workspace.directory.create': mutationMethod(
    AgentDeckCapability.WorkspaceDirectoryWrite,
    'none',
    'none',
  ),
  'session.archive': mutationMethod(AgentDeckCapability.SessionHistoryWrite, 'none', 'none'),
  'session.unarchive': mutationMethod(AgentDeckCapability.SessionHistoryWrite, 'none', 'none'),
  'session.delete': mutationMethod(AgentDeckCapability.SessionHistoryWrite, 'none', 'none'),
  'project.list': readMethod(AgentDeckCapability.ProjectsRead),
  'project.resolve': readMethod(AgentDeckCapability.ProjectsRead),
  'session.console.create': mutationMethod(AgentDeckCapability.SessionConsoleCreate),
  'session.presentation.list': readMethod(
    AgentDeckCapability.SessionPresentationRead,
    'none',
  ),
  'session.messages.list': readMethod(AgentDeckCapability.SessionMessagesRead, 'none'),
  'session.permissions.get': readMethod(AgentDeckCapability.SessionPermissionsRead, 'none'),
  'session.outgoing.list': readMethod(AgentDeckCapability.SessionOutgoingRead, 'none'),
  'session.outgoing.remove': mutationMethod(
    AgentDeckCapability.SessionOutgoingWrite,
    'none',
    'none',
  ),
  'session.history': readMethod(AgentDeckCapability.SessionHistory),
  'session.events.list': readMethod(AgentDeckCapability.Replay, 'none'),
  'session.summaries.list': readMethod(AgentDeckCapability.SessionSummariesRead, 'none'),
  'session.file-changes.list': readMethod(AgentDeckCapability.SessionFileChangesRead, 'none'),
  'session.file-changes.get': readMethod(AgentDeckCapability.SessionFileChangesRead, 'none'),
  'session.file-changes.final-diff': readMethod(
    AgentDeckCapability.SessionFileChangesRead,
    'none',
  ),
  'session.assets.image-chunk.read': readMethod(AgentDeckCapability.Assets, 'none'),
  'session.tasks.list': readMethod(AgentDeckCapability.Tasks, 'none'),
  'teams.list': readMethod(AgentDeckCapability.Teams, 'none'),
  'teams.get': readMethod(AgentDeckCapability.Teams, 'none'),
  'teams.archive': mutationMethod(AgentDeckCapability.Teams, 'required', 'none'),
  'teams.add-member': mutationMethod(AgentDeckCapability.Teams, 'required', 'none'),
  'teams.shutdown-teammates': mutationMethod(AgentDeckCapability.Teams, 'required', 'none'),
  'usage.tokens.get': readMethod(AgentDeckCapability.Usage, 'none'),
  'usage.providers.get': readMethod(AgentDeckCapability.Usage, 'none'),
  'node.configuration.get': readMethod(AgentDeckCapability.NodeConfiguration, 'none'),
  'node.hook.projection.get': readMethod(AgentDeckCapability.NodeHooksRead, 'none'),
  'node.hook.projection.install': mutationMethod(
    AgentDeckCapability.NodeHooksWrite,
    'none',
    'none',
  ),
  'node.hook.projection.uninstall': mutationMethod(
    AgentDeckCapability.NodeHooksWrite,
    'none',
    'none',
  ),
  'node.assets.list': readMethod(AgentDeckCapability.NodeAssets, 'none'),
  'node.assets.catalog.list': readMethod(AgentDeckCapability.NodeAssetsBound, 'none'),
  'node.assets.content': readMethod(AgentDeckCapability.NodeAssets, 'none'),
  'node.assets.convention': readMethod(AgentDeckCapability.NodeAssets, 'none'),
  'issues.list': readMethod(AgentDeckCapability.Issues, 'none'),
  'issues.get': readMethod(AgentDeckCapability.Issues, 'none'),
  'issues.update': mutationMethod(AgentDeckCapability.Issues, 'required', 'none'),
  'issues.soft-delete': mutationMethod(AgentDeckCapability.Issues, 'required', 'none'),
  'issues.undelete': mutationMethod(AgentDeckCapability.Issues, 'required', 'none'),
  'issues.resolve-in-new-session': mutationMethod(
    AgentDeckCapability.Issues,
    'required',
    'none',
  ),
  'session.send': mutationMethod(AgentDeckCapability.SessionsWrite),
  'session.interrupt': mutationMethod(AgentDeckCapability.SessionsWrite),
  'session.steer': mutationMethod(AgentDeckCapability.SessionsWrite),
  'pending.list': readMethod(AgentDeckCapability.PendingRead),
  'pending.index.list': readMethod(AgentDeckCapability.PendingIndexRead, 'none'),
  'pending.respond': mutationMethod(AgentDeckCapability.PendingRespond, 'required'),
  'plan.review.start': mutationMethod(AgentDeckCapability.PlanReview, 'required', 'none'),
  'plan.review.ask': mutationMethod(AgentDeckCapability.PlanReview, 'required', 'none'),
  'plan.review.feedback': mutationMethod(AgentDeckCapability.PlanReview, 'required', 'none'),
  'session.runtime.get': readMethod(AgentDeckCapability.SessionRuntimeRead),
  'session.runtime.update': mutationMethod(
    AgentDeckCapability.SessionRuntimeWrite,
    'required',
  ),
  'session.context.get': readMethod(AgentDeckCapability.SessionContextRead, 'none'),
  'session.input.capabilities': readMethod(AgentDeckCapability.SessionInputRead, 'none'),
  'session.handoff.preview': readMethod(AgentDeckCapability.SessionHandOff, 'none'),
  'session.handoff.commit': mutationMethod(AgentDeckCapability.SessionHandOff, 'none', 'none'),
  'subscription.set': mutationMethod(AgentDeckCapability.SubscriptionsWrite),
} as const satisfies Record<keyof CoreMethodMap, CoreMethodMetadata>;

export type CoreMethod = keyof CoreMethodMap;
