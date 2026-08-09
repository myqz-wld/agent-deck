import type { CodexWorkspacePermissionBoundary } from '../sdk-bridge/thread-options-builder';
import type { JsonObject, JsonValue } from './protocol';

export const WORKSPACE_READ_ONLY_PROFILE = 'agent-deck-workspace-read-only';
export const WORKSPACE_READ_ONLY_NETWORK_PROFILE =
  'agent-deck-workspace-read-only-network';
export const WORKSPACE_WRITE_PROFILE = 'agent-deck-workspace-write';
export const WORKSPACE_WRITE_NETWORK_PROFILE = 'agent-deck-workspace-write-network';
export const WORKSPACE_FULL_WRITE_PROFILE = 'agent-deck-workspace-full-write';
export const WORKSPACE_FULL_WRITE_NETWORK_PROFILE =
  'agent-deck-workspace-full-write-network';

function workspaceFilesystem(
  boundary: CodexWorkspacePermissionBoundary,
  access: 'read-only' | 'selected-write' | 'workspace-write',
): JsonObject {
  const filesystem: JsonObject = {
    ':root': 'deny',
    ':minimal': 'read',
    // runtimeWorkspaceRoots is the selected session directory for headless threads.
    ':workspace_roots': { '.': access === 'read-only' ? 'read' : 'write' },
    [boundary.workspaceRoot]: access === 'workspace-write' ? 'write' : 'read',
  };
  for (const root of boundary.readOnlyRoots) filesystem[root] = 'read';
  for (const root of boundary.readWriteRoots) filesystem[root] = 'write';
  return filesystem;
}

function permissionProfile(
  boundary: CodexWorkspacePermissionBoundary,
  access: 'read-only' | 'selected-write' | 'workspace-write',
  networkEnabled: boolean,
): JsonObject {
  return {
    filesystem: workspaceFilesystem(boundary, access),
    network: {
      enabled: networkEnabled,
      ...(networkEnabled ? { domains: { '*': 'allow' } } : {}),
    },
  };
}

export function buildCodexWorkspacePermissionProfiles(
  boundary: CodexWorkspacePermissionBoundary,
): JsonObject {
  return {
    [WORKSPACE_READ_ONLY_PROFILE]: permissionProfile(boundary, 'read-only', false),
    [WORKSPACE_READ_ONLY_NETWORK_PROFILE]: permissionProfile(boundary, 'read-only', true),
    [WORKSPACE_WRITE_PROFILE]: permissionProfile(boundary, 'selected-write', false),
    [WORKSPACE_WRITE_NETWORK_PROFILE]: permissionProfile(boundary, 'selected-write', true),
    [WORKSPACE_FULL_WRITE_PROFILE]: permissionProfile(boundary, 'workspace-write', false),
    [WORKSPACE_FULL_WRITE_NETWORK_PROFILE]: permissionProfile(boundary, 'workspace-write', true),
  };
}

function tomlInlineValue(value: JsonValue | undefined): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlInlineValue).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)}=${tomlInlineValue(item)}`)
      .join(',')}}`;
  }
  throw new Error('Codex workspace permission config contains an unsupported TOML value');
}

/**
 * Codex 0.146 resolves a turn's named permission profile from process configuration rather than
 * retaining profile tables supplied only to thread/start. Install the fixed profiles before the
 * app-server subcommand; each thread and turn still selects exactly one profile by name.
 */
export function buildCodexWorkspaceAppServerArguments(
  boundary: CodexWorkspacePermissionBoundary,
  trustedMcpServers: JsonObject = {},
): string[] {
  return [
    '-c',
    `default_permissions=${JSON.stringify(WORKSPACE_READ_ONLY_PROFILE)}`,
    '-c',
    `permissions=${tomlInlineValue(buildCodexWorkspacePermissionProfiles(boundary))}`,
    '-c',
    `mcp_servers=${tomlInlineValue(trustedMcpServers)}`,
    '-c',
    'features.hooks=false',
    '-c',
    'features.plugins=false',
    'app-server',
    '--stdio',
  ];
}
