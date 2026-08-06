import { basename, dirname, join } from 'node:path';
import {
  SKILLS_MIRROR_MANIFEST_FILENAME,
  assertSkillsMirrorValid,
  createExpectedSkillsMirrorManifest,
  isSkillsMirrorSelfValid,
  isSkillsMirrorValid,
  listSkillsFromManifest,
  serializeSkillsMirrorManifest,
  type SkillsMirrorManifest,
} from './skills-mirror-manifest';

export interface SkillsMirrorFilesystem {
  cpSync: typeof import('node:fs').cpSync;
  existsSync: typeof import('node:fs').existsSync;
  mkdirSync: typeof import('node:fs').mkdirSync;
  mkdtempSync: typeof import('node:fs').mkdtempSync;
  readdirSync: typeof import('node:fs').readdirSync;
  readFileSync: typeof import('node:fs').readFileSync;
  renameSync: typeof import('node:fs').renameSync;
  rmSync: typeof import('node:fs').rmSync;
  writeFileSync: typeof import('node:fs').writeFileSync;
}

export interface SkillsMirrorSyncRequest {
  source: string;
  destination: string;
}

export type SkillsMirrorDiagnostic =
  | { kind: 'source-missing'; source: string }
  | { kind: 'source-inspection-failed'; source: string; error: unknown }
  | { kind: 'prepare-failed'; destination: string; error: unknown }
  | { kind: 'rollback-failed'; destination: string; error: unknown }
  | { kind: 'cleanup-failed'; operation: 'staging' | 'backup'; path: string; error: unknown };

export interface SkillsMirrorStore {
  remove(destination: string): void;
  sync(request: SkillsMirrorSyncRequest): string[] | null;
}

interface PublicationState {
  stagingPath: string;
  backupPath: string | null;
  stagingPublished: boolean;
  /** True only while the backup is the last known location of the old live mirror. */
  backupContainsPriorMirror: boolean;
}

export function createSkillsMirrorStore(options: {
  filesystem: SkillsMirrorFilesystem;
  transformMarkdown: (content: string) => string;
  diagnostic?: (event: SkillsMirrorDiagnostic) => void;
  operationTag?: string;
}): SkillsMirrorStore {
  const { filesystem, transformMarkdown, diagnostic } = options;
  const operationTag = options.operationTag ?? String(process.pid);

  function remove(destination: string): void {
    removePathIfExists(destination, filesystem);
  }

  function sync(request: SkillsMirrorSyncRequest): string[] | null {
    if (!filesystem.existsSync(request.source)) {
      if (!isSkillsMirrorSelfValid(request.destination, filesystem)) {
        remove(request.destination);
      }
      diagnostic?.({ kind: 'source-missing', source: request.source });
      return null;
    }

    let expected: SkillsMirrorManifest;
    try {
      expected = createExpectedSkillsMirrorManifest(
        request.source,
        filesystem,
        transformMarkdown,
      );
    } catch (error) {
      if (!isSkillsMirrorSelfValid(request.destination, filesystem)) {
        remove(request.destination);
      }
      diagnostic?.({ kind: 'source-inspection-failed', source: request.source, error });
      return null;
    }

    if (isSkillsMirrorValid(request.destination, expected, filesystem)) {
      return listSkillsFromManifest(expected);
    }

    const priorMirrorWasValid = isSkillsMirrorSelfValid(
      request.destination,
      filesystem,
    );
    let publication: PublicationState | null = null;
    try {
      publication = {
        stagingPath: createOperationDirectory(
          request.destination,
          'staging',
          operationTag,
          filesystem,
        ),
        backupPath: null,
        stagingPublished: false,
        backupContainsPriorMirror: false,
      };
      prepareMirror(request, expected, publication.stagingPath, filesystem, transformMarkdown);
      publishMirror(request.destination, publication, operationTag, filesystem, diagnostic);
      return listSkillsFromManifest(expected);
    } catch (error) {
      diagnostic?.({ kind: 'prepare-failed', destination: request.destination, error });

      // A nested synchronous publisher may have completed while this operation was re-entered.
      if (isSkillsMirrorValid(request.destination, expected, filesystem)) {
        if (publication) publication.backupContainsPriorMirror = false;
        return listSkillsFromManifest(expected);
      }

      if (!priorMirrorWasValid) {
        remove(request.destination);
        if (publication) publication.backupContainsPriorMirror = false;
      }
      return null;
    } finally {
      if (publication) cleanupPublicationArtifacts(publication, filesystem, diagnostic);
    }
  }

  return { remove, sync };
}

function prepareMirror(
  request: SkillsMirrorSyncRequest,
  expected: SkillsMirrorManifest,
  stagingPath: string,
  filesystem: SkillsMirrorFilesystem,
  transformMarkdown: (content: string) => string,
): void {
  filesystem.cpSync(request.source, stagingPath, { recursive: true });
  transformMarkdownFiles(stagingPath, filesystem, transformMarkdown);
  filesystem.writeFileSync(
    join(stagingPath, SKILLS_MIRROR_MANIFEST_FILENAME),
    serializeSkillsMirrorManifest(expected),
    'utf8',
  );
  assertSkillsMirrorValid(stagingPath, expected, filesystem);
}

function publishMirror(
  destination: string,
  state: PublicationState,
  operationTag: string,
  filesystem: SkillsMirrorFilesystem,
  diagnostic?: (event: SkillsMirrorDiagnostic) => void,
): void {
  if (filesystem.existsSync(destination)) {
    state.backupPath = createOperationDirectory(
      destination,
      'backup',
      operationTag,
      filesystem,
    );
    filesystem.rmSync(state.backupPath, { recursive: true, force: true });
    filesystem.renameSync(destination, state.backupPath);
    state.backupContainsPriorMirror = true;
  }

  try {
    filesystem.renameSync(state.stagingPath, destination);
    state.stagingPublished = true;
    state.backupContainsPriorMirror = false;
  } catch (publishError) {
    if (state.backupPath && state.backupContainsPriorMirror) {
      try {
        filesystem.renameSync(state.backupPath, destination);
        state.backupContainsPriorMirror = false;
      } catch (error) {
        diagnostic?.({ kind: 'rollback-failed', destination, error });
      }
    }
    throw publishError;
  }
}

function createOperationDirectory(
  destination: string,
  operation: 'staging' | 'backup',
  operationTag: string,
  filesystem: SkillsMirrorFilesystem,
): string {
  const parent = dirname(destination);
  filesystem.mkdirSync(parent, { recursive: true });
  return filesystem.mkdtempSync(
    join(parent, `.${basename(destination)}.${operation}-${operationTag}-`),
  );
}

function transformMarkdownFiles(
  directory: string,
  filesystem: SkillsMirrorFilesystem,
  transformMarkdown: (content: string) => string,
): void {
  const entries = filesystem
    .readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => compareStrings(left.name, right.name));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      transformMarkdownFiles(path, filesystem, transformMarkdown);
      continue;
    }
    if (!entry.isFile()) throw new Error(`unsupported staged skill entry: ${path}`);
    if (!path.endsWith('.md')) continue;
    const raw = filesystem.readFileSync(path, 'utf8');
    const transformed = transformMarkdown(raw);
    if (transformed !== raw) filesystem.writeFileSync(path, transformed, 'utf8');
  }
}

function cleanupPublicationArtifacts(
  state: PublicationState,
  filesystem: SkillsMirrorFilesystem,
  diagnostic?: (event: SkillsMirrorDiagnostic) => void,
): void {
  if (!state.stagingPublished) {
    cleanupOperationPath(state.stagingPath, 'staging', filesystem, diagnostic);
  }
  if (state.backupPath && !state.backupContainsPriorMirror) {
    cleanupOperationPath(state.backupPath, 'backup', filesystem, diagnostic);
  }
}

function cleanupOperationPath(
  path: string,
  operation: 'staging' | 'backup',
  filesystem: SkillsMirrorFilesystem,
  diagnostic?: (event: SkillsMirrorDiagnostic) => void,
): void {
  try {
    removePathIfExists(path, filesystem);
  } catch (error) {
    diagnostic?.({ kind: 'cleanup-failed', operation, path, error });
  }
}

function removePathIfExists(path: string, filesystem: SkillsMirrorFilesystem): void {
  if (filesystem.existsSync(path)) {
    filesystem.rmSync(path, { recursive: true, force: true });
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
