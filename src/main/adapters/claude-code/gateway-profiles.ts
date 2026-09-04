import {
  claudeGatewaySettingsPathCore,
  listClaudeGatewayProfilesCore,
  resolveClaudeGatewayProfileCore,
  type ClaudeGatewayPaths,
} from './gateway-profiles-core';
import {
  defaultDesktopClaudeGatewayPaths,
  desktopClaudeGatewayProfileHost,
} from './gateway-profiles-host';

export {
  CLAUDE_GATEWAY_PROFILE_ID_PATTERN,
  type ClaudeGatewayPaths,
  type ResolvedClaudeGatewayProfile,
} from './gateway-profiles-core';

export function defaultClaudeGatewayPaths(): ClaudeGatewayPaths {
  return defaultDesktopClaudeGatewayPaths();
}

export function claudeGatewaySettingsPath(
  profileId: string,
  paths: ClaudeGatewayPaths = defaultClaudeGatewayPaths(),
): string {
  return claudeGatewaySettingsPathCore(
    profileId,
    paths,
    desktopClaudeGatewayProfileHost,
  );
}

export function listClaudeGatewayProfiles(
  paths: ClaudeGatewayPaths = defaultClaudeGatewayPaths(),
) {
  return listClaudeGatewayProfilesCore(paths, desktopClaudeGatewayProfileHost);
}

export function resolveClaudeGatewayProfile(
  gateway: string | null | undefined,
  paths: ClaudeGatewayPaths = defaultClaudeGatewayPaths(),
) {
  return resolveClaudeGatewayProfileCore(
    gateway,
    paths,
    desktopClaudeGatewayProfileHost,
  );
}
