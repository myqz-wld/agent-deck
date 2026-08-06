import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const SKILLS_MIRROR_MANIFEST_FILENAME = '.agent-deck-skills-manifest.json';
const SKILLS_MIRROR_MANIFEST_VERSION = 1;

export interface SkillsMirrorEntry {
  path: string;
  kind: 'directory' | 'file';
  sha256?: string;
}

export interface SkillsMirrorManifest {
  version: typeof SKILLS_MIRROR_MANIFEST_VERSION;
  signature: string;
  entries: SkillsMirrorEntry[];
}

export interface SkillsMirrorManifestFilesystem {
  readdirSync: typeof import('node:fs').readdirSync;
  readFileSync: typeof import('node:fs').readFileSync;
}

export function createExpectedSkillsMirrorManifest(
  sourceDir: string,
  filesystem: SkillsMirrorManifestFilesystem,
  transformMarkdown: (content: string) => string,
): SkillsMirrorManifest {
  return createManifest(
    collectTreeEntries(sourceDir, filesystem, transformMarkdown),
  );
}

export function assertSkillsMirrorValid(
  directory: string,
  expected: SkillsMirrorManifest,
  filesystem: SkillsMirrorManifestFilesystem,
): void {
  const manifestPath = join(directory, SKILLS_MIRROR_MANIFEST_FILENAME);
  const rawManifest = filesystem.readFileSync(manifestPath, 'utf8');
  if (rawManifest !== serializeSkillsMirrorManifest(expected)) {
    throw new Error(`skill mirror signature mismatch: ${directory}`);
  }
  const actualEntries = collectTreeEntries(directory, filesystem).sort(compareMirrorEntries);
  if (JSON.stringify(actualEntries) !== JSON.stringify(expected.entries)) {
    throw new Error(`skill mirror contents mismatch: ${directory}`);
  }
}

export function isSkillsMirrorValid(
  directory: string,
  expected: SkillsMirrorManifest,
  filesystem: SkillsMirrorManifestFilesystem,
): boolean {
  try {
    assertSkillsMirrorValid(directory, expected, filesystem);
    return true;
  } catch {
    return false;
  }
}

export function isSkillsMirrorSelfValid(
  directory: string,
  filesystem: SkillsMirrorManifestFilesystem,
): boolean {
  try {
    const rawManifest = filesystem.readFileSync(
      join(directory, SKILLS_MIRROR_MANIFEST_FILENAME),
      'utf8',
    );
    const parsed = parseSkillsMirrorManifest(rawManifest);
    if (rawManifest !== serializeSkillsMirrorManifest(parsed)) return false;
    const actualEntries = collectTreeEntries(directory, filesystem).sort(compareMirrorEntries);
    return JSON.stringify(actualEntries) === JSON.stringify(parsed.entries);
  } catch {
    return false;
  }
}

export function parseSkillsMirrorManifest(raw: string): SkillsMirrorManifest {
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== 'object') {
    throw new Error('invalid skill mirror manifest');
  }
  const candidate = value as Partial<SkillsMirrorManifest>;
  if (
    candidate.version !== SKILLS_MIRROR_MANIFEST_VERSION ||
    !Array.isArray(candidate.entries)
  ) {
    throw new Error('unsupported skill mirror manifest');
  }
  const entries = candidate.entries.map((entry) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error('invalid skill mirror entry');
    }
    const item = entry as Partial<SkillsMirrorEntry>;
    if (typeof item.path !== 'string' || !isSafeRelativeManifestPath(item.path)) {
      throw new Error('invalid skill mirror path');
    }
    if (item.kind === 'directory' && item.sha256 === undefined) {
      return { path: item.path, kind: item.kind } satisfies SkillsMirrorEntry;
    }
    if (item.kind === 'file' && /^[a-f0-9]{64}$/.test(item.sha256 ?? '')) {
      return {
        path: item.path,
        kind: item.kind,
        sha256: item.sha256,
      } satisfies SkillsMirrorEntry;
    }
    throw new Error('invalid skill mirror entry');
  });
  const canonical = createManifest(entries);
  if (candidate.signature !== canonical.signature) {
    throw new Error('invalid skill mirror signature');
  }
  return canonical;
}

export function serializeSkillsMirrorManifest(manifest: SkillsMirrorManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function listSkillsFromManifest(manifest: SkillsMirrorManifest): string[] {
  const topLevelDirectories = new Set(
    manifest.entries
      .filter((entry) => entry.kind === 'directory' && !entry.path.includes('/'))
      .map((entry) => entry.path),
  );
  const files = new Set(
    manifest.entries
      .filter((entry) => entry.kind === 'file')
      .map((entry) => entry.path),
  );
  return [...topLevelDirectories]
    .filter((name) => files.has(`${name}/SKILL.md`))
    .sort(compareStrings);
}

function createManifest(entries: SkillsMirrorEntry[]): SkillsMirrorManifest {
  const sortedEntries = [...entries].sort(compareMirrorEntries);
  const signature = createHash('sha256')
    .update(
      JSON.stringify({ version: SKILLS_MIRROR_MANIFEST_VERSION, entries: sortedEntries }),
      'utf8',
    )
    .digest('hex');
  return {
    version: SKILLS_MIRROR_MANIFEST_VERSION,
    signature,
    entries: sortedEntries,
  };
}

function collectTreeEntries(
  root: string,
  filesystem: SkillsMirrorManifestFilesystem,
  transformMarkdown?: (content: string) => string,
  relativeParts: string[] = [],
): SkillsMirrorEntry[] {
  const entries: SkillsMirrorEntry[] = [];
  const children = filesystem
    .readdirSync(join(root, ...relativeParts), { withFileTypes: true })
    .sort((left, right) => compareStrings(left.name, right.name));

  for (const child of children) {
    const childParts = [...relativeParts, child.name];
    const relativePath = childParts.join('/');
    if (relativeParts.length === 0 && child.name === SKILLS_MIRROR_MANIFEST_FILENAME) {
      if (transformMarkdown) {
        throw new Error(`reserved bundled skill entry: ${join(root, child.name)}`);
      }
      continue;
    }

    const absolutePath = join(root, ...childParts);
    if (child.isDirectory()) {
      entries.push({ path: relativePath, kind: 'directory' });
      entries.push(
        ...collectTreeEntries(
          root,
          filesystem,
          transformMarkdown,
          childParts,
        ),
      );
      continue;
    }
    if (!child.isFile()) {
      throw new Error(`unsupported bundled skill entry: ${absolutePath}`);
    }

    const content =
      transformMarkdown && absolutePath.endsWith('.md')
        ? Buffer.from(
            transformMarkdown(filesystem.readFileSync(absolutePath, 'utf8')),
            'utf8',
          )
        : filesystem.readFileSync(absolutePath);
    entries.push({
      path: relativePath,
      kind: 'file',
      sha256: createHash('sha256').update(content).digest('hex'),
    });
  }
  return entries;
}

function isSafeRelativeManifestPath(path: string): boolean {
  const segments = path.split('/');
  return (
    path.length > 0 &&
    !path.startsWith('/') &&
    segments.every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

function compareMirrorEntries(left: SkillsMirrorEntry, right: SkillsMirrorEntry): number {
  return compareStrings(left.path, right.path) || compareStrings(left.kind, right.kind);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
