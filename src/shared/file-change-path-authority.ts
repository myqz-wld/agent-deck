const AUTHORITY_KEY = '__agentDeckCanonicalPathAuthorityV1';
const CANONICAL_PREFIX = 'canonical:';
const UNAVAILABLE = 'unavailable';
const MAX_AUTHORITY_BYTES = 4_096;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const encoder = new TextEncoder();

export const FILE_CHANGE_PATH_AUTHORITY_KEY = AUTHORITY_KEY;

export type FileChangePathAuthority = string | null;

export function storedFileChangePathAuthority(
  value: unknown,
): FileChangePathAuthority {
  if (value === UNAVAILABLE) return null;
  if (
    typeof value !== 'string' ||
    !value.startsWith(CANONICAL_PREFIX)
  ) return null;
  const path = value.slice(CANONICAL_PREFIX.length);
  return path.startsWith('/') && encoder.encode(path).byteLength <= MAX_AUTHORITY_BYTES &&
    !CONTROL.test(path)
    ? path
    : null;
}

export function fileChangePathAuthorityFromMetadata(
  metadata: Record<string, unknown>,
): FileChangePathAuthority {
  return Object.prototype.hasOwnProperty.call(metadata, AUTHORITY_KEY)
    ? storedFileChangePathAuthority(metadata[AUTHORITY_KEY])
    : null;
}

export function withStoredFileChangePathAuthority(
  metadata: Record<string, unknown>,
  canonicalPath: string | null,
): Record<string, unknown> {
  return {
    ...metadata,
    [AUTHORITY_KEY]: canonicalPath === null ? UNAVAILABLE : `${CANONICAL_PREFIX}${canonicalPath}`,
  };
}

export function withoutStoredFileChangePathAuthority(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const { [AUTHORITY_KEY]: _authority, ...publicMetadata } = metadata;
  return publicMetadata;
}
