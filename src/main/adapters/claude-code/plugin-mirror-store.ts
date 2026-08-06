import { basename, dirname, join } from 'node:path';

export interface PluginMirrorFilesystem {
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

export interface PluginMirrorSyncRequest {
  source: string;
  destination: string;
  includeSkills: boolean;
  includeAgents: boolean;
}

export type PluginMirrorDiagnostic =
  | { kind: 'source-missing'; source: string }
  | { kind: 'install-failed'; destination: string; error: unknown }
  | { kind: 'rollback-failed'; destination: string; error: unknown }
  | { kind: 'cleanup-failed'; operation: 'staging' | 'backup'; path: string; error: unknown };

export interface PluginMirrorStore {
  sync(request: PluginMirrorSyncRequest): string | null;
}

interface PublicationState {
  stagingPath: string;
  backupPath: string | null;
  stagingPublished: boolean;
  /** True only while the backup is the last known location of the old live mirror. */
  backupContainsLiveMirror: boolean;
}

export function createPluginMirrorStore(options: {
  filesystem: PluginMirrorFilesystem;
  transformMarkdown: (content: string) => string;
  diagnostic?: (event: PluginMirrorDiagnostic) => void;
  operationTag?: string;
}): PluginMirrorStore {
  const { filesystem, transformMarkdown, diagnostic } = options;
  const operationTag = options.operationTag ?? String(process.pid);
  let publishedSignature: string | null = null;

  function sync(request: PluginMirrorSyncRequest): string | null {
    const signature = requestSignature(request);
    if (
      publishedSignature === signature &&
      isMirrorValid(request.destination, request, filesystem)
    ) {
      return request.destination;
    }

    publishedSignature = null;
    if (!filesystem.existsSync(request.source)) {
      diagnostic?.({ kind: 'source-missing', source: request.source });
      return null;
    }

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
        backupContainsLiveMirror: false,
      };
      prepareMirror(request, publication.stagingPath, filesystem, transformMarkdown);
      publishMirror(request.destination, publication, operationTag, filesystem, diagnostic);
      publishedSignature = signature;
      return request.destination;
    } catch (error) {
      diagnostic?.({ kind: 'install-failed', destination: request.destination, error });
      publishedSignature = null;
      return null;
    } finally {
      if (publication && !publication.stagingPublished) {
        cleanupOperationPath(publication.stagingPath, 'staging', filesystem, diagnostic);
      }
      if (publication?.backupPath && !publication.backupContainsLiveMirror) {
        cleanupOperationPath(publication.backupPath, 'backup', filesystem, diagnostic);
      }
    }
  }

  return { sync };
}

function requestSignature(request: PluginMirrorSyncRequest): string {
  return `${request.source}|${request.destination}|skills:${request.includeSkills ? 'on' : 'off'}|agents:${request.includeAgents ? 'on' : 'off'}`;
}

function createOperationDirectory(
  destination: string,
  kind: 'staging' | 'backup',
  operationTag: string,
  filesystem: PluginMirrorFilesystem,
): string {
  const parent = dirname(destination);
  filesystem.mkdirSync(parent, { recursive: true });
  return filesystem.mkdtempSync(
    join(parent, `.${basename(destination)}.${kind}-${operationTag}-`),
  );
}

function prepareMirror(
  request: PluginMirrorSyncRequest,
  stagingPath: string,
  filesystem: PluginMirrorFilesystem,
  transformMarkdown: (content: string) => string,
): void {
  filesystem.cpSync(request.source, stagingPath, { recursive: true });
  if (!request.includeSkills) {
    filesystem.rmSync(join(stagingPath, 'skills'), { recursive: true, force: true });
  }
  if (!request.includeAgents) {
    filesystem.rmSync(join(stagingPath, 'agents'), { recursive: true, force: true });
  }
  transformMarkdownFiles(stagingPath, filesystem, transformMarkdown);
  assertMirrorValid(stagingPath, request, filesystem);
}

function publishMirror(
  destination: string,
  state: PublicationState,
  operationTag: string,
  filesystem: PluginMirrorFilesystem,
  diagnostic?: (event: PluginMirrorDiagnostic) => void,
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
    state.backupContainsLiveMirror = true;
  }

  try {
    filesystem.renameSync(state.stagingPath, destination);
    state.stagingPublished = true;
    state.backupContainsLiveMirror = false;
  } catch (publishError) {
    if (state.backupPath && state.backupContainsLiveMirror) {
      try {
        filesystem.renameSync(state.backupPath, destination);
        state.backupContainsLiveMirror = false;
      } catch (error) {
        diagnostic?.({ kind: 'rollback-failed', destination, error });
      }
    }
    throw publishError;
  }
}

function assertMirrorValid(
  directory: string,
  request: Pick<PluginMirrorSyncRequest, 'includeSkills' | 'includeAgents'>,
  filesystem: PluginMirrorFilesystem,
): void {
  const manifestPath = join(directory, '.claude-plugin', 'plugin.json');
  if (!filesystem.existsSync(manifestPath)) {
    throw new Error(`plugin manifest missing: ${manifestPath}`);
  }
  JSON.parse(filesystem.readFileSync(manifestPath, 'utf8'));
  if (!request.includeSkills && filesystem.existsSync(join(directory, 'skills'))) {
    throw new Error(`disabled skills directory remains in mirror: ${directory}`);
  }
  if (!request.includeAgents && filesystem.existsSync(join(directory, 'agents'))) {
    throw new Error(`disabled agents directory remains in mirror: ${directory}`);
  }
}

function isMirrorValid(
  directory: string,
  request: Pick<PluginMirrorSyncRequest, 'includeSkills' | 'includeAgents'>,
  filesystem: PluginMirrorFilesystem,
): boolean {
  try {
    assertMirrorValid(directory, request, filesystem);
    return true;
  } catch {
    return false;
  }
}

function transformMarkdownFiles(
  directory: string,
  filesystem: PluginMirrorFilesystem,
  transformMarkdown: (content: string) => string,
): void {
  for (const entry of filesystem.readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      transformMarkdownFiles(path, filesystem, transformMarkdown);
      continue;
    }
    if (!entry.isFile() || !path.endsWith('.md')) continue;
    const raw = filesystem.readFileSync(path, 'utf8');
    const transformed = transformMarkdown(raw);
    if (transformed !== raw) filesystem.writeFileSync(path, transformed, 'utf8');
  }
}

function cleanupOperationPath(
  path: string,
  operation: 'staging' | 'backup',
  filesystem: PluginMirrorFilesystem,
  diagnostic?: (event: PluginMirrorDiagnostic) => void,
): void {
  try {
    if (filesystem.existsSync(path)) {
      filesystem.rmSync(path, { recursive: true, force: true });
    }
  } catch (error) {
    diagnostic?.({ kind: 'cleanup-failed', operation, path, error });
  }
}
