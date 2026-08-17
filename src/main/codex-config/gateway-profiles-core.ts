import type { CodexConfigObject } from './agent-deck-mcp-injector';

export const CODEX_GATEWAY_PROFILE_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface CodexGatewayPaths {
  gatewaysDir: string;
}

export interface CodexGatewayProfileHost {
  joinPath(directory: string, name: string): string;
  isFile(path: string): boolean;
  pathExists(path: string): boolean;
  readText(path: string): string;
}

export interface ResolvedCodexGatewayProfile {
  id: string;
  profilePath: string;
  configOverrides: CodexConfigObject;
}

export function codexGatewayProfilePathCore(
  profileId: string,
  paths: CodexGatewayPaths,
  host: CodexGatewayProfileHost,
): string {
  assertCodexGatewayProfileIdCore(profileId);
  return host.joinPath(paths.gatewaysDir, `${profileId}.json`);
}

export function assertCodexGatewayProfileIdCore(profileId: string): void {
  if (!CODEX_GATEWAY_PROFILE_ID_PATTERN.test(profileId)) {
    throw new Error(
      `Codex Gateway profile id "${profileId}" 无效；请使用 1-128 个字母、数字、点、下划线或连字符，且首字符必须是字母或数字。`,
    );
  }
}

/**
 * Resolve the optional config layer paired with one native Codex model_provider.
 *
 * Native provider ids can be broader than safe filenames. Those providers remain usable and
 * simply do not participate in file-backed profiles. A safe provider with no matching file also
 * keeps Codex's normal defaults. Once a matching file exists, malformed supported values fail
 * closed so a session cannot silently run with the wrong context capacity.
 */
export function resolveCodexGatewayProfileCore(
  provider: string | null | undefined,
  paths: CodexGatewayPaths,
  host: CodexGatewayProfileHost,
): ResolvedCodexGatewayProfile | null {
  const id = provider?.trim();
  if (!id || !CODEX_GATEWAY_PROFILE_ID_PATTERN.test(id)) return null;
  const profilePath = codexGatewayProfilePathCore(id, paths, host);
  if (!host.pathExists(profilePath)) return null;
  if (!host.isFile(profilePath)) {
    throw new Error(`Codex Gateway profile 不是常规文件：${profilePath}`);
  }
  return parseCodexGatewayProfileTextCore(id, profilePath, host.readText(profilePath));
}

/** Parse and project only the two provider-capacity keys Agent Deck owns in this profile. */
export function parseCodexGatewayProfileTextCore(
  id: string,
  profilePath: string,
  text: string,
): ResolvedCodexGatewayProfile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw profileReadError(profilePath, error);
  }
  if (!isRecord(parsed)) {
    throw profileReadError(profilePath, new Error('JSON 根节点必须是 object'));
  }

  const modelContextWindow = positiveSafeInteger(
    parsed.model_context_window,
    'model_context_window',
    profilePath,
  );
  const autoCompactTokenLimit = positiveSafeInteger(
    parsed.model_auto_compact_token_limit,
    'model_auto_compact_token_limit',
    profilePath,
  );
  if (
    modelContextWindow !== undefined &&
    autoCompactTokenLimit !== undefined &&
    autoCompactTokenLimit > modelContextWindow
  ) {
    throw profileReadError(
      profilePath,
      new Error('model_auto_compact_token_limit 不能大于 model_context_window'),
    );
  }

  return {
    id,
    profilePath,
    configOverrides: {
      ...(modelContextWindow !== undefined
        ? { model_context_window: modelContextWindow }
        : {}),
      ...(autoCompactTokenLimit !== undefined
        ? { model_auto_compact_token_limit: autoCompactTokenLimit }
        : {}),
    },
  };
}

function positiveSafeInteger(
  value: unknown,
  key: string,
  profilePath: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw profileReadError(profilePath, new Error(`${key} 必须是正安全整数`));
  }
  return value as number;
}

function profileReadError(profilePath: string, error: unknown): Error {
  return new Error(
    `读取 Codex Gateway profile 失败（${profilePath}）：${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
