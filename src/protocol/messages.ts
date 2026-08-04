import {
  AgentDeckCapability,
  AgentDeckClientErrorCode,
  DeploymentTopology,
  getTopologyDescriptor,
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

export type ClientProtocolMessage =
  | ClientHelloMessage
  | ProtocolCancelMessage
  | ProtocolPingMessage
  | ProtocolRequestMessage
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

function assertProtocolVersion(value: JsonValue, field: string): void {
  if (!isJsonObject(value)) {
    throw new ProtocolMessageError(`${field} must be a JSON object`);
  }
  requireNonNegativeInteger(value, 'major');
  requireNonNegativeInteger(value, 'minor');
}

export function assertClientHello(value: unknown): asserts value is ClientHello {
  if (!isJsonObject(value)) {
    throw new ProtocolMessageError('hello must be a JSON object');
  }
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
    if (
      topology !== DeploymentTopology.Standalone ||
      value.transport !== 'local-ipc' ||
      value.accessCredentialId !== null ||
      value.authority !== 'local-owner' ||
      value.surface !== 'desktop-full'
    ) {
      throw new ProtocolMessageError('Invalid standalone access context');
    }
    return;
  }

  requireString(value, 'accessCredentialId');
  if (kind === 'authenticated-client') {
    const validSsh = value.transport === 'ssh' && value.surface === 'desktop-full';
    const validFeishu =
      value.transport === 'feishu' && value.surface === 'feishu-session-console';
    if (
      topology === DeploymentTopology.Standalone ||
      value.authority !== 'owner-equivalent' ||
      (!validSsh && !validFeishu)
    ) {
      throw new ProtocolMessageError('Invalid authenticated client access context');
    }
    return;
  }

  if (
    kind !== 'relay-worker' ||
    topology !== DeploymentTopology.Relay ||
    value.transport !== 'ssh' ||
    value.credentialKind !== 'relay-worker' ||
    value.authority !== 'worker-attach-only' ||
    value.surface !== 'relay-worker-attach'
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
  requireString(value, 'requestId');
  requireString(value, 'method');
  requireObject(value, 'params');
  requireNullableString(value, 'idempotencyKey');
  requireNullableNonNegativeInteger(value, 'expectedRevision');
  requireNullableNonNegativeInteger(value, 'deadlineAt');
}

function assertErrorMessage(value: JsonObject): void {
  requireString(value, 'requestId');
  const error = requireObject(value, 'error');
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

/**
 * Validates the common wire envelope before a direction-specific schema handles its payload.
 * Additive fields remain allowed so compatible minor versions can evolve independently.
 */
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
      requireString(value, 'requestId');
      assertClientHello(value.hello);
      return;
    case 'hello-result':
      requireString(value, 'requestId');
      assertHostHello(value.hello);
      return;
    case 'request':
      assertRequestMessage(value);
      return;
    case 'result':
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
      requireString(value, 'requestId');
      requireNonNegativeInteger(value, 'afterRevision');
      return;
    case 'event':
      requireString(value, 'instanceId');
      requireString(value, 'kind');
      requireNonNegativeInteger(value, 'revision');
      requireNullableString(value, 'entityId');
      if (!Object.prototype.hasOwnProperty.call(value, 'payload')) {
        throw new ProtocolMessageError('payload is required');
      }
      return;
    case 'cancel':
      requireString(value, 'requestId');
      requireString(value, 'targetRequestId');
      return;
    case 'ping':
    case 'pong':
      requireString(value, 'nonce');
      return;
  }
}
