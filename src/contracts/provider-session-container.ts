import type { JsonObject } from './json';
import type { SessionConsoleSandboxAccess } from './session-console-capabilities';
import { parseWorkspaceDirectoryRef, SessionConsoleContractError } from './session-console-common';

export const PROVIDER_SESSION_CONTAINER_SCHEMA_VERSION = 2;
export const PROVIDER_INFERENCE_BROKER_SCHEMA_VERSION = 1;
export const PROVIDER_INFERENCE_MAX_REQUEST_BYTES = 4 * 1024 * 1024;
export const PROVIDER_INFERENCE_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
export const PROVIDER_INFERENCE_MIN_DEADLINE_MS = 1_000;
export const PROVIDER_INFERENCE_MAX_DEADLINE_MS = 120_000;
export const PROVIDER_INFERENCE_MAX_JSON_DEPTH = 32;
export const PROVIDER_INFERENCE_MAX_JSON_NODES = 65_536;

export const PROVIDER_SESSION_ADAPTER_IDS = Object.freeze([
  'claude-code',
  'codex-cli',
  'grok-build',
] as const);

export const PROVIDER_SESSION_RUNTIME_IDS = Object.freeze([
  'claude-code-v1',
  'codex-cli-v1',
  'grok-build-v1',
] as const);

export type ProviderSessionAdapterId = (typeof PROVIDER_SESSION_ADAPTER_IDS)[number];
export type ProviderSessionRuntimeId = (typeof PROVIDER_SESSION_RUNTIME_IDS)[number];

export interface ProviderSessionBrowserContext {
  readonly protocolVersion: 1;
  readonly adapterId: ProviderSessionAdapterId;
  readonly lease: string;
  readonly runtimeGeneration: number;
  readonly sourceIdentity: string;
}

export interface ProviderSessionLaunchSpec {
  readonly schemaVersion: typeof PROVIDER_SESSION_CONTAINER_SCHEMA_VERSION;
  readonly adapterId: ProviderSessionAdapterId;
  readonly brokerEndpointId: string;
  readonly effectiveAccess: SessionConsoleSandboxAccess;
  readonly launchId: string;
  readonly processId: string;
  readonly providerId: string;
  readonly projectTrusted: boolean;
  readonly resourceClass: 'interactive-v1';
  readonly runtimeId: ProviderSessionRuntimeId;
  readonly sessionId: string;
  readonly upstreamId: string;
  readonly workingDirectory: string;
  readonly browserContext?: ProviderSessionBrowserContext;
}

export interface ProviderSessionLaunchResult {
  readonly schemaVersion: typeof PROVIDER_SESSION_CONTAINER_SCHEMA_VERSION;
  readonly launchId: string;
  readonly processId: string;
  readonly runtimeHandle: string;
  readonly sessionId: string;
}

export interface ProviderSessionAttachSpec {
  readonly schemaVersion: typeof PROVIDER_SESSION_CONTAINER_SCHEMA_VERSION;
  readonly processId: string;
  readonly runtimeHandle: string;
  readonly sessionId: string;
}

export interface ProviderSessionAttachResult extends ProviderSessionAttachSpec {
  readonly attached: true;
}

export interface ProviderSessionStopSpec {
  readonly schemaVersion: typeof PROVIDER_SESSION_CONTAINER_SCHEMA_VERSION;
  readonly processId: string;
  readonly runtimeHandle: string;
  readonly sessionId: string;
}

export interface ProviderSessionStopResult extends ProviderSessionStopSpec {
  readonly stopped: true;
}

export interface ProviderSessionSupervisorCapabilities {
  readonly schemaVersion: typeof PROVIDER_SESSION_CONTAINER_SCHEMA_VERSION;
  readonly adapterIds: ProviderSessionAdapterId[];
  readonly available: boolean;
  readonly disabledReason: string | null;
  readonly generation: number;
}

export interface ProviderInferenceBrokerRequest {
  readonly schemaVersion: typeof PROVIDER_INFERENCE_BROKER_SCHEMA_VERSION;
  readonly body: JsonObject;
  readonly deadlineMs: number;
  readonly method: 'POST';
  /** An upstream HTTP path, never a filesystem path or full URL. */
  readonly path: string;
  readonly requestId: string;
}

export interface ProviderInferenceBrokerResponse {
  readonly schemaVersion: typeof PROVIDER_INFERENCE_BROKER_SCHEMA_VERSION;
  readonly body: string;
  readonly contentType: 'application/json' | 'text/event-stream';
  readonly requestId: string;
  readonly statusCode: number;
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const UPSTREAM_SEGMENT = /^[A-Za-z0-9._~-]+$/;
const MAX_REASON_BYTES = 1_024;
const encoder = new TextEncoder();

function fail(field: string): never {
  throw new SessionConsoleContractError(field);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(field);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(field);
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  field: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(field);
  }
}

function bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function token(value: unknown, field: string): string {
  if (typeof value !== 'string' || bytes(value) > 160 || !TOKEN.test(value)) fail(field);
  return value;
}

function browserContext(
  value: unknown,
  expectedAdapter: ProviderSessionAdapterId,
  field: string,
): ProviderSessionBrowserContext {
  const raw = object(value, field);
  exactKeys(raw, [
    'adapterId', 'lease', 'protocolVersion', 'runtimeGeneration', 'sourceIdentity',
  ], field);
  if (raw.protocolVersion !== 1 || raw.adapterId !== expectedAdapter) fail(field);
  if (typeof raw.lease !== 'string' || raw.lease.length < 16 || raw.lease.length > 1_024 ||
      !/^[A-Za-z0-9_-]+$/.test(raw.lease)) fail(`${field}.lease`);
  return Object.freeze({
    protocolVersion: 1,
    adapterId: expectedAdapter,
    lease: raw.lease,
    runtimeGeneration: integer(raw.runtimeGeneration, `${field}.runtimeGeneration`, 0, 0xffff_ffff),
    sourceIdentity: token(raw.sourceIdentity, `${field}.sourceIdentity`),
  });
}

export function parseProviderSessionBrowserContext(
  value: unknown,
  expectedAdapter: ProviderSessionAdapterId,
): ProviderSessionBrowserContext {
  return browserContext(value, expectedAdapter, 'provider.session.browserContext');
}

function integer(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail(field);
  }
  return value as number;
}

function adapterId(value: unknown, field: string): ProviderSessionAdapterId {
  if (!PROVIDER_SESSION_ADAPTER_IDS.includes(value as ProviderSessionAdapterId)) fail(field);
  return value as ProviderSessionAdapterId;
}

function runtimeId(value: unknown, field: string): ProviderSessionRuntimeId {
  if (!PROVIDER_SESSION_RUNTIME_IDS.includes(value as ProviderSessionRuntimeId)) fail(field);
  return value as ProviderSessionRuntimeId;
}

function expectedRuntime(adapter: ProviderSessionAdapterId): ProviderSessionRuntimeId {
  return `${adapter}-v1` as ProviderSessionRuntimeId;
}

function effectiveAccess(value: unknown, field: string): SessionConsoleSandboxAccess {
  if (![
    'provider-strict',
    'selected-directory-read-write',
    'workspace-read-only',
    'workspace-read-write',
  ].includes(value as string)) fail(field);
  return value as SessionConsoleSandboxAccess;
}

function upstreamPath(value: unknown, field: string): string {
  if (typeof value !== 'string' || bytes(value) > 512 || !value.startsWith('/')) fail(field);
  const segments = value.slice(1).split('/');
  if (
    segments.length === 0 || segments.some((segment) =>
      segment.length === 0 || segment === '.' || segment === '..' || !UPSTREAM_SEGMENT.test(segment))
  ) fail(field);
  return value;
}

function boundedJsonObject(value: unknown, field: string): JsonObject {
  const root = object(value, field);
  const stack: Array<{ readonly value: unknown; readonly depth: number }> = [
    { value: root, depth: 1 },
  ];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > PROVIDER_INFERENCE_MAX_JSON_NODES ||
        current.depth > PROVIDER_INFERENCE_MAX_JSON_DEPTH) fail(field);
    if (current.value === null || typeof current.value === 'boolean' ||
        typeof current.value === 'string') continue;
    if (typeof current.value === 'number') {
      if (!Number.isFinite(current.value)) fail(field);
      continue;
    }
    if (Array.isArray(current.value)) {
      for (const nested of current.value) {
        stack.push({ value: nested, depth: current.depth + 1 });
      }
      continue;
    }
    const nested = object(current.value, field);
    for (const item of Object.values(nested)) {
      stack.push({ value: item, depth: current.depth + 1 });
    }
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(root);
  } catch {
    return fail(field);
  }
  if (bytes(encoded) > PROVIDER_INFERENCE_MAX_REQUEST_BYTES) fail(field);
  return root as JsonObject;
}

export function parseProviderSessionLaunchSpec(value: unknown): ProviderSessionLaunchSpec {
  const field = 'provider.session.launch';
  const raw = object(value, field);
  const keys = [
    'adapterId', 'brokerEndpointId', 'effectiveAccess', 'launchId', 'processId',
    'projectTrusted', 'providerId', 'resourceClass', 'runtimeId', 'schemaVersion', 'sessionId',
    'upstreamId', 'workingDirectory',
  ];
  if (raw.browserContext !== undefined) keys.push('browserContext');
  exactKeys(raw, keys, field);
  if (raw.schemaVersion !== PROVIDER_SESSION_CONTAINER_SCHEMA_VERSION) {
    fail(`${field}.schemaVersion`);
  }
  const parsedAdapter = adapterId(raw.adapterId, `${field}.adapterId`);
  const parsedRuntime = runtimeId(raw.runtimeId, `${field}.runtimeId`);
  if (parsedRuntime !== expectedRuntime(parsedAdapter)) fail(`${field}.runtimeId`);
  if (raw.resourceClass !== 'interactive-v1') fail(`${field}.resourceClass`);
  if (typeof raw.projectTrusted !== 'boolean') fail(`${field}.projectTrusted`);
  return Object.freeze({
    schemaVersion: PROVIDER_SESSION_CONTAINER_SCHEMA_VERSION,
    adapterId: parsedAdapter,
    brokerEndpointId: token(raw.brokerEndpointId, `${field}.brokerEndpointId`),
    effectiveAccess: effectiveAccess(raw.effectiveAccess, `${field}.effectiveAccess`),
    launchId: token(raw.launchId, `${field}.launchId`),
    processId: token(raw.processId, `${field}.processId`),
    projectTrusted: raw.projectTrusted,
    providerId: token(raw.providerId, `${field}.providerId`),
    resourceClass: 'interactive-v1',
    runtimeId: parsedRuntime,
    sessionId: token(raw.sessionId, `${field}.sessionId`),
    upstreamId: token(raw.upstreamId, `${field}.upstreamId`),
    workingDirectory: parseWorkspaceDirectoryRef(
      raw.workingDirectory,
      `${field}.workingDirectory`,
    ),
    ...(raw.browserContext === undefined
      ? {}
      : { browserContext: browserContext(raw.browserContext, parsedAdapter, `${field}.browserContext`) }),
  });
}

export function parseProviderSessionLaunchResult(value: unknown): ProviderSessionLaunchResult {
  const field = 'provider.session.launch.result';
  const raw = object(value, field);
  exactKeys(raw, ['launchId', 'processId', 'runtimeHandle', 'schemaVersion', 'sessionId'], field);
  if (raw.schemaVersion !== PROVIDER_SESSION_CONTAINER_SCHEMA_VERSION) {
    fail(`${field}.schemaVersion`);
  }
  return Object.freeze({
    schemaVersion: PROVIDER_SESSION_CONTAINER_SCHEMA_VERSION,
    launchId: token(raw.launchId, `${field}.launchId`),
    processId: token(raw.processId, `${field}.processId`),
    runtimeHandle: token(raw.runtimeHandle, `${field}.runtimeHandle`),
    sessionId: token(raw.sessionId, `${field}.sessionId`),
  });
}

export function parseProviderSessionAttachSpec(value: unknown): ProviderSessionAttachSpec {
  const field = 'provider.session.attach';
  const raw = object(value, field);
  exactKeys(raw, ['processId', 'runtimeHandle', 'schemaVersion', 'sessionId'], field);
  if (raw.schemaVersion !== PROVIDER_SESSION_CONTAINER_SCHEMA_VERSION) {
    fail(`${field}.schemaVersion`);
  }
  return Object.freeze({
    schemaVersion: PROVIDER_SESSION_CONTAINER_SCHEMA_VERSION,
    processId: token(raw.processId, `${field}.processId`),
    runtimeHandle: token(raw.runtimeHandle, `${field}.runtimeHandle`),
    sessionId: token(raw.sessionId, `${field}.sessionId`),
  });
}

export function parseProviderSessionAttachResult(value: unknown): ProviderSessionAttachResult {
  const field = 'provider.session.attach.result';
  const raw = object(value, field);
  exactKeys(raw, ['attached', 'processId', 'runtimeHandle', 'schemaVersion', 'sessionId'], field);
  if (raw.attached !== true) fail(`${field}.attached`);
  return Object.freeze({ ...parseProviderSessionAttachSpec({
    processId: raw.processId,
    runtimeHandle: raw.runtimeHandle,
    schemaVersion: raw.schemaVersion,
    sessionId: raw.sessionId,
  }), attached: true });
}

export function parseProviderSessionStopSpec(value: unknown): ProviderSessionStopSpec {
  const field = 'provider.session.stop';
  const raw = object(value, field);
  exactKeys(raw, ['processId', 'runtimeHandle', 'schemaVersion', 'sessionId'], field);
  if (raw.schemaVersion !== PROVIDER_SESSION_CONTAINER_SCHEMA_VERSION) {
    fail(`${field}.schemaVersion`);
  }
  return Object.freeze({
    schemaVersion: PROVIDER_SESSION_CONTAINER_SCHEMA_VERSION,
    processId: token(raw.processId, `${field}.processId`),
    runtimeHandle: token(raw.runtimeHandle, `${field}.runtimeHandle`),
    sessionId: token(raw.sessionId, `${field}.sessionId`),
  });
}

export function parseProviderSessionStopResult(value: unknown): ProviderSessionStopResult {
  const field = 'provider.session.stop.result';
  const raw = object(value, field);
  exactKeys(raw, ['processId', 'runtimeHandle', 'schemaVersion', 'sessionId', 'stopped'], field);
  if (raw.stopped !== true) fail(`${field}.stopped`);
  return Object.freeze({ ...parseProviderSessionStopSpec({
    processId: raw.processId,
    runtimeHandle: raw.runtimeHandle,
    schemaVersion: raw.schemaVersion,
    sessionId: raw.sessionId,
  }), stopped: true });
}

export function parseProviderSessionSupervisorCapabilities(
  value: unknown,
): ProviderSessionSupervisorCapabilities {
  const field = 'provider.session.capabilities';
  const raw = object(value, field);
  exactKeys(raw, ['adapterIds', 'available', 'disabledReason', 'generation', 'schemaVersion'], field);
  if (raw.schemaVersion !== PROVIDER_SESSION_CONTAINER_SCHEMA_VERSION ||
      typeof raw.available !== 'boolean' || !Array.isArray(raw.adapterIds)) fail(field);
  const adapterIds = raw.adapterIds.map((item, index) =>
    adapterId(item, `${field}.adapterIds[${index}]`));
  if (new Set(adapterIds).size !== adapterIds.length) fail(`${field}.adapterIds`);
  const reason = raw.disabledReason;
  if (raw.available) {
    if (reason !== null || adapterIds.length === 0) fail(field);
  } else if (
    typeof reason !== 'string' || reason.trim() !== reason || reason.length === 0 ||
    CONTROL.test(reason) || bytes(reason) > MAX_REASON_BYTES || adapterIds.length !== 0
  ) fail(field);
  return Object.freeze({
    schemaVersion: PROVIDER_SESSION_CONTAINER_SCHEMA_VERSION,
    adapterIds,
    available: raw.available,
    disabledReason: reason as string | null,
    generation: integer(raw.generation, `${field}.generation`, 0, Number.MAX_SAFE_INTEGER),
  });
}

export function parseProviderInferenceBrokerRequest(
  value: unknown,
): ProviderInferenceBrokerRequest {
  const field = 'provider.inference.request';
  const raw = object(value, field);
  exactKeys(raw, ['body', 'deadlineMs', 'method', 'path', 'requestId', 'schemaVersion'], field);
  if (raw.schemaVersion !== PROVIDER_INFERENCE_BROKER_SCHEMA_VERSION) {
    fail(`${field}.schemaVersion`);
  }
  if (raw.method !== 'POST') fail(`${field}.method`);
  return Object.freeze({
    schemaVersion: PROVIDER_INFERENCE_BROKER_SCHEMA_VERSION,
    body: boundedJsonObject(raw.body, `${field}.body`),
    deadlineMs: integer(
      raw.deadlineMs,
      `${field}.deadlineMs`,
      PROVIDER_INFERENCE_MIN_DEADLINE_MS,
      PROVIDER_INFERENCE_MAX_DEADLINE_MS,
    ),
    method: 'POST',
    path: upstreamPath(raw.path, `${field}.path`),
    requestId: token(raw.requestId, `${field}.requestId`),
  });
}

export function parseProviderInferenceBrokerResponse(
  value: unknown,
): ProviderInferenceBrokerResponse {
  const field = 'provider.inference.response';
  const raw = object(value, field);
  exactKeys(raw, ['body', 'contentType', 'requestId', 'schemaVersion', 'statusCode'], field);
  if (raw.schemaVersion !== PROVIDER_INFERENCE_BROKER_SCHEMA_VERSION) {
    fail(`${field}.schemaVersion`);
  }
  if (raw.contentType !== 'application/json' && raw.contentType !== 'text/event-stream') {
    fail(`${field}.contentType`);
  }
  if (typeof raw.body !== 'string' || bytes(raw.body) > PROVIDER_INFERENCE_MAX_RESPONSE_BYTES) {
    fail(`${field}.body`);
  }
  return Object.freeze({
    schemaVersion: PROVIDER_INFERENCE_BROKER_SCHEMA_VERSION,
    body: raw.body,
    contentType: raw.contentType,
    requestId: token(raw.requestId, `${field}.requestId`),
    statusCode: integer(raw.statusCode, `${field}.statusCode`, 100, 599),
  });
}
