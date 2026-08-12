import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { AtomicPrivateStateFile } from '@hosts/linux-runtime/atomic-state-file';
import { readPrivateJsonFile } from '@hosts/linux-runtime/config-file';
import {
  isValidServerCoreGrokCredentialDocument,
} from '@hosts/server-core/provider-inference-credential';

const GROK_CREDENTIAL_FILE = 'grok-auth.json';
const MAX_GROK_CREDENTIAL_BYTES = 1024 * 1024;
const MAX_GROK_TOKEN_BYTES = 16 * 1024;
const GROK_NATIVE_AUTH_PREFIX = 'https://auth.x.ai::';
const PRINTABLE_TOKEN = /^[\x21-\x7e]+$/;

type ProjectedGrokCredential = {
  'xai::cached': {
    auth_mode: 'oauth';
    key: string;
    expires_at?: string;
  };
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function projectedCredential(key: string, expiresAt: string | undefined): ProjectedGrokCredential {
  return {
    'xai::cached': {
      auth_mode: 'oauth',
      key,
      ...(expiresAt ? { expires_at: expiresAt } : {}),
    },
  };
}

/**
 * Converts either the exact deployment credential or Grok CLI's current OIDC login document into
 * the minimal Worker-only schema. Refresh tokens and account/profile metadata are never projected.
 */
export function projectLocalWorkerGrokCredential(
  document: unknown,
  nowMs = Date.now(),
): ProjectedGrokCredential | null {
  if (isValidServerCoreGrokCredentialDocument(document, nowMs)) {
    const entry = object(object(document)?.['xai::cached']);
    if (!entry || typeof entry.key !== 'string') return null;
    return projectedCredential(
      entry.key,
      typeof entry.expires_at === 'string' ? entry.expires_at : undefined,
    );
  }

  const root = object(document);
  if (!root) return null;
  const nativeEntries = Object.entries(root).filter(([namespace]) =>
    namespace.startsWith(GROK_NATIVE_AUTH_PREFIX));
  if (nativeEntries.length !== 1) return null;
  const [namespace, rawEntry] = nativeEntries[0]!;
  const accountId = namespace.slice(GROK_NATIVE_AUTH_PREFIX.length);
  const entry = object(rawEntry);
  if (
    accountId.length === 0 || accountId.length > 512 || /[\x00-\x20\x7f]/u.test(accountId) ||
    !entry || entry.auth_mode !== 'oidc' || typeof entry.key !== 'string' ||
    entry.key.trim() !== entry.key || entry.key.length === 0 ||
    Buffer.byteLength(entry.key) > MAX_GROK_TOKEN_BYTES || !PRINTABLE_TOKEN.test(entry.key) ||
    typeof entry.expires_at !== 'string'
  ) return null;
  const expiresAt = new Date(entry.expires_at).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) return null;
  return projectedCredential(entry.key, entry.expires_at);
}

function assertPrivateDirectory(path: string): void {
  const stat = lstatSync(path);
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (
    resolve(path) !== path || realpathSync(path) !== path ||
    !stat.isDirectory() || stat.isSymbolicLink() ||
    (stat.mode & 0o777) !== 0o700 || (uid !== null && stat.uid !== uid)
  ) {
    throw new Error('Worker Provider credential directory is invalid');
  }
}

export async function readLocalWorkerGrokCredential(
  credentialFile: string,
): Promise<unknown> {
  const stat = lstatSync(credentialFile);
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (
    resolve(credentialFile) !== credentialFile || realpathSync(credentialFile) !== credentialFile ||
    !stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 ||
    (uid !== null && stat.uid !== uid && stat.uid !== 0)
  ) {
    throw new Error('Grok Provider credential file must be canonical private mode 0600');
  }
  const document = await readPrivateJsonFile(credentialFile, {
    maxBytes: MAX_GROK_CREDENTIAL_BYTES,
  });
  const projected = projectLocalWorkerGrokCredential(document);
  if (!projected) {
    throw new Error('Grok Provider credential document is invalid or expired');
  }
  return projected;
}

/** Projects the exact Grok credential into one Worker's model-invisible private root. */
export async function installLocalWorkerGrokCredential(
  privateRoot: string,
  credentialFile: string,
): Promise<string> {
  assertPrivateDirectory(privateRoot);
  const document = await readLocalWorkerGrokCredential(credentialFile);
  const credentialRoot = join(privateRoot, 'provider-inference');
  mkdirSync(credentialRoot, { recursive: true, mode: 0o700 });
  assertPrivateDirectory(credentialRoot);
  const target = join(credentialRoot, GROK_CREDENTIAL_FILE);
  const encoded = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
  try {
    await new AtomicPrivateStateFile(target, MAX_GROK_CREDENTIAL_BYTES).write(encoded);
  } finally {
    encoded.fill(0);
  }
  return target;
}
