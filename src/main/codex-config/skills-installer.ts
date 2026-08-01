/**
 * Agent Deck bundled Codex skills runtime loader.
 *
 * Agent Deck no longer installs bundled skills into user-level
 * `~/.codex/skills/agent-deck`. In-app Codex app-server sessions receive a
 * substituted mirror under app userData through `skills/extraRoots/set`.
 */
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { app } from 'electron';
import { settingsStore } from '@main/store/settings-store';
import { substituteResourcesPlaceholder } from '@main/utils/resources-placeholder';
import log from '@main/utils/logger';

const logger = log.scope('codex-skills-installer');
const MIRROR_MANIFEST_FILENAME = '.agent-deck-skills-manifest.json';
const MIRROR_MANIFEST_VERSION = 1;

interface SkillsMirrorEntry {
  path: string;
  kind: 'directory' | 'file';
  sha256?: string;
}

interface SkillsMirrorManifest {
  version: typeof MIRROR_MANIFEST_VERSION;
  signature: string;
  entries: SkillsMirrorEntry[];
}

interface SkillsMirrorPublicationState {
  stagingPath: string;
  backupPath: string | null;
  stagingPublished: boolean;
  /** True only while the backup is the last known location of the old live mirror. */
  backupContainsPriorMirror: boolean;
}

/** Narrow synchronous filesystem seam so publication failures stay deterministic in tests. */
export interface SkillsMirrorFilesystem {
  cpSync: typeof cpSync;
  existsSync: typeof existsSync;
  mkdirSync: typeof mkdirSync;
  mkdtempSync: typeof mkdtempSync;
  readdirSync: typeof readdirSync;
  readFileSync: typeof readFileSync;
  renameSync: typeof renameSync;
  rmSync: typeof rmSync;
  writeFileSync: typeof writeFileSync;
}

const defaultSkillsMirrorFilesystem: SkillsMirrorFilesystem = {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
};

let skillsMirrorFilesystem = defaultSkillsMirrorFilesystem;

/** Test-only reset/injection point. */
export function __setSkillsMirrorFilesystemForTests(
  overrides: Partial<SkillsMirrorFilesystem> = {},
): void {
  skillsMirrorFilesystem = { ...defaultSkillsMirrorFilesystem, ...overrides };
}

/** App-owned substituted skills extra root passed to Codex app-server. */
export function getCodexSkillsExtraRootDir(): string {
  return join(app.getPath('userData'), 'codex-agent-deck-skills');
}

/** Built-in codex plugin skills source directory (dev/prod aware). */
export function getBuiltinCodexSkillsSourceDir(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'codex-config', 'agent-deck-plugin', 'skills');
  }
  return join(app.getAppPath(), 'resources', 'codex-config', 'agent-deck-plugin', 'skills');
}

/** Prepare and validate the app-owned extra root for a new in-app Codex session. */
export function getCodexSkillExtraRootsForSession(): string[] {
  const written = syncSkills();
  if (!written || written.length === 0) return [];
  return [getCodexSkillsExtraRootDir()];
}

/**
 * Prepare the app-owned mirror used by bootstrap and settings apply hooks.
 *
 * - When enabled, validates or atomically replaces the bundled skills mirror and returns names.
 * - When disabled, removes the app-owned mirror and returns [].
 * - When the source is missing or preparation fails, returns null and never exposes a stale tree.
 */
export function syncSkills(): string[] | null {
  const mirrorDir = getCodexSkillsExtraRootDir();
  if (!settingsStore.get('injectAgentDeckCodexSkills')) {
    removePathIfExists(mirrorDir);
    return [];
  }

  const sourceDir = getBuiltinCodexSkillsSourceDir();
  if (!skillsMirrorFilesystem.existsSync(sourceDir)) {
    if (!isMirrorSelfValid(mirrorDir)) removePathIfExists(mirrorDir);
    logger.warn(`[codex-skills] builtin skills source missing: ${sourceDir}`);
    return null;
  }

  let expected: SkillsMirrorManifest;
  try {
    expected = createExpectedManifest(sourceDir);
  } catch (err) {
    if (!isMirrorSelfValid(mirrorDir)) removePathIfExists(mirrorDir);
    logger.warn(`[codex-skills] inspect builtin skills source failed: ${sourceDir}`, err);
    return null;
  }

  if (isMirrorValid(mirrorDir, expected)) return listSkillNames(expected);

  const priorMirrorWasValid = isMirrorSelfValid(mirrorDir);
  let publication: SkillsMirrorPublicationState | null = null;
  try {
    const stagingPath = createMirrorOperationDirectory(mirrorDir, 'staging');
    publication = {
      stagingPath,
      backupPath: null,
      stagingPublished: false,
      backupContainsPriorMirror: false,
    };
    prepareMirrorInStaging(sourceDir, expected, stagingPath);
    publishPreparedMirror(mirrorDir, publication);
    return listSkillNames(expected);
  } catch (err) {
    logger.warn(`[codex-skills] prepare skill extra root failed: ${mirrorDir}`, err);

    // A second synchronous publisher may have completed while this operation was re-entered.
    if (isMirrorValid(mirrorDir, expected)) {
      if (publication) publication.backupContainsPriorMirror = false;
      return listSkillNames(expected);
    }

    // Never leave a legacy/partial live directory behind after a failed replacement attempt.
    if (!priorMirrorWasValid) {
      removePathIfExists(mirrorDir);
      if (publication) publication.backupContainsPriorMirror = false;
    }
    return null;
  } finally {
    if (publication) cleanupPublicationArtifacts(publication);
  }
}

function createExpectedManifest(sourceDir: string): SkillsMirrorManifest {
  return createManifest(collectTreeEntries(sourceDir, true));
}

function createManifest(entries: SkillsMirrorEntry[]): SkillsMirrorManifest {
  const sortedEntries = [...entries].sort(compareMirrorEntries);
  const signature = createHash('sha256')
    .update(JSON.stringify({ version: MIRROR_MANIFEST_VERSION, entries: sortedEntries }), 'utf8')
    .digest('hex');
  return { version: MIRROR_MANIFEST_VERSION, signature, entries: sortedEntries };
}

function collectTreeEntries(
  root: string,
  substituteMarkdown: boolean,
  relativeParts: string[] = [],
): SkillsMirrorEntry[] {
  const entries: SkillsMirrorEntry[] = [];
  const children = skillsMirrorFilesystem
    .readdirSync(join(root, ...relativeParts), { withFileTypes: true })
    .sort((left, right) => compareStrings(left.name, right.name));

  for (const child of children) {
    const childParts = [...relativeParts, child.name];
    const relativePath = childParts.join('/');
    if (relativeParts.length === 0 && child.name === MIRROR_MANIFEST_FILENAME) {
      if (substituteMarkdown) {
        throw new Error(`reserved bundled skill entry: ${join(root, child.name)}`);
      }
      continue;
    }

    const absolutePath = join(root, ...childParts);
    if (child.isDirectory()) {
      entries.push({ path: relativePath, kind: 'directory' });
      entries.push(...collectTreeEntries(root, substituteMarkdown, childParts));
      continue;
    }
    if (!child.isFile()) {
      throw new Error(`unsupported bundled skill entry: ${absolutePath}`);
    }

    const content =
      substituteMarkdown && absolutePath.endsWith('.md')
        ? Buffer.from(
            substituteResourcesPlaceholder(
              skillsMirrorFilesystem.readFileSync(absolutePath, 'utf8'),
            ),
            'utf8',
          )
        : skillsMirrorFilesystem.readFileSync(absolutePath);
    entries.push({
      path: relativePath,
      kind: 'file',
      sha256: createHash('sha256').update(content).digest('hex'),
    });
  }
  return entries;
}

function prepareMirrorInStaging(
  sourceDir: string,
  expected: SkillsMirrorManifest,
  stagingPath: string,
): void {
  skillsMirrorFilesystem.cpSync(sourceDir, stagingPath, { recursive: true });
  substituteMdFilesInPlace(stagingPath);
  skillsMirrorFilesystem.writeFileSync(
    join(stagingPath, MIRROR_MANIFEST_FILENAME),
    serializeManifest(expected),
    'utf8',
  );
  assertMirrorValid(stagingPath, expected);
}

/** Publishes a ready sibling tree and rolls the prior live mirror back on failure. */
function publishPreparedMirror(
  destination: string,
  state: SkillsMirrorPublicationState,
): void {
  if (skillsMirrorFilesystem.existsSync(destination)) {
    state.backupPath = createMirrorOperationDirectory(destination, 'backup');
    skillsMirrorFilesystem.rmSync(state.backupPath, { recursive: true, force: true });
    skillsMirrorFilesystem.renameSync(destination, state.backupPath);
    state.backupContainsPriorMirror = true;
  }

  try {
    skillsMirrorFilesystem.renameSync(state.stagingPath, destination);
    state.stagingPublished = true;
    state.backupContainsPriorMirror = false;
  } catch (publishError) {
    if (state.backupPath && state.backupContainsPriorMirror) {
      try {
        skillsMirrorFilesystem.renameSync(state.backupPath, destination);
        state.backupContainsPriorMirror = false;
      } catch (rollbackError) {
        logger.warn(`[codex-skills] skill mirror rollback failed: ${destination}`, rollbackError);
      }
    }
    throw publishError;
  }
}

function createMirrorOperationDirectory(
  destination: string,
  kind: 'staging' | 'backup',
): string {
  const parent = dirname(destination);
  skillsMirrorFilesystem.mkdirSync(parent, { recursive: true });
  return skillsMirrorFilesystem.mkdtempSync(
    join(parent, `.${basename(destination)}.${kind}-${process.pid}-`),
  );
}

function assertMirrorValid(dir: string, expected: SkillsMirrorManifest): void {
  const manifestPath = join(dir, MIRROR_MANIFEST_FILENAME);
  const rawManifest = skillsMirrorFilesystem.readFileSync(manifestPath, 'utf8');
  if (rawManifest !== serializeManifest(expected)) {
    throw new Error(`skill mirror signature mismatch: ${dir}`);
  }
  const actualEntries = collectTreeEntries(dir, false).sort(compareMirrorEntries);
  if (JSON.stringify(actualEntries) !== JSON.stringify(expected.entries)) {
    throw new Error(`skill mirror contents mismatch: ${dir}`);
  }
}

function isMirrorValid(dir: string, expected: SkillsMirrorManifest): boolean {
  try {
    assertMirrorValid(dir, expected);
    return true;
  } catch {
    return false;
  }
}

function isMirrorSelfValid(dir: string): boolean {
  try {
    const rawManifest = skillsMirrorFilesystem.readFileSync(
      join(dir, MIRROR_MANIFEST_FILENAME),
      'utf8',
    );
    const parsed = parseManifest(rawManifest);
    if (rawManifest !== serializeManifest(parsed)) return false;
    const actualEntries = collectTreeEntries(dir, false).sort(compareMirrorEntries);
    return JSON.stringify(actualEntries) === JSON.stringify(parsed.entries);
  } catch {
    return false;
  }
}

function parseManifest(raw: string): SkillsMirrorManifest {
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== 'object') throw new Error('invalid skill mirror manifest');
  const candidate = value as Partial<SkillsMirrorManifest>;
  if (candidate.version !== MIRROR_MANIFEST_VERSION || !Array.isArray(candidate.entries)) {
    throw new Error('unsupported skill mirror manifest');
  }
  const entries = candidate.entries.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new Error('invalid skill mirror entry');
    const item = entry as Partial<SkillsMirrorEntry>;
    if (typeof item.path !== 'string' || !isSafeRelativeManifestPath(item.path)) {
      throw new Error('invalid skill mirror path');
    }
    if (item.kind === 'directory' && item.sha256 === undefined) {
      return { path: item.path, kind: item.kind } satisfies SkillsMirrorEntry;
    }
    if (item.kind === 'file' && /^[a-f0-9]{64}$/.test(item.sha256 ?? '')) {
      return { path: item.path, kind: item.kind, sha256: item.sha256 } satisfies SkillsMirrorEntry;
    }
    throw new Error('invalid skill mirror entry');
  });
  const canonical = createManifest(entries);
  if (candidate.signature !== canonical.signature) throw new Error('invalid skill mirror signature');
  return canonical;
}

function isSafeRelativeManifestPath(path: string): boolean {
  const segments = path.split('/');
  return (
    path.length > 0 &&
    !path.startsWith('/') &&
    segments.every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

function serializeManifest(manifest: SkillsMirrorManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function listSkillNames(manifest: SkillsMirrorManifest): string[] {
  const topLevelDirectories = new Set(
    manifest.entries
      .filter((entry) => entry.kind === 'directory' && !entry.path.includes('/'))
      .map((entry) => entry.path),
  );
  const files = new Set(
    manifest.entries.filter((entry) => entry.kind === 'file').map((entry) => entry.path),
  );
  return [...topLevelDirectories]
    .filter((name) => files.has(`${name}/SKILL.md`))
    .sort(compareStrings);
}

function substituteMdFilesInPlace(dir: string): void {
  const entries = skillsMirrorFilesystem
    .readdirSync(dir, { withFileTypes: true })
    .sort((left, right) => compareStrings(left.name, right.name));
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      substituteMdFilesInPlace(path);
      continue;
    }
    if (!entry.isFile()) throw new Error(`unsupported staged skill entry: ${path}`);
    if (!path.endsWith('.md')) continue;
    const raw = skillsMirrorFilesystem.readFileSync(path, 'utf8');
    const substituted = substituteResourcesPlaceholder(raw);
    if (substituted !== raw) skillsMirrorFilesystem.writeFileSync(path, substituted, 'utf8');
  }
}

function cleanupPublicationArtifacts(state: SkillsMirrorPublicationState): void {
  if (!state.stagingPublished) cleanupOperationPath(state.stagingPath, 'staging');
  if (state.backupPath && !state.backupContainsPriorMirror) {
    cleanupOperationPath(state.backupPath, 'backup');
  }
}

function cleanupOperationPath(path: string, kind: 'staging' | 'backup'): void {
  try {
    removePathIfExists(path);
  } catch (err) {
    logger.warn(`[codex-skills] skill mirror ${kind} cleanup failed: ${path}`, err);
  }
}

function removePathIfExists(path: string): void {
  if (skillsMirrorFilesystem.existsSync(path)) {
    skillsMirrorFilesystem.rmSync(path, { recursive: true, force: true });
  }
}

function compareMirrorEntries(left: SkillsMirrorEntry, right: SkillsMirrorEntry): number {
  return compareStrings(left.path, right.path) || compareStrings(left.kind, right.kind);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
