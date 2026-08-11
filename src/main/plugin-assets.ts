import {
  lstatSync,
  opendirSync,
  readFileSync,
  realpathSync,
  statSync,
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
}

export interface PluginTraversalBudget {
  remainingEntries: number;
  truncated: boolean;
}

export function discoverPluginRoots(options: DiscoverPluginRootsOptions): PluginRoot[] {
  const found = new Map<string, PluginRoot>();
  for (const searchPath of options.searchPaths) {
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
    return statSync(path).isFile();
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
  if (atResultLimit(options, found)) {
    options.traversalBudget && (options.traversalBudget.truncated = true);
    return;
  }
  if (!safeIsDir(path)) return;
  const manifestPath = findManifest(path, options.manifestPaths);
  if (manifestPath || (options.allowContentOnly && hasPluginContent(path))) {
    const normalized = normalizeExistingPath(path);
    if (normalized) {
      found.set(normalized, {
        path: normalized,
        name: readPluginName(normalized, manifestPath, options.maxManifestBytes),
      });
    }
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
      walkPluginRoots(join(path, entry.name), depth + 1, options, found);
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

function findManifest(root: string, manifestPaths: readonly string[]): string | null {
  for (const manifestPath of manifestPaths) {
    const candidate = join(root, manifestPath);
    if (safeIsFile(candidate)) return candidate;
  }
  return null;
}

function hasPluginContent(root: string): boolean {
  return safeIsFile(join(root, 'SKILL.md')) ||
    safeIsDir(join(root, 'agents')) ||
    safeIsDir(join(root, 'skills'));
}

function readPluginName(
  root: string,
  manifestPath: string | null,
  maxManifestBytes: number | undefined,
): string {
  if (manifestPath) {
    try {
      if (maxManifestBytes !== undefined && statSync(manifestPath).size > maxManifestBytes) {
        return basename(root);
      }
      const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: unknown };
      if (typeof parsed.name === 'string' && parsed.name.trim()) return parsed.name.trim();
    } catch {
      // Invalid manifests remain inspectable through the directory-name fallback.
    }
  }
  return basename(root);
}
