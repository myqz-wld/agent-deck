import {
  canonicalProviderDirectory,
  readOptionalProviderFile,
  removeProviderFile,
  writeProviderFile,
  type ProviderProjectionMode,
} from './provider-home-files';
import {
  projectProviderSessionFiles,
  syncProviderSessionFiles,
} from './provider-session-projection';

export const PROVIDER_HOME_AUTH_FILES = Object.freeze([
  '.claude/.credentials.json',
  '.codex/auth.json',
] as const);
const RETIRED_PROVIDER_HOME_AUTH_FILES = Object.freeze([
  '.grok/auth.json',
] as const);

export function projectProviderHomeAuthFiles(
  sourceHome: string,
  destinationHome: string,
  mode: ProviderProjectionMode = 'create-only',
): readonly string[] {
  const source = canonicalProviderDirectory(sourceHome, 'provider source home', false);
  const destination = canonicalProviderDirectory(
    destinationHome,
    'provider destination home',
    true,
  );
  const projected: string[] = [];
  for (const relativePath of RETIRED_PROVIDER_HOME_AUTH_FILES) {
    removeProviderFile(destination, relativePath);
  }
  for (const relativePath of PROVIDER_HOME_AUTH_FILES) {
    const bytes = readOptionalProviderFile(source, relativePath, { private: true });
    if (!bytes) {
      if (mode === 'replace') removeProviderFile(destination, relativePath);
      continue;
    }
    try {
      writeProviderFile(destination, relativePath, bytes, mode);
      projected.push(relativePath);
    } finally {
      bytes.fill(0);
    }
  }
  return Object.freeze(projected);
}

/** Replace the exact auth projection; a missing source removes stale projected credentials. */
export function syncProviderHomeAuthFiles(
  sourceHome: string | null,
  destinationHome: string,
): readonly string[] {
  if (sourceHome !== null) {
    return projectProviderHomeAuthFiles(sourceHome, destinationHome, 'replace');
  }
  const destination = canonicalProviderDirectory(
    destinationHome,
    'provider destination home',
    true,
  );
  for (const relativePath of [
    ...PROVIDER_HOME_AUTH_FILES,
    ...RETIRED_PROVIDER_HOME_AUTH_FILES,
  ]) {
    removeProviderFile(destination, relativePath);
  }
  return Object.freeze([]);
}

/** Project only the provider runtime inputs required by isolated Worker sessions. */
export function projectProviderHomeFiles(
  sourceHome: string,
  destinationHome: string,
  mode: ProviderProjectionMode = 'create-only',
): readonly string[] {
  return Object.freeze([
    ...projectProviderHomeAuthFiles(sourceHome, destinationHome, mode),
    ...projectProviderSessionFiles(sourceHome, destinationHome, mode),
  ]);
}

/** Refresh auth, provider definitions, and the derived non-secret creation snapshot together. */
export function syncProviderHomeFiles(
  sourceHome: string | null,
  destinationHome: string,
): readonly string[] {
  return Object.freeze([
    ...syncProviderHomeAuthFiles(sourceHome, destinationHome),
    ...syncProviderSessionFiles(sourceHome, destinationHome),
  ]);
}
