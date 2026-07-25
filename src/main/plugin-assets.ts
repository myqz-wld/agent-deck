import {
  lstatSync,
  readFileSync,
  readdirSync,
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
}

export function discoverPluginRoots(options: DiscoverPluginRootsOptions): PluginRoot[] {
  const found = new Map<string, PluginRoot>();
  for (const searchPath of options.searchPaths) {
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
  if (!safeIsDir(path)) return;
  const manifestPath = findManifest(path, options.manifestPaths);
  if (manifestPath || (options.allowContentOnly && hasPluginContent(path))) {
    const normalized = normalizeExistingPath(path);
    if (normalized) {
      found.set(normalized, {
        path: normalized,
        name: readPluginName(normalized, manifestPath),
      });
    }
    return;
  }
  if (depth >= (options.maxDepth ?? 6)) return;
  let entries: string[];
  try {
    entries = readdirSync(path);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    walkPluginRoots(join(path, entry), depth + 1, options, found);
  }
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

function readPluginName(root: string, manifestPath: string | null): string {
  if (manifestPath) {
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: unknown };
      if (typeof parsed.name === 'string' && parsed.name.trim()) return parsed.name.trim();
    } catch {
      // Invalid manifests remain inspectable through the directory-name fallback.
    }
  }
  return basename(root);
}
