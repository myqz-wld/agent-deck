import {
  lstatSync,
  opendirSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import {
  basename,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';

export interface PluginRoot {
  path: string;
  name: string;
}

export interface DiscoverPluginRootsOptions {
  searchPaths: readonly string[];
  manifestPaths: readonly string[];
  allowContentOnly?: boolean;
  maxDepth?: number;
  maxManifestBytes?: number;
  maxResults?: number;
  traversalBudget?: PluginTraversalBudget;
  /** Reject before any stat, directory enumeration, manifest lookup, or content read. */
  denyPath?: (path: string) => boolean;
  /** Optional authority-owned bounded reader; Remote callers use a same-handle reader. */
  readManifest?: (path: string, maximumBytes: number | undefined) => string | null;
}

export interface PluginTraversalBudget {
  remainingEntries: number;
  truncated: boolean;
}

export function discoverPluginRoots(options: DiscoverPluginRootsOptions): PluginRoot[] {
  const found = new Map<string, PluginRoot>();
  for (const searchPath of options.searchPaths) {
    if (options.denyPath?.(searchPath)) continue;
    if (atResultLimit(options, found)) {
      options.traversalBudget && (options.traversalBudget.truncated = true);
      break;
    }
    walkPluginRoots(resolve(searchPath), 0, options, found);
  }
  return [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function normalizeExistingPath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

export function isWithinExistingRoot(child: string, parent: string): boolean {
  const normalizedParent = normalizeExistingPath(parent);
  if (!normalizedParent) return false;
  const rel = relative(normalizedParent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function safeIsDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function safeIsFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function walkPluginRoots(
  path: string,
  depth: number,
  options: DiscoverPluginRootsOptions,
  found: Map<string, PluginRoot>,
): void {
  if (options.denyPath?.(path)) return;
  if (atResultLimit(options, found)) {
    options.traversalBudget && (options.traversalBudget.truncated = true);
    return;
  }
  if (!safeIsDir(path)) return;
  const normalized = normalizeExistingPath(path);
  if (!normalized || options.denyPath?.(normalized)) return;
  const manifest = findManifest(normalized, options);
  if (manifest || (options.allowContentOnly && hasPluginContent(normalized, options.denyPath))) {
    found.set(normalized, {
      path: normalized,
      name: readPluginName(
        normalized,
        manifest,
        options.maxManifestBytes,
        options.denyPath,
        options.readManifest,
      ),
    });
    return;
  }
  if (depth >= (options.maxDepth ?? 6)) return;
  let directory: ReturnType<typeof opendirSync>;
  try {
    directory = opendirSync(path);
  } catch {
    return;
  }
  try {
    while (true) {
      const entry = directory.readSync();
      if (!entry) break;
      if (!takeTraversalEntry(options.traversalBudget)) break;
      if (entry.name.startsWith('.')) continue;
      const child = join(path, entry.name);
      if (!options.denyPath?.(child)) {
        walkPluginRoots(child, depth + 1, options, found);
      }
      if (atResultLimit(options, found)) {
        options.traversalBudget && (options.traversalBudget.truncated = true);
        break;
      }
    }
  } finally {
    try { directory.closeSync(); } catch {}
  }
}

function atResultLimit(
  options: DiscoverPluginRootsOptions,
  found: ReadonlyMap<string, PluginRoot>,
): boolean {
  return options.maxResults !== undefined && found.size >= Math.max(0, options.maxResults);
}

function takeTraversalEntry(budget: PluginTraversalBudget | undefined): boolean {
  if (!budget) return true;
  if (budget.remainingEntries <= 0) {
    budget.truncated = true;
    return false;
  }
  --budget.remainingEntries;
  return true;
}

interface AcceptedManifest {
  path: string;
  content: string | null;
}

function findManifest(root: string, options: DiscoverPluginRootsOptions): AcceptedManifest | null {
  for (const manifestPath of options.manifestPaths) {
    const candidate = join(root, manifestPath);
    if (options.denyPath?.(candidate) || !safeIsFile(candidate)) continue;
    const content = options.readManifest
      ? options.readManifest(candidate, options.maxManifestBytes)
      : null;
    if (options.readManifest && content === null) continue;
    return { path: candidate, content };
  }
  return null;
}

function hasPluginContent(root: string, denyPath?: (path: string) => boolean): boolean {
  const candidates = [join(root, 'SKILL.md'), join(root, 'agents'), join(root, 'skills')];
  return candidates.some((candidate) => !denyPath?.(candidate) && (
    basename(candidate) === 'SKILL.md' ? safeIsFile(candidate) : safeIsDir(candidate)
  ));
}

function readPluginName(
  root: string,
  manifest: AcceptedManifest | null,
  maxManifestBytes: number | undefined,
  denyPath?: (path: string) => boolean,
  readManifest?: (path: string, maximumBytes: number | undefined) => string | null,
): string {
  if (manifest && !denyPath?.(manifest.path)) {
    try {
      if (maxManifestBytes !== undefined && lstatSync(manifest.path).size > maxManifestBytes) {
        return basename(root);
      }
      const content = manifest.content ?? (readManifest
        ? readManifest(manifest.path, maxManifestBytes)
        : readFileSync(manifest.path, 'utf8'));
      if (content === null) return basename(root);
      const parsed = JSON.parse(content) as { name?: unknown };
      if (typeof parsed.name === 'string' && parsed.name.trim()) return parsed.name.trim();
    } catch {
      // Invalid manifests remain inspectable through the directory-name fallback.
    }
  }
  return basename(root);
}
