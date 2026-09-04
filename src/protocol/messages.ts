import {
  AgentDeckCapability,
  AgentDeckClientErrorCode,
  DeploymentTopology,
  getTopologyDescriptor,
  assertRemoteOwnerGrantClaim,
  assertRemoteOwnerGrantForSurface,
  type AccessContext,
  type AgentDeckCapability as Capability,
  type AgentDeckClientErrorCode as ClientErrorCode,
  type AgentDeckEventEnvelope,
  type ClientHello,
  type HostHello,
  type JsonObject,
  type JsonValue,
} from '@contracts/index';
import { isJsonObject } from '@contracts/json';

export interface ClientHelloMessage {
  type: 'hello';
  requestId: string;
  hello: ClientHello;
}

export interface HostHelloMessage {
  type: 'hello-result';
  requestId: string;
  hello: HostHello;
}

export interface ProtocolRequestMessage {
  type: 'request';
  requestId: string;
  method: string;
  params: JsonObject;
  idempotencyKey: string | null;
  expectedRevision: number | null;
  deadlineAt: number | null;
}

export interface ProtocolResultMessage {
  type: 'result';
  requestId: string;
  result: JsonValue;
  revision: number;
}

export interface ProtocolErrorBody {
  code: ClientErrorCode;
  message: string;
  retryable: boolean;
  currentRevision: number | null;
  details: JsonValue;
}

export interface ProtocolErrorMessage {
  type: 'error';
  requestId: string;
  error: ProtocolErrorBody;
}

export interface ProtocolSubscribeMessage {
  type: 'subscribe';
  requestId: string;
  afterRevision: number;
}

export interface ProtocolEventMessage extends AgentDeckEventEnvelope {
  type: 'event';
}

export interface ProtocolCancelMessage {
  type: 'cancel';
  requestId: string;
  targetRequestId: string;
}

export interface ProtocolPingMessage {
  type: 'ping';
  nonce: string;
}

export interface ProtocolPongMessage {
  type: 'pong';
  nonce: string;
}

export type ProtocolMessage =
  | ClientHelloMessage
  | HostHelloMessage
  | ProtocolCancelMessage
  | ProtocolErrorMessage
  | ProtocolEventMessage
  | ProtocolPingMessage
  | ProtocolPongMessage
  | ProtocolRequestMessage
  | ProtocolResultMessage
  | ProtocolSubscribeMessage;

export type HostProtocolMessage =
  | HostHelloMessage
  | ProtocolErrorMessage
  | ProtocolEventMessage
  | ProtocolPingMessage
  | ProtocolPongMessage
  | ProtocolResultMessage;

export type ProtocolMessageType = ProtocolMessage['type'];

export class ProtocolMessageError extends Error {
  readonly code = 'invalid_request' as const;

  constructor(message: string) {
    super(message);
    this.name = 'ProtocolMessageError';
  }
}

const MESSAGE_TYPES = new Set<ProtocolMessageType>([
  'cancel',
  'error',
  'event',
  'hello',
  'hello-result',
  'ping',
  'pong',
  'request',
  'result',
  'subscribe',
]);

const CLIENT_ERROR_CODES = new Set<ClientErrorCode>(Object.values(AgentDeckClientErrorCode));
const CAPABILITIES = new Set(Object.values(AgentDeckCapability));
const TOPOLOGIES = new Set(Object.values(DeploymentTopology));

function requireString(object: JsonObject, key: string): string {
  const value = object[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ProtocolMessageError(`${key} must be a non-empty string`);
  }
  return value;
}

function requireNonNegativeInteger(object: JsonObject, key: string): number {
  const value = object[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ProtocolMessageError(`${key} must be a non-negative safe integer`);
  }
  return value;
}

function requireBoolean(object: JsonObject, key: string): boolean {
  const value = object[key];
  if (typeof value !== 'boolean') {
    throw new ProtocolMessageError(`${key} must be a boolean`);
  }
  return value;
}

function requireNullableString(object: JsonObject, key: string): string | null {
  const value = object[key];
  if (value !== null && (typeof value !== 'string' || value.length === 0)) {
    throw new ProtocolMessageError(`${key} must be null or a non-empty string`);
  }
  return value;
}

function requireNullableNonNegativeInteger(object: JsonObject, key: string): number | null {
  const value = object[key];
  if (value === null) return null;
  return requireNonNegativeInteger(object, key);
}

function requireObject(object: JsonObject, key: string): JsonObject {
  const value = object[key];
  if (!isJsonObject(value)) {
    throw new ProtocolMessageError(`${key} must be a JSON object`);
  }
  return value;
}

function assertExactKeys(
  value: JsonObject,
  required: readonly string[],
  optional: readonly string[] = [],
  field = 'Protocol object',
): void {
  const expected = new Set([
    ...required,
    ...optional.filter((key) => Object.prototype.hasOwnProperty.call(value, key)),
  ]);
  if (
    Object.keys(value).length !== expected.size ||
    Object.keys(value).some((key) => !expected.has(key)) ||
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new ProtocolMessageError(`${field} fields do not match the current protocol`);
  }
}

function assertProtocolVersion(value: JsonValue, field: string): void {
  if (!isJsonObject(value)) {
    throw new ProtocolMessageError(`${field} must be a JSON object`);
  }
  assertExactKeys(value, ['major', 'minor'], [], field);
  requireNonNegativeInteger(value, 'major');
  requireNonNegativeInteger(value, 'minor');
}

export function assertClientHello(value: unknown): asserts value is ClientHello {
  if (!isJsonObject(value)) {
    throw new ProtocolMessageError('hello must be a JSON object');
  }
  assertExactKeys(
    value,
    ['appVersion', 'clientId', 'protocolVersion', 'requestedTopology'],
    ['lastEventRevision'],
    'Client hello',
  );
  assertProtocolVersion(value.protocolVersion, 'protocolVersion');
  requireString(value, 'appVersion');
  requireString(value, 'clientId');
  const topology = requireString(value, 'requestedTopology');
  if (!TOPOLOGIES.has(topology as DeploymentTopology)) {
    throw new ProtocolMessageError(`Unknown requested topology: ${topology}`);
  }
  if (value.lastEventRevision !== undefined) {
    requireNonNegativeInteger(value, 'lastEventRevision');
  }
}

function assertAccessContext(value: JsonValue, topology: DeploymentTopology, instanceId: string): void {
  if (!isJsonObject(value)) {
    throw new ProtocolMessageError('access must be a JSON object');
  }
  const kind = requireString(value, 'kind') as AccessContext['kind'];
  if (value.topology !== topology || value.instanceId !== instanceId) {
    throw new ProtocolMessageError('access topology and instanceId must match the host');
  }
  requireString(value, 'clientId');

  if (kind === 'standalone') {
    assertExactKeys(value, [
      'accessCredentialId', 'authority', 'clientId', 'instanceId', 'kind', 'surface',
      'topology', 'transport',
    ], [], 'Standalone access context');
    if (
      topology !== DeploymentTopology.Standalone ||
      value.transport !== 'local-ipc' ||
      value.accessCredentialId !== null ||
      value.authority !== 'local-owner' ||
      value.surface !== 'desktop'
    ) {
      throw new ProtocolMessageError('Invalid standalone access context');
    }
    return;
  }

  if (kind === 'authenticated-client') {
    assertExactKeys(value, [
      'authority', 'clientId', 'connectionScope', 'grant', 'instanceId', 'kind', 'surface',
      'topology', 'transport',
    ], [], 'Authenticated client access context');
    requireString(value, 'connectionScope');
    const validSsh = value.transport === 'ssh' && value.surface === 'desktop';
    const validFeishu =
      value.transport === 'feishu' && value.surface === 'feishu';
    if (
      topology === DeploymentTopology.Standalone ||
      value.authority !== 'owner-equivalent' ||
      (!validSsh && !validFeishu)
    ) {
      throw new ProtocolMessageError('Invalid authenticated client access context');
    }
    try {
      assertRemoteOwnerGrantClaim(value.grant);
      assertRemoteOwnerGrantForSurface(
        value.grant,
        value.surface as 'desktop' | 'feishu',
      );
    } catch {
      throw new ProtocolMessageError('Invalid authenticated client grant claim');
    }
    return;
  }

  requireString(value, 'accessCredentialId');
  assertExactKeys(value, [
    'accessCredentialId', 'authority', 'clientId', 'credentialKind', 'generation', 'instanceId',
    'kind', 'surface', 'topology', 'transport', 'workerId',
  ], [], 'Relay Worker access context');
  if (
    kind !== 'relay-worker' ||
    topology !== DeploymentTopology.Relay ||
    value.transport !== 'ssh' ||
    value.credentialKind !== 'relay-worker' ||
    value.authority !== 'worker-attach-only' ||
    value.surface !== 'relay-worker'
  ) {
    throw new ProtocolMessageError('Invalid Relay Worker access context');
  }
  requireString(value, 'workerId');
  requireNonNegativeInteger(value, 'generation');
}

export function assertHostHello(value: unknown): asserts value is HostHello {
  if (!isJsonObject(value)) {
    throw new ProtocolMessageError('hello must be a JSON object');
  }
  assertExactKeys(value, [
    'access', 'appVersion', 'authoritativeCore', 'capabilities', 'eventRevision', 'instanceId',
    'limits', 'protocolVersion', 'topology',
  ], [], 'Host hello');
  assertProtocolVersion(value.protocolVersion, 'protocolVersion');
  requireString(value, 'appVersion');
  const topologyValue = requireString(value, 'topology');
  if (!TOPOLOGIES.has(topologyValue as DeploymentTopology)) {
    throw new ProtocolMessageError(`Unknown host topology: ${topologyValue}`);
  }
  const topology = topologyValue as DeploymentTopology;
  const instanceId = requireString(value, 'instanceId');
  if (topology === DeploymentTopology.Standalone && instanceId !== 'local') {
    throw new ProtocolMessageError('Standalone instanceId must be local');
  }

  const authoritativeCore = requireObject(value, 'authoritativeCore');
  assertExactKeys(
    authoritativeCore,
    ['generation', 'id', 'location'],
    [],
    'Authoritative Core',
  );
  requireString(authoritativeCore, 'id');
  const expectedLocation = getTopologyDescriptor(topology).authoritativeCoreLocation;
  if (authoritativeCore.location !== expectedLocation) {
    throw new ProtocolMessageError(
      `authoritativeCore.location must be ${expectedLocation} for ${topology}`,
    );
  }
  const generation = requireNullableNonNegativeInteger(authoritativeCore, 'generation');
  if (
    (topology === DeploymentTopology.Relay && generation === null) ||
    (topology !== DeploymentTopology.Relay && generation !== null)
  ) {
    throw new ProtocolMessageError('authoritativeCore.generation must exist only for Relay');
  }
  assertAccessContext(value.access, topology, instanceId);

  if (!Array.isArray(value.capabilities)) {
    throw new ProtocolMessageError('capabilities must be an array');
  }
  for (const capability of value.capabilities) {
    if (typeof capability !== 'string' || !CAPABILITIES.has(capability as Capability)) {
      throw new ProtocolMessageError(`Unknown capability: ${String(capability)}`);
    }
  }

  const limits = requireObject(value, 'limits');
  assertExactKeys(limits, [
    'maxBlobBytes', 'maxConcurrentRequests', 'maxFrameBytes', 'maxQueuedEvents',
  ], [], 'Transport limits');
  for (const field of [
    'maxFrameBytes',
    'maxBlobBytes',
    'maxConcurrentRequests',
    'maxQueuedEvents',
  ]) {
    if (requireNonNegativeInteger(limits, field) === 0) {
      throw new ProtocolMessageError(`${field} must be greater than zero`);
    }
  }
  requireNonNegativeInteger(value, 'eventRevision');
}

function assertRequestMessage(value: JsonObject): void {
  assertExactKeys(value, [
    'deadlineAt', 'expectedRevision', 'idempotencyKey', 'method', 'params', 'requestId', 'type',
  ]);
  requireString(value, 'requestId');
  requireString(value, 'method');
  requireObject(value, 'params');
  requireNullableString(value, 'idempotencyKey');
  requireNullableNonNegativeInteger(value, 'expectedRevision');
  requireNullableNonNegativeInteger(value, 'deadlineAt');
}

function assertErrorMessage(value: JsonObject): void {
  assertExactKeys(value, ['error', 'requestId', 'type']);
  requireString(value, 'requestId');
  const error = requireObject(value, 'error');
  assertExactKeys(error, [
    'code', 'currentRevision', 'details', 'message', 'retryable',
  ], [], 'Protocol error');
  const code = requireString(error, 'code');
  if (!CLIENT_ERROR_CODES.has(code as ClientErrorCode)) {
    throw new ProtocolMessageError(`Unknown client error code: ${code}`);
  }
  requireString(error, 'message');
  requireBoolean(error, 'retryable');
  requireNullableNonNegativeInteger(error, 'currentRevision');
  if (!Object.prototype.hasOwnProperty.call(error, 'details')) {
    throw new ProtocolMessageError('details is required');
  }
}

/** Validates the exact current wire envelope before direction-specific dispatch. */
export function assertProtocolMessageEnvelope(value: unknown): asserts value is ProtocolMessage {
  if (!isJsonObject(value)) {
    throw new ProtocolMessageError('Protocol message must be a JSON object');
  }
  const type = requireString(value, 'type');
  if (!MESSAGE_TYPES.has(type as ProtocolMessageType)) {
    throw new ProtocolMessageError(`Unknown protocol message type: ${type}`);
  }

  switch (type as ProtocolMessageType) {
    case 'hello':
      assertExactKeys(value, ['hello', 'requestId', 'type']);
      requireString(value, 'requestId');
      assertClientHello(value.hello);
      return;
    case 'hello-result':
      assertExactKeys(value, ['hello', 'requestId', 'type']);
      requireString(value, 'requestId');
      assertHostHello(value.hello);
      return;
    case 'request':
      assertRequestMessage(value);
      return;
    case 'result':
      assertExactKeys(value, ['requestId', 'result', 'revision', 'type']);
      requireString(value, 'requestId');
      requireNonNegativeInteger(value, 'revision');
      if (!Object.prototype.hasOwnProperty.call(value, 'result')) {
        throw new ProtocolMessageError('result is required');
      }
      return;
    case 'error':
      assertErrorMessage(value);
      return;
    case 'subscribe':
      assertExactKeys(value, ['afterRevision', 'requestId', 'type']);
      requireString(value, 'requestId');
      requireNonNegativeInteger(value, 'afterRevision');
      return;
    case 'event':
      assertExactKeys(value, [
        'entityId', 'instanceId', 'kind', 'payload', 'revision', 'type',
      ]);
      requireString(value, 'instanceId');
      requireString(value, 'kind');
      requireNonNegativeInteger(value, 'revision');
      requireNullableString(value, 'entityId');
      if (!Object.prototype.hasOwnProperty.call(value, 'payload')) {
        throw new ProtocolMessageError('payload is required');
      }
      return;
    case 'cancel':
      assertExactKeys(value, ['requestId', 'targetRequestId', 'type']);
      requireString(value, 'requestId');
      requireString(value, 'targetRequestId');
      return;
    case 'ping':
    case 'pong':
      assertExactKeys(value, ['nonce', 'type']);
      requireString(value, 'nonce');
      return;
  }
}

/** Parses an inbound envelope without rewriting retired protocol shapes. */
export function parseProtocolMessageEnvelope(value: unknown): ProtocolMessage {
  assertProtocolMessageEnvelope(value);
  return value;
}
