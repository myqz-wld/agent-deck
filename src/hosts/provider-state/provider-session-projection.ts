import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

import { SESSION_CONSOLE_MAX_OPTION_VALUES, type JsonObject } from '@contracts/index';
import {
  isClaudeThinkingLevel,
  isCodexThinkingLevel,
  isGrokThinkingLevel,
} from '@shared/session-metadata';
import { isCodexApprovalPolicy } from '@shared/types';

import {
  canonicalProviderDirectory,
  readOptionalProviderFile,
  removeProviderFile,
  writeProviderFile,
  type ProviderProjectionMode,
} from './provider-home-files';

export const PROVIDER_SESSION_CATALOG_FILE = '.agent-deck/session-create-catalog.json';
const CLAUDE_SETTINGS_FILE = '.claude/settings.json';
const CLAUDE_GATEWAYS_DIRECTORY = '.claude/gateways';
const CODEX_CONFIG_FILE = '.codex/config.toml';
const GROK_CONFIG_FILE = '.grok/config.toml';
const SAFE_PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SECRET_SHAPED = /(?:\b(?:AKIA|ASIA)[A-Z0-9]{12,}\b|\b(?:ghp_|github_pat_|sk-|xai-|gsk_|hf_)[A-Za-z0-9_-]{8,}\b)/u;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const PROVIDER_HEADER =
  /^\s*\[model_providers\.(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\]\s*(?:#.*)?$/u;
const TOP_LEVEL_CODEX_KEYS = new Set([
  'approval_policy',
  'model',
  'model_provider',
  'model_reasoning_effort',
]);
const BLOCKED_GATEWAY_ENV = new Set([
  'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GROK_HOME', 'HOME', 'PATH',
  'TEMP', 'TMP', 'TMPDIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME',
  'XDG_RUNTIME_DIR', 'XDG_STATE_HOME',
]);

interface SafeProviderProfile {
  readonly id: string;
  readonly model: string;
  readonly thinking: string;
}

function safeText(value: unknown, fallback: string, allowEmpty = false): string {
  if (typeof value !== 'string') return fallback;
  const parsed = value.trim();
  if (
    (!allowEmpty && !parsed) || Buffer.byteLength(parsed, 'utf8') > 512 ||
    CONTROL.test(parsed) || SECRET_SHAPED.test(parsed) || parsed.startsWith('/') ||
    parsed.startsWith('~') || /^[A-Za-z]:[\\/]/u.test(parsed)
  ) return fallback;
  return parsed;
}

function jsonObject(bytes: Buffer | null): Record<string, unknown> | null {
  if (!bytes) return null;
  try {
    const value = JSON.parse(bytes.toString('utf8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  } finally {
    bytes.fill(0);
  }
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  ));
}

function quotedTopLevel(content: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const assignment = new RegExp(
    `^${escaped}[ \\t]*=[ \\t]*("(?:[^"\\\\]|\\\\.)*"|'[^']*')`,
    'u',
  );
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) break;
    const match = assignment.exec(line);
    if (!match) continue;
    if (match[1].startsWith("'")) return match[1].slice(1, -1);
    try { return JSON.parse(match[1]) as string; } catch { return null; }
  }
  return null;
}

function decodeTomlKey(value: string): string {
  if (!value.includes('\\')) return value;
  try { return JSON.parse(`"${value}"`) as string; } catch { return ''; }
}

function codexProviderIds(content: string): string[] {
  const providers = new Set<string>();
  for (const line of content.split(/\r?\n/u)) {
    const match = PROVIDER_HEADER.exec(line);
    if (!match) continue;
    const id = decodeTomlKey(match[1] ?? match[2] ?? match[3] ?? '');
    if (SAFE_PROVIDER_ID.test(id)) providers.add(id);
  }
  const configured = safeText(quotedTopLevel(content, 'model_provider'), '', true);
  if (SAFE_PROVIDER_ID.test(configured)) providers.add(configured);
  return [...providers].sort((left, right) => {
    if (left === configured) return -1;
    if (right === configured) return 1;
    return left.localeCompare(right);
  }).slice(0, SESSION_CONSOLE_MAX_OPTION_VALUES);
}

function sanitizedCodexConfig(content: string): string {
  const output: string[] = [];
  let section: 'top' | 'provider' | 'drop' = 'top';
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.startsWith('[')) {
      section = /^\s*\[model_providers\./u.test(rawLine) ? 'provider' : 'drop';
      if (section === 'provider') output.push(rawLine);
      continue;
    }
    if (section === 'provider') {
      output.push(rawLine);
      continue;
    }
    if (section !== 'top' || !line || line.startsWith('#')) continue;
    const key = /^([A-Za-z0-9_-]+)\s*=/u.exec(line)?.[1];
    if (key && TOP_LEVEL_CODEX_KEYS.has(key)) output.push(rawLine);
  }
  return output.length > 0 ? `${output.join('\n')}\n` : '';
}

function gatewayDirectory(source: string): string[] {
  const directory = join(source, CLAUDE_GATEWAYS_DIRECTORY);
  const before = lstatSync(directory, { throwIfNoEntry: false });
  if (!before) return [];
  canonicalProviderDirectory(directory, 'Claude Gateway directory', false);
  const names = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .filter((name) => SAFE_PROVIDER_ID.test(name.slice(0, -'.json'.length)))
    .sort()
    .slice(0, SESSION_CONSOLE_MAX_OPTION_VALUES);
  const after = lstatSync(directory);
  if (
    realpathSync(directory) !== directory || before.dev !== after.dev || before.ino !== after.ino ||
    before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
  ) throw new Error('Claude Gateway directory changed while it was listed');
  return names;
}

function sanitizeGateway(value: Record<string, unknown>): JsonObject {
  const env = Object.fromEntries(Object.entries(stringRecord(value.env)).filter(
    ([key]) => !BLOCKED_GATEWAY_ENV.has(key),
  ));
  return {
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(typeof value.model === 'string' ? { model: value.model } : {}),
    ...(typeof value.effortLevel === 'string' ? { effortLevel: value.effortLevel } : {}),
  };
}

function syncGatewayFiles(
  source: string | null,
  destination: string,
  mode: ProviderProjectionMode,
): { readonly paths: string[]; readonly profiles: SafeProviderProfile[] } {
  const names = source ? gatewayDirectory(source) : [];
  const accepted = new Set<string>();
  const paths: string[] = [];
  const profiles: SafeProviderProfile[] = [];
  for (const name of names) {
    const relative = `${CLAUDE_GATEWAYS_DIRECTORY}/${name}`;
    const raw = jsonObject(readOptionalProviderFile(source!, relative));
    if (!raw) continue;
    const sanitized = sanitizeGateway(raw);
    const env = stringRecord(sanitized.env);
    const model = safeText(sanitized.model ?? env.ANTHROPIC_MODEL, 'sonnet');
    const thinking = isClaudeThinkingLevel(sanitized.effortLevel)
      ? sanitized.effortLevel
      : 'high';
    const bytes = Buffer.from(`${JSON.stringify(sanitized, null, 2)}\n`, 'utf8');
    try { writeProviderFile(destination, relative, bytes, mode); } finally { bytes.fill(0); }
    accepted.add(name);
    paths.push(relative);
    profiles.push(Object.freeze({ id: name.slice(0, -5), model, thinking }));
  }
  const destinationDirectory = join(destination, CLAUDE_GATEWAYS_DIRECTORY);
  if (lstatSync(destinationDirectory, { throwIfNoEntry: false })) {
    canonicalProviderDirectory(destinationDirectory, 'projected Gateway directory', true);
    for (const entry of readdirSync(destinationDirectory, { withFileTypes: true })) {
      if (!entry.name.endsWith('.json') || accepted.has(entry.name)) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error('projected Gateway directory contains an unsafe entry');
      }
      removeProviderFile(destination, `${CLAUDE_GATEWAYS_DIRECTORY}/${entry.name}`);
    }
  }
  return { paths, profiles };
}

function catalog(
  source: string,
  claudeProfiles: readonly SafeProviderProfile[],
  codexContent: string,
): JsonObject {
  const claudeSettings = jsonObject(readOptionalProviderFile(source, CLAUDE_SETTINGS_FILE));
  const claudeEnv = stringRecord(claudeSettings?.env);
  const claudeModel = safeText(
    claudeSettings?.model ?? claudeEnv.ANTHROPIC_MODEL,
    'sonnet',
  );
  const claudeThinking = isClaudeThinkingLevel(claudeSettings?.effortLevel)
    ? claudeSettings.effortLevel
    : 'high';
  const codexModel = safeText(quotedTopLevel(codexContent, 'model'), '', true);
  const codexThinkingValue = quotedTopLevel(codexContent, 'model_reasoning_effort');
  const codexThinking = isCodexThinkingLevel(codexThinkingValue)
    ? codexThinkingValue
    : 'high';
  const codexApprovalValue = quotedTopLevel(codexContent, 'approval_policy');
  const codexApproval = isCodexApprovalPolicy(codexApprovalValue)
    ? codexApprovalValue
    : 'never';
  const codexProviders = codexProviderIds(codexContent);
  const configuredCodexProvider = safeText(
    quotedTopLevel(codexContent, 'model_provider'),
    '',
    true,
  );
  const grokContent = (() => {
    const bytes = readOptionalProviderFile(source, GROK_CONFIG_FILE);
    if (!bytes) return '';
    try { return bytes.toString('utf8'); } finally { bytes.fill(0); }
  })();
  const grokModel = safeText(quotedTopLevel(grokContent, 'model'), 'grok-4.5');
  const grokThinkingValue = quotedTopLevel(grokContent, 'reasoning_effort');
  return {
    schemaVersion: 2,
    adapters: [
      {
        adapterId: 'claude-code',
        providers: claudeProfiles.map((profile) => ({ ...profile })),
        provider: '',
        model: claudeModel,
        thinking: claudeThinking,
        permissionMode: 'bypassPermissions',
      },
      {
        adapterId: 'codex-cli',
        providers: codexProviders.map((id) => ({ id, model: codexModel, thinking: codexThinking })),
        provider: codexProviders.includes(configuredCodexProvider) ? configuredCodexProvider : '',
        model: codexModel,
        thinking: codexThinking,
        approvalPolicy: codexApproval,
      },
      {
        adapterId: 'grok-build',
        providers: [],
        provider: '',
        model: grokModel,
        thinking: isGrokThinkingLevel(grokThinkingValue) ? grokThinkingValue : 'high',
        sessionMode: 'default',
      },
    ],
  };
}

export function projectProviderSessionFiles(
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
  const gateways = syncGatewayFiles(source, destination, mode);
  const codexBytes = readOptionalProviderFile(source, CODEX_CONFIG_FILE);
  const codexContent = (() => {
    if (!codexBytes) return '';
    try { return codexBytes.toString('utf8'); } finally { codexBytes.fill(0); }
  })();
  const sanitizedConfig = sanitizedCodexConfig(codexContent);
  const projected = [...gateways.paths];
  if (sanitizedConfig) {
    const bytes = Buffer.from(sanitizedConfig, 'utf8');
    try { writeProviderFile(destination, CODEX_CONFIG_FILE, bytes, mode); } finally { bytes.fill(0); }
    projected.push(CODEX_CONFIG_FILE);
  } else if (mode === 'replace') {
    removeProviderFile(destination, CODEX_CONFIG_FILE);
  }
  const catalogBytes = Buffer.from(
    `${JSON.stringify(catalog(source, gateways.profiles, codexContent), null, 2)}\n`,
    'utf8',
  );
  try {
    writeProviderFile(destination, PROVIDER_SESSION_CATALOG_FILE, catalogBytes, mode);
  } finally {
    catalogBytes.fill(0);
  }
  projected.push(PROVIDER_SESSION_CATALOG_FILE);
  return Object.freeze(projected);
}

export function syncProviderSessionFiles(
  sourceHome: string | null,
  destinationHome: string,
): readonly string[] {
  if (sourceHome !== null) {
    return projectProviderSessionFiles(sourceHome, destinationHome, 'replace');
  }
  const destination = canonicalProviderDirectory(
    destinationHome,
    'provider destination home',
    true,
  );
  syncGatewayFiles(null, destination, 'replace');
  removeProviderFile(destination, CODEX_CONFIG_FILE);
  removeProviderFile(destination, PROVIDER_SESSION_CATALOG_FILE);
  return Object.freeze([]);
}
