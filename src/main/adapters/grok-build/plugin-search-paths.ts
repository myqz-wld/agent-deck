import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

const MAX_PLUGIN_STATE_BYTES = 1024 * 1024;
const CLAUDE_PLUGIN_CONTAINER_DIRS = new Set(['cache', 'marketplaces']);

export const GROK_PLUGIN_MANIFEST_PATHS = [
  '.grok-plugin/plugin.json',
  '.claude-plugin/plugin.json',
  'plugin.json',
] as const;

export interface GrokPluginSearchIo {
  readText(path: string): string | null;
  listDirectories(path: string): string[];
}

interface GrokPluginConfig {
  enabled: ReadonlySet<string> | null;
  paths: string[];
}

const localIo: GrokPluginSearchIo = {
  readText(path) {
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > MAX_PLUGIN_STATE_BYTES) return null;
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  },
  listDirectories(path) {
    try {
      return readdirSync(path, { withFileTypes: true })
        .filter((entry) => !entry.name.startsWith('.') && entry.isDirectory())
        .map((entry) => join(path, entry.name));
    } catch {
      return [];
    }
  },
};

export function getConfiguredGrokPluginPaths(
  configPath: string,
  baseDir: string,
  userHome = homedir(),
  io: GrokPluginSearchIo = localIo,
): string[] {
  return readGrokPluginConfig(configPath, baseDir, userHome, io).paths;
}

/** Resolve effective user Plugin roots without walking historical marketplace/cache versions. */
export function getGrokUserPluginSearchPaths(input: {
  grokHome: string;
  claudeHome: string;
  userHome?: string;
  io?: GrokPluginSearchIo;
}): string[] {
  const userHome = input.userHome ?? homedir();
  const io = input.io ?? localIo;
  const config = readGrokPluginConfig(
    join(input.grokHome, 'config.toml'),
    input.grokHome,
    userHome,
    io,
  );
  const paths = [
    ...config.paths,
    ...readGrokInstalledPluginPaths(input.grokHome, config.enabled, io),
    ...readClaudeInstalledPluginPaths(input.claudeHome, io),
    join(input.grokHome, 'plugins'),
    ...listDirectClaudePluginPaths(input.claudeHome, io),
  ];
  return [...new Set(paths.map((path) => resolve(path)))];
}

function readGrokPluginConfig(
  configPath: string,
  baseDir: string,
  userHome: string,
  io: GrokPluginSearchIo,
): GrokPluginConfig {
  const text = io.readText(configPath);
  if (!text) return { enabled: null, paths: [] };
  const section = readTomlSection(text, 'plugins');
  if (!section) return { enabled: null, paths: [] };
  const enabled = readTomlStringArray(section, 'enabled');
  const configuredPaths = readTomlStringArray(section, 'paths') ?? [];
  return {
    enabled: enabled === null ? null : new Set(enabled),
    paths: configuredPaths.map((value) => {
      if (value.startsWith('~/')) return join(userHome, value.slice(2));
      return isAbsolute(value) ? value : resolve(baseDir, value);
    }),
  };
}

function readTomlSection(text: string, name: string): string | null {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const header = new RegExp(`^\\[${escapedName}\\]\\s*$`, 'm').exec(text);
  if (!header) return null;
  const remainder = text.slice(header.index + header[0].length);
  const nextHeader = remainder.search(/^\[[^\]]+\]\s*$/m);
  return nextHeader < 0 ? remainder : remainder.slice(0, nextHeader);
}

function readTomlStringArray(section: string, key: string): string[] | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const values = section.match(
    new RegExp(`^\\s*${escapedKey}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'm'),
  )?.[1];
  if (values === undefined) return null;
  return [...values.matchAll(/(["'])(.*?)\1/g)]
    .map((match) => match[2].trim())
    .filter(Boolean);
}

function readGrokInstalledPluginPaths(
  grokHome: string,
  enabled: ReadonlySet<string> | null,
  io: GrokPluginSearchIo,
): string[] {
  const parsed = readJson(join(grokHome, 'installed-plugins', 'registry.json'), io);
  if (!isRecord(parsed) || !isRecord(parsed.repos)) return [];
  const paths: string[] = [];
  for (const repo of Object.values(parsed.repos)) {
    if (!isRecord(repo) || typeof repo.path !== 'string' || !repo.path.trim()) continue;
    const pluginNames = isRecord(repo.plugins) ? Object.keys(repo.plugins) : [];
    if (enabled !== null && pluginNames.length > 0 && !pluginNames.some((name) => enabled.has(name))) {
      continue;
    }
    paths.push(repo.path);
  }
  return paths;
}

function readClaudeInstalledPluginPaths(
  claudeHome: string,
  io: GrokPluginSearchIo,
): string[] {
  const parsed = readJson(join(claudeHome, 'plugins', 'installed_plugins.json'), io);
  const paths = new Set<string>();
  const pending: unknown[] = [parsed];
  let remaining = 10_000;
  while (pending.length > 0 && remaining > 0) {
    --remaining;
    const value = pending.pop();
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    if (!isRecord(value)) continue;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'installPath' && typeof child === 'string' && child.trim()) {
        paths.add(child);
      } else {
        pending.push(child);
      }
    }
  }
  return [...paths];
}

function listDirectClaudePluginPaths(
  claudeHome: string,
  io: GrokPluginSearchIo,
): string[] {
  return io.listDirectories(join(claudeHome, 'plugins')).filter((path) => {
    const name = path.split(/[\\/]/).at(-1) ?? '';
    return !CLAUDE_PLUGIN_CONTAINER_DIRS.has(name);
  });
}

function readJson(path: string, io: GrokPluginSearchIo): unknown {
  const text = io.readText(path);
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
