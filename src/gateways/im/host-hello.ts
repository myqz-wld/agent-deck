import {
  AccessSurface,
  AgentDeckCapability,
  copyRemoteOwnerGrantClaim,
  type HostHello,
} from '@contracts/index';
import { assertHostHello } from '@protocol/messages';
import { negotiateProtocolVersion } from '@protocol/version';
import { FeishuGatewayError } from './errors';
import type { EnrolledFeishuCredential } from './types';

const UTF8 = new TextEncoder();
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/$-]*$/;
const KNOWN_CAPABILITIES = new Set<string>(Object.values(AgentDeckCapability));
const LIMIT_CEILING = 1_000_000_000;

function exactKeys(value: object, expected: readonly string[], label: string): void {
  const keys = Object.keys(value).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== [...expected].sort()[index])) {
    throw new FeishuGatewayError('invalid_core_response', `${label} fields are malformed`);
  }
}

function boundedText(value: string, label: string, identifier = false): string {
  if (
    value.length === 0 ||
    UTF8.encode(value).byteLength > 256 ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    (identifier && !IDENTIFIER.test(value))
  ) {
    throw new FeishuGatewayError('invalid_core_response', `${label} is malformed`);
  }
  return value;
}

/** Validates the complete untrusted hello and returns a detached immutable snapshot. */
export function validateHostHello(
  input: unknown,
  credential: EnrolledFeishuCredential,
  clientId: string,
): HostHello {
  try {
    assertHostHello(input);
    negotiateProtocolVersion(input.protocolVersion);
  } catch {
    throw new FeishuGatewayError('invalid_core_response', 'Core hello is malformed');
  }
  const hello = input as HostHello;
  if (hello.access.kind !== 'authenticated-client') {
    throw new FeishuGatewayError('access_denied', 'Core returned a non-client access context');
  }
  exactKeys(hello, [
    'access', 'appVersion', 'authoritativeCore', 'capabilities', 'eventRevision',
    'instanceId', 'limits', 'protocolVersion', 'topology',
  ], 'hello');
  exactKeys(hello.authoritativeCore, ['generation', 'id', 'location'], 'authoritativeCore');
  exactKeys(hello.protocolVersion, ['major', 'minor'], 'protocolVersion');
  exactKeys(hello.limits, [
    'maxBlobBytes', 'maxConcurrentRequests', 'maxFrameBytes', 'maxQueuedEvents',
  ], 'limits');
  exactKeys(hello.access, [
    'authority', 'clientId', 'connectionScope', 'grant', 'instanceId', 'kind', 'surface',
    'topology', 'transport',
  ], 'access');
  boundedText(hello.appVersion, 'hello.appVersion');
  boundedText(hello.instanceId, 'hello.instanceId', true);
  boundedText(hello.authoritativeCore.id, 'authoritativeCore.id', true);
  boundedText(hello.access.clientId, 'access.clientId', true);
  boundedText(String(hello.access.connectionScope), 'access.connectionScope', true);
  if (
    hello.instanceId !== credential.instanceId ||
    hello.topology !== credential.topology ||
    hello.access.instanceId !== credential.instanceId ||
    hello.access.topology !== credential.topology ||
    hello.access.clientId !== clientId ||
    hello.access.connectionScope !== credential.connectionScope ||
    hello.access.transport !== 'feishu' ||
    hello.access.surface !== AccessSurface.Feishu ||
    hello.access.authority !== 'owner-equivalent'
  ) {
    throw new FeishuGatewayError('access_denied', 'Core returned a mismatched Feishu access context');
  }
  const capabilities = [...hello.capabilities];
  if (
    new Set(capabilities).size !== capabilities.length ||
    capabilities.some((capability) => !KNOWN_CAPABILITIES.has(capability))
  ) {
    throw new FeishuGatewayError('invalid_core_response', 'Core capabilities are malformed');
  }
  for (const value of Object.values(hello.limits)) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > LIMIT_CEILING) {
      throw new FeishuGatewayError('invalid_core_response', 'Core transport limits are malformed');
    }
  }
  if (!Number.isSafeInteger(hello.eventRevision) || hello.eventRevision < 0) {
    throw new FeishuGatewayError('invalid_core_response', 'Core event revision is malformed');
  }
  if (
    hello.authoritativeCore.generation !== null &&
    (!Number.isSafeInteger(hello.authoritativeCore.generation) ||
      hello.authoritativeCore.generation < 0)
  ) {
    throw new FeishuGatewayError('invalid_core_response', 'Core generation is malformed');
  }
  return Object.freeze({
    ...hello,
    protocolVersion: Object.freeze({ ...hello.protocolVersion }),
    authoritativeCore: Object.freeze({ ...hello.authoritativeCore }),
    access: Object.freeze({
      ...hello.access,
      grant: copyRemoteOwnerGrantClaim(hello.access.grant),
    }),
    capabilities: Object.freeze(capabilities),
    limits: Object.freeze({ ...hello.limits }),
  });
}
