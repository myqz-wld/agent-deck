import { SessionConsoleContractError } from './session-console-common';

export const NODE_ASSET_MAX_ITEMS = 512;
export const NODE_ASSET_MAX_CONTENT_BYTES = 512 * 1024;
export const NODE_ASSET_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;

export type NodeAssetAdapterId = 'claude-code' | 'codex-cli' | 'grok-build';
export type NodeAssetKind = 'agent' | 'skill';
export type NodeAssetSource = 'bundled';

export interface NodeAssetRuntimeDto {
  model: string | null;
  thinking: string | null;
  provider: string | null;
}

export interface NodeAssetDto {
  adapterId: NodeAssetAdapterId;
  kind: NodeAssetKind;
  source: NodeAssetSource;
  name: string;
  qualifiedName: string;
  description: string;
  location: string;
  tools: string | null;
  model: string | null;
  thinking: string | null;
  provider: string | null;
  origin: 'direct' | 'plugin' | null;
  pluginName: string | null;
  runtimeName: string | null;
  runtimeDefaults: NodeAssetRuntimeDto | null;
  runtimeOverride: NodeAssetRuntimeDto | null;
}

export interface NodeAssetInjectionSettingsDto {
  injectAgentDeckClaudeSkills: boolean;
  injectAgentDeckClaudeAgents: boolean;
  injectAgentDeckClaudeMd: boolean;
  injectAgentDeckCodexSkills: boolean;
  injectAgentDeckCodexAgents: boolean;
  injectAgentDeckCodexAgentsMd: boolean;
  injectAgentDeckGrokSkills: boolean;
  injectAgentDeckGrokAgents: boolean;
  injectAgentDeckGrokAgentsMd: boolean;
}

export interface NodeAssetListResult {
  assets: NodeAssetDto[];
  assetsTruncated: boolean;
  injection: NodeAssetInjectionSettingsDto;
  readOnlyReason: string;
  revision: number;
}

export interface NodeAssetContentParams {
  adapterId: NodeAssetAdapterId;
  kind: NodeAssetKind;
  source: NodeAssetSource;
  name: string;
  qualifiedName: string;
  location: string;
}

export interface NodeAssetContentResult {
  content: string;
  revision: number;
}

export interface NodeAssetConventionParams { adapterId: NodeAssetAdapterId }
export interface NodeAssetConventionResult {
  adapterId: NodeAssetAdapterId;
  content: string;
  isCustom: false;
  revision: number;
}

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/u;
const NATIVE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function fail(field: string): never { throw new SessionConsoleContractError(field); }
function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(field);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(field);
  return value as Record<string, unknown>;
}
function exact(raw: Record<string, unknown>, keys: readonly string[], field: string): void {
  const actual = Object.keys(raw).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(field);
  }
}
function bytes(value: string): number { return new TextEncoder().encode(value).byteLength; }
function text(value: unknown, field: string, maximum: number, nonempty = false): string {
  if (
    typeof value !== 'string' || (nonempty && value.trim().length === 0) ||
    CONTROL.test(value) || bytes(value) > maximum
  ) fail(field);
  return value;
}
function nullableText(value: unknown, field: string, maximum: number): string | null {
  return value === null ? null : text(value, field, maximum);
}
function revision(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(field);
  return value as number;
}
function bool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') fail(field);
  return value;
}
function bounded<T>(value: T, field: string): T {
  if (bytes(JSON.stringify(value)) > NODE_ASSET_RESPONSE_MAX_BYTES) fail(field);
  return value;
}

export function parseNodeAssetAdapterId(value: unknown): NodeAssetAdapterId {
  if (value !== 'claude-code' && value !== 'codex-cli' && value !== 'grok-build') {
    fail('node.assets.adapterId');
  }
  return value;
}

function kind(value: unknown, field: string): NodeAssetKind {
  if (value !== 'agent' && value !== 'skill') fail(field);
  return value;
}

function source(value: unknown, field: string): NodeAssetSource {
  if (value !== 'bundled') fail(field);
  return value;
}

function name(value: unknown, field: string): string {
  const parsed = text(value, field, 128, true);
  if (!NATIVE_NAME.test(parsed)) fail(field);
  return parsed;
}

function runtime(value: unknown, field: string): NodeAssetRuntimeDto | null {
  if (value === null) return null;
  const raw = object(value, field);
  exact(raw, ['model', 'provider', 'thinking'], field);
  return {
    model: nullableText(raw.model, `${field}.model`, 256),
    thinking: nullableText(raw.thinking, `${field}.thinking`, 128),
    provider: nullableText(raw.provider, `${field}.provider`, 256),
  };
}

function asset(value: unknown, field: string): NodeAssetDto {
  const raw = object(value, field);
  exact(raw, [
    'adapterId', 'description', 'kind', 'location', 'model', 'name', 'origin',
    'pluginName', 'provider', 'qualifiedName', 'runtimeDefaults', 'runtimeName',
    'runtimeOverride', 'source', 'thinking', 'tools',
  ], field);
  const origin = raw.origin;
  if (origin !== null && origin !== 'direct' && origin !== 'plugin') fail(`${field}.origin`);
  const runtimeDefaults = runtime(raw.runtimeDefaults, `${field}.runtimeDefaults`);
  const runtimeOverride = runtime(raw.runtimeOverride, `${field}.runtimeOverride`);
  const configurable = raw.source === 'bundled' && raw.kind === 'agent';
  if (
    (runtimeDefaults === null) !== (runtimeOverride === null) ||
    (configurable && runtimeDefaults === null) || (!configurable && runtimeDefaults !== null)
  ) fail(`${field}.runtime`);
  return {
    adapterId: parseNodeAssetAdapterId(raw.adapterId),
    kind: kind(raw.kind, `${field}.kind`),
    source: source(raw.source, `${field}.source`),
    name: name(raw.name, `${field}.name`),
    qualifiedName: text(raw.qualifiedName, `${field}.qualifiedName`, 512, true),
    description: text(raw.description, `${field}.description`, 4_096),
    location: text(raw.location, `${field}.location`, 1_024, true),
    tools: nullableText(raw.tools, `${field}.tools`, 4_096),
    model: nullableText(raw.model, `${field}.model`, 256),
    thinking: nullableText(raw.thinking, `${field}.thinking`, 128),
    provider: nullableText(raw.provider, `${field}.provider`, 256),
    origin,
    pluginName: nullableText(raw.pluginName, `${field}.pluginName`, 128),
    runtimeName: nullableText(raw.runtimeName, `${field}.runtimeName`, 256),
    runtimeDefaults,
    runtimeOverride,
  };
}

const INJECTION_KEYS = [
  'injectAgentDeckClaudeSkills',
  'injectAgentDeckClaudeAgents',
  'injectAgentDeckClaudeMd',
  'injectAgentDeckCodexSkills',
  'injectAgentDeckCodexAgents',
  'injectAgentDeckCodexAgentsMd',
  'injectAgentDeckGrokSkills',
  'injectAgentDeckGrokAgents',
  'injectAgentDeckGrokAgentsMd',
] as const satisfies readonly (keyof NodeAssetInjectionSettingsDto)[];

function injection(value: unknown): NodeAssetInjectionSettingsDto {
  const raw = object(value, 'node.assets.catalog.list.injection');
  exact(raw, INJECTION_KEYS, 'node.assets.catalog.list.injection');
  return Object.fromEntries(INJECTION_KEYS.map((key) => [
    key,
    bool(raw[key], `node.assets.catalog.list.injection.${key}`),
  ])) as unknown as NodeAssetInjectionSettingsDto;
}

export function parseNodeAssetListParams(value: unknown): Record<string, never> {
  const raw = object(value, 'node.assets.catalog.list.params');
  exact(raw, [], 'node.assets.catalog.list.params');
  return {};
}

export function parseNodeAssetListResult(value: unknown): NodeAssetListResult {
  const raw = object(value, 'node.assets.catalog.list.result');
  exact(
    raw,
    ['assets', 'assetsTruncated', 'injection', 'readOnlyReason', 'revision'],
    'node.assets.catalog.list.result',
  );
  if (!Array.isArray(raw.assets) || raw.assets.length > NODE_ASSET_MAX_ITEMS) {
    fail('node.assets.catalog.list.assets');
  }
  const assets = raw.assets.map((item, index) =>
    asset(item, `node.assets.catalog.list.assets[${index}]`));
  const identities = assets.map((item) =>
    `${item.adapterId}\u0000${item.kind}\u0000${item.source}\u0000` +
    `${item.qualifiedName}\u0000${item.location}`);
  if (new Set(identities).size !== identities.length) fail('node.assets.catalog.list.assets');
  return bounded({
    assets,
    assetsTruncated: bool(raw.assetsTruncated, 'node.assets.catalog.list.assetsTruncated'),
    injection: injection(raw.injection),
    readOnlyReason: text(
      raw.readOnlyReason,
      'node.assets.catalog.list.readOnlyReason',
      1_024,
      true,
    ),
    revision: revision(raw.revision, 'node.assets.catalog.list.revision'),
  }, 'node.assets.catalog.list.result');
}

export function parseNodeAssetContentParams(value: unknown): NodeAssetContentParams {
  const raw = object(value, 'node.assets.content.params');
  exact(
    raw,
    ['adapterId', 'kind', 'location', 'name', 'qualifiedName', 'source'],
    'node.assets.content.params',
  );
  return {
    adapterId: parseNodeAssetAdapterId(raw.adapterId),
    kind: kind(raw.kind, 'node.assets.content.kind'),
    source: source(raw.source, 'node.assets.content.source'),
    name: name(raw.name, 'node.assets.content.name'),
    qualifiedName: text(
      raw.qualifiedName,
      'node.assets.content.qualifiedName',
      512,
      true,
    ),
    location: text(raw.location, 'node.assets.content.location', 1_024, true),
  };
}

export function parseNodeAssetContentResult(value: unknown): NodeAssetContentResult {
  const raw = object(value, 'node.assets.content.result');
  exact(raw, ['content', 'revision'], 'node.assets.content.result');
  return {
    content: text(raw.content, 'node.assets.content.content', NODE_ASSET_MAX_CONTENT_BYTES),
    revision: revision(raw.revision, 'node.assets.content.revision'),
  };
}

export function parseNodeAssetConventionParams(value: unknown): NodeAssetConventionParams {
  const raw = object(value, 'node.assets.convention.params');
  exact(raw, ['adapterId'], 'node.assets.convention.params');
  return { adapterId: parseNodeAssetAdapterId(raw.adapterId) };
}

export function parseNodeAssetConventionResult(value: unknown): NodeAssetConventionResult {
  const raw = object(value, 'node.assets.convention.result');
  exact(raw, ['adapterId', 'content', 'isCustom', 'revision'], 'node.assets.convention.result');
  if (raw.isCustom !== false) fail('node.assets.convention.isCustom');
  return {
    adapterId: parseNodeAssetAdapterId(raw.adapterId),
    content: text(raw.content, 'node.assets.convention.content', NODE_ASSET_MAX_CONTENT_BYTES),
    isCustom: false,
    revision: revision(raw.revision, 'node.assets.convention.revision'),
  };
}
