import {
  parseProjectListResult,
  parseSessionConsoleCreateResult,
  parseSessionConsoleCapabilitiesResult,
  parseSessionConsoleGetResult,
  parseWorkspaceDirectoryListResult,
} from '@contracts/index';
import type {
  RemoteHostPageRequestDto,
  RemoteHostCreateSessionDto,
  RemoteHostProjectPageDto,
  RemoteHostSessionCapabilitiesDto,
  RemoteHostSessionCapabilitiesRequestDto,
  RemoteHostSessionSummaryDto,
  RemoteHostSessionTargetDto,
  RemoteHostWorkspaceDirectoryListDto,
  RemoteHostWorkspaceDirectoryRequestDto,
} from '@shared/remote-host';
import {
  REMOTE_HOST_INTERACTIVE_DEADLINE_MS,
  type RemoteHostScopedClient,
} from './service-scope';

export async function requestRemoteSession(
  scope: RemoteHostScopedClient,
  request: RemoteHostSessionTargetDto,
): Promise<RemoteHostSessionSummaryDto | null> {
  const result = await scope.client.request(
    'session.console.get',
    { sessionId: request.sessionId },
    { deadlineMs: REMOTE_HOST_INTERACTIVE_DEADLINE_MS },
  );
  return parseSessionConsoleGetResult(result, request.sessionId).session;
}

export async function requestRemoteProjects(
  scope: RemoteHostScopedClient,
  request: RemoteHostPageRequestDto,
): Promise<RemoteHostProjectPageDto> {
  const result = await scope.client.request('project.list', {
    ...(request.cursor ? { cursor: request.cursor } : {}),
    limit: request.limit,
  }, { deadlineMs: REMOTE_HOST_INTERACTIVE_DEADLINE_MS });
  return parseProjectListResult(result, request.limit);
}

export async function requestRemoteSessionCapabilities(
  scope: RemoteHostScopedClient,
  request: RemoteHostSessionCapabilitiesRequestDto,
): Promise<RemoteHostSessionCapabilitiesDto> {
  const result = await scope.client.request('session.console.capabilities', {
    adapterId: request.adapterId,
    provider: request.provider,
    workingDirectory: request.workingDirectory,
  }, { deadlineMs: REMOTE_HOST_INTERACTIVE_DEADLINE_MS });
  return parseSessionConsoleCapabilitiesResult(result, request);
}

export async function requestRemoteWorkspaceDirectories(
  scope: RemoteHostScopedClient,
  request: RemoteHostWorkspaceDirectoryRequestDto,
): Promise<RemoteHostWorkspaceDirectoryListDto> {
  const result = await scope.client.request(
    'workspace.directory.list',
    { directory: request.directory },
    { deadlineMs: REMOTE_HOST_INTERACTIVE_DEADLINE_MS },
  );
  return parseWorkspaceDirectoryListResult(result, request.directory);
}

export async function requestRemoteSessionCreate(
  scope: RemoteHostScopedClient,
  request: RemoteHostCreateSessionDto,
  idempotencyKey: string,
): Promise<{ sessionId: string; revision: number }> {
  const result = await scope.client.request('session.console.create', {
    adapterId: request.adapterId,
    attachments: request.attachments,
    capabilityRevision: request.capabilityRevision,
    initialMessage: request.initialMessage,
    projectTrust: request.projectTrust,
    workingDirectory: request.workingDirectory,
    options: request.options,
  }, { deadlineMs: REMOTE_HOST_INTERACTIVE_DEADLINE_MS, idempotencyKey });
  return parseSessionConsoleCreateResult(result);
}
