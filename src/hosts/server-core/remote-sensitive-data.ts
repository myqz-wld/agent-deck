import { basename, isAbsolute, normalize, sep } from 'node:path';

export const REMOTE_SENSITIVE_OMISSION = '[敏感内容已省略]';

const SENSITIVE_DIRECTORY_SEGMENTS = new Set([
  '.aws', '.gnupg', '.kube', '.ssh',
  'private-keys', 'provider-inference', 'secrets',
]);

const PROVIDER_CONFIGURATION_SEGMENTS = new Set([
  '.claude', '.codex', '.grok',
]);

const SENSITIVE_BASENAME_PATTERNS = [
  /^\.env(?:\..+)?$/u,
  /^\.netrc$/u,
  /^\.npmrc$/u,
  /^auth(?:entication)?(?:[-_.].*)?\.json$/u,
  /^credentials?(?:[-_.].*)?(?:\.json|\.toml|\.ya?ml)?$/u,
  /^id_(?:dsa|ecdsa|ed25519|rsa)(?:\.pub)?$/u,
  /^known_hosts(?:\..+)?$/u,
  /^oauth(?:[-_.].*)?\.json$/u,
  /^provider-supervisor(?:[-_.].*)?\.json$/u,
  /^relay-worker(?:[-_.].*)?\.json$/u,
  /^(?:config|settings(?:\.local)?)(?:\.json|\.toml|\.ya?ml)$/u,
  /^active[-_.]?session(?:\.json|\.toml|\.ya?ml)$/u,
  /^secrets?(?:[-_.].*)?(?:\.json|\.toml|\.ya?ml)?$/u,
  /^tokens?(?:[-_.].*)?\.json$/u,
  /\.agentdeck-connection$/u,
  /\.(?:key|p12|pfx|pem)$/u,
];

const SECRET_KEY = /(?:^|_)(?:access_?key(?:_?id)?|api_?key|authorization|bearer|client_?secret|credential|credentials|env|environment|password|passphrase|private_?key|refresh_?token|secret(?:_?access_?key)?|token)(?:_|$)/u;
const SECRET_ASSIGNMENT = /\b((?:access[_-]?key(?:[_-]?id)?|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passphrase|private[_-]?key|refresh[_-]?token|secret(?:[_-]?access[_-]?key)?|token))\s*([:=])\s*([^\s,;]+)/giu;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gu;
const JWT = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/gu;
const AWS_ACCESS_KEY = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu;
const GITHUB_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gu;
const PROVIDER_PREFIXED_SECRET = /\b(?:sk-[A-Za-z0-9_-]{8,}|xai-[A-Za-z0-9_-]{8,}|gsk_[A-Za-z0-9_-]{8,}|hf_[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{20,}|(?:rk|sk)_(?:live|test)_[A-Za-z0-9_-]{8,})\b/gu;
const HIGH_ENTROPY_TOKEN = /(^|[^A-Za-z0-9_+/=-])([A-Za-z0-9_+/=-]{32,})(?=$|[^A-Za-z0-9_+/=-])/gu;
const PRIVATE_KEY_BLOCK = /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/gu;
const QUOTED_HOST_ABSOLUTE_PATH = /(["'])(\/(?!\/)[^"'\r\n]+)\1/gu;
const HOST_ABSOLUTE_PATH = /(^|[^A-Za-z0-9_/.\]])(\/(?!\/)[^\s"'()<>{}\[\],;]+)/gu;
const PROVIDER_CONFIG_REFERENCE = /(^|[\s"'=:,(])((?:\.claude|\.codex|\.grok)\/[A-Za-z0-9._~@%+,=/-]+)/giu;

function decodedPath(value: string): string {
  let output = value;
  for (let pass = 0; pass < 2; pass += 1) {
    try {
      const decoded = decodeURIComponent(output);
      if (decoded === output) break;
      output = decoded;
    } catch {
      break;
    }
  }
  return output.normalize('NFKC').replaceAll('\\', '/');
}

function pathParts(value: string): string[] {
  return decodedPath(normalize(value)).split(/[\\/]+/u)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

function sensitiveBasename(value: string): boolean {
  const name = basename(decodedPath(value)).toLowerCase();
  return SENSITIVE_BASENAME_PATTERNS.some((pattern) => pattern.test(name));
}

/** Session file surfaces hide provider configuration trees in addition to generic secret files. */
export function isRemoteSensitiveWorkspacePath(value: string): boolean {
  const parts = pathParts(value);
  return parts.some((part) =>
    PROVIDER_CONFIGURATION_SEGMENTS.has(part) || SENSITIVE_DIRECTORY_SEGMENTS.has(part)) ||
    sensitiveBasename(value);
}

/** Asset roots may contain provider namespaces, but never admit secret/config-shaped leaf files. */
export function isRemoteSensitiveAssetPath(value: string): boolean {
  const parts = pathParts(value);
  return parts.some((part) => SENSITIVE_DIRECTORY_SEGMENTS.has(part)) || sensitiveBasename(value);
}

export function isRemoteSensitiveKey(value: string): boolean {
  const normalized = value.replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .replace(/[^A-Za-z0-9]+/gu, '_')
    .toLowerCase();
  return SECRET_KEY.test(normalized);
}

function likelyHighEntropySecret(value: string): boolean {
  const sample = value.slice(0, 512);
  const classes = [
    /[a-z]/u.test(sample),
    /[A-Z]/u.test(sample),
    /[0-9]/u.test(sample),
    /[_+/=-]/u.test(sample),
  ].filter(Boolean).length;
  if (classes < 3) return false;
  const counts = new Map<string, number>();
  for (const character of sample) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / sample.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy >= 4;
}

function projectHostPath(
  path: string,
  projectAbsolutePath?: (path: string) => string,
): string {
  if (path === '/dev/null') return path;
  return projectAbsolutePath ? projectAbsolutePath(path) : REMOTE_SENSITIVE_OMISSION;
}

function projectHostPaths(
  value: string,
  projectAbsolutePath?: (path: string) => string,
): string {
  return value
    .replace(
      QUOTED_HOST_ABSOLUTE_PATH,
      (_match, quote: string, path: string) =>
        `${quote}${projectHostPath(path, projectAbsolutePath)}${quote}`,
    )
    .replace(
      HOST_ABSOLUTE_PATH,
      (_match, prefix: string, path: string) =>
        `${prefix}${projectHostPath(path, projectAbsolutePath)}`,
    );
}

export function redactRemoteSensitiveText(
  value: string,
  projectAbsolutePath?: (path: string) => string,
): string {
  const output = value
    .replace(PRIVATE_KEY_BLOCK, REMOTE_SENSITIVE_OMISSION)
    .replace(BEARER, `Bearer ${REMOTE_SENSITIVE_OMISSION}`)
    .replace(JWT, REMOTE_SENSITIVE_OMISSION)
    .replace(AWS_ACCESS_KEY, REMOTE_SENSITIVE_OMISSION)
    .replace(GITHUB_TOKEN, REMOTE_SENSITIVE_OMISSION)
    .replace(PROVIDER_PREFIXED_SECRET, REMOTE_SENSITIVE_OMISSION)
    .replace(PROVIDER_CONFIG_REFERENCE, (_match, prefix: string) =>
      `${prefix}${REMOTE_SENSITIVE_OMISSION}`)
    .replace(SECRET_ASSIGNMENT, (_match, name: string, separator: string) =>
      `${name}${separator}${REMOTE_SENSITIVE_OMISSION}`)
    .replace(
      HIGH_ENTROPY_TOKEN,
      (match, prefix: string, candidate: string) =>
        likelyHighEntropySecret(candidate)
          ? `${prefix}${REMOTE_SENSITIVE_OMISSION}`
          : match,
    );
  return projectHostPaths(output, projectAbsolutePath);
}

export function hasRemoteSensitiveValue(value: string): boolean {
  return redactRemoteSensitiveText(value) !== value;
}

export function relativeDisplayPath(value: string): string {
  return value.split(sep).join('/');
}

export function isAbsoluteOrTraversal(value: string): boolean {
  const decoded = decodedPath(value);
  return isAbsolute(decoded) || decoded.split('/').some((part) => part === '..');
}
