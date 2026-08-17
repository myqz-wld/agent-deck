import {
  assertCodexGatewayProfileIdCore,
  codexGatewayProfilePathCore,
  listCodexGatewayProfilesCore,
  resolveCodexGatewayProfileCore,
  type CodexGatewayPaths,
} from './gateway-profiles-core';
import {
  defaultDesktopCodexGatewayPaths,
  desktopCodexGatewayProfileHost,
} from './gateway-profiles-host';

export {
  CODEX_GATEWAY_PROFILE_ID_PATTERN,
  parseCodexGatewayProfileTextCore,
  type CodexGatewayPaths,
  type ResolvedCodexGatewayProfile,
} from './gateway-profiles-core';

export function defaultCodexGatewayPaths(): CodexGatewayPaths {
  return defaultDesktopCodexGatewayPaths();
}

export function codexGatewayProfilePath(
  profileId: string,
  paths: CodexGatewayPaths = defaultCodexGatewayPaths(),
): string {
  return codexGatewayProfilePathCore(
    profileId,
    paths,
    desktopCodexGatewayProfileHost,
  );
}

export function assertCodexGatewayProfileId(profileId: string): void {
  assertCodexGatewayProfileIdCore(profileId);
}

export function listCodexGatewayProfiles(
  paths: CodexGatewayPaths = defaultCodexGatewayPaths(),
) {
  return listCodexGatewayProfilesCore(paths, desktopCodexGatewayProfileHost);
}

export function resolveCodexGatewayProfile(
  provider: string | null | undefined,
  paths: CodexGatewayPaths = defaultCodexGatewayPaths(),
) {
  return resolveCodexGatewayProfileCore(
    provider,
    paths,
    desktopCodexGatewayProfileHost,
  );
}
