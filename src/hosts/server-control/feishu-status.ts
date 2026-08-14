import { createHash } from 'node:crypto';
import { isJsonObject, type JsonObject, type JsonValue } from '@contracts/index';
import type { ServerControlConfig } from './config';
import type { FeishuManagementClientPort } from './feishu-management-client';
import type { FeishuRuntimeReleaseState } from './feishu-runtime-release';
import type { SystemdControlPort } from './systemd';

export const FEISHU_LIVE_ACCEPTANCE: JsonObject = {
  state: 'external-required',
  checks: ['p2p-message', 'card-action', 'unauthorized-user'],
};

export function feishuRuntimeSummary(state: FeishuRuntimeReleaseState): JsonObject {
  return {
    state: 'installed',
    activeDigest: state.activeDigest,
    desiredDigest: state.desiredDigest,
    updateAvailable: state.updateAvailable,
  };
}

export function parseFeishuManagementStatus(
  value: JsonValue,
  config: ServerControlConfig,
): JsonObject {
  if (!isJsonObject(value) || value.instanceId !== config.instanceId ||
      value.topology !== config.topology) {
    throw new Error('Feishu management status binding is invalid');
  }
  if (
    !isJsonObject(value.connection) ||
    !['connected', 'failed', 'reconnecting', 'starting', 'stopped']
      .includes(String(value.connection.state))
  ) throw new Error('Feishu long connection status is invalid');
  if (
    !isJsonObject(value.core) ||
    !['connected', 'failed', 'unverified'].includes(String(value.core.state)) ||
    (value.core.verifiedAt !== null && !Number.isSafeInteger(value.core.verifiedAt))
  ) throw new Error('Feishu Core verification status is invalid');
  if (
    !isJsonObject(value.pairing) || typeof value.pairing.paired !== 'boolean' ||
    !Number.isSafeInteger(value.pairing.pending) ||
    (value.pairing.openId !== null && typeof value.pairing.openId !== 'string') ||
    value.pairing.paired !== (typeof value.pairing.openId === 'string')
  ) throw new Error('Feishu pairing status is invalid');
  return value;
}

export function parseFeishuCoreVerification(
  value: JsonValue,
  config: ServerControlConfig,
): JsonObject {
  if (
    !isJsonObject(value) || value.state !== 'connected' || value.topology !== config.topology ||
    !Number.isSafeInteger(value.verifiedAt) ||
    value.policy !== 'Remote Owner Product v1' || value.policyVersion !== 1 ||
    !Number.isSafeInteger(value.policyRevision) || (value.policyRevision as number) <= 0 ||
    !Number.isSafeInteger(value.productMethodCount) || (value.productMethodCount as number) <= 0 ||
    !Number.isSafeInteger(value.channelMethodCount) || (value.channelMethodCount as number) <= 0 ||
    value.broaderMethodDenied !== true
  ) throw new Error('Feishu Core verification result is invalid');
  return value;
}

function fingerprint(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\0'), 'utf8').digest('hex');
}

export function redactFeishuManagementStatus(value: JsonObject): JsonObject {
  const pairing = value.pairing;
  if (!isJsonObject(pairing)) throw new Error('Feishu pairing status is invalid');
  const openId = typeof pairing.openId === 'string' ? pairing.openId : null;
  return {
    instanceId: value.instanceId as JsonValue,
    topology: value.topology as JsonValue,
    connection: value.connection as JsonValue,
    core: value.core as JsonValue,
    pairing: {
      paired: pairing.paired as JsonValue,
      pending: pairing.pending as JsonValue,
      identityFingerprint: openId === null
        ? null
        : fingerprint([String(value.instanceId), openId]),
    },
  };
}

function pairingCandidate(value: unknown): JsonObject {
  if (!isJsonObject(value)) throw new Error('Feishu pairing candidate is invalid');
  const requiredStrings = ['appId', 'chatId', 'codeId', 'instanceId', 'openId', 'requestId', 'tenantKey'];
  if (
    requiredStrings.some((field) => typeof value[field] !== 'string') ||
    (value.displayName !== null && typeof value.displayName !== 'string') ||
    !['approved', 'expired', 'pending', 'rejected'].includes(String(value.status)) ||
    !Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.expiresAt) ||
    (value.decidedAt !== null && !Number.isSafeInteger(value.decidedAt))
  ) throw new Error('Feishu pairing candidate is invalid');
  return {
    requestId: value.requestId as string,
    displayName: value.displayName as string | null,
    identityFingerprint: fingerprint([
      value.appId as string,
      value.tenantKey as string,
      value.openId as string,
    ]),
    status: value.status as string,
    expiresAt: value.expiresAt as number,
    createdAt: value.createdAt as number,
    decidedAt: value.decidedAt as number | null,
  };
}

export function redactFeishuPairingResult(value: JsonValue): JsonValue {
  if (!isJsonObject(value)) throw new Error('Feishu pairing result is invalid');
  if (Array.isArray(value.requests)) {
    return { requests: value.requests.map(pairingCandidate) };
  }
  if (
    !['already-decided', 'approved', 'expired', 'not-found', 'rejected']
      .includes(String(value.state)) ||
    (value.request !== null && !isJsonObject(value.request))
  ) throw new Error('Feishu pairing decision is invalid');
  return {
    state: value.state as string,
    request: value.request === null ? null : pairingCandidate(value.request),
  };
}

export interface HealthyFeishuManagementState {
  readonly rawStatus: JsonObject;
  readonly publicStatus: JsonObject;
}

export async function requireHealthyFeishuManagement(input: {
  readonly config: ServerControlConfig;
  readonly management: FeishuManagementClientPort;
  readonly systemd: SystemdControlPort;
  readonly serviceUnit: string;
}): Promise<HealthyFeishuManagementState> {
  if (!input.systemd.isActive(input.serviceUnit)) throw new Error('Feishu service is not active');
  const status = parseFeishuManagementStatus(
    await input.management.request('status', {}),
    input.config,
  );
  if (!isJsonObject(status.connection) || status.connection.state !== 'connected') {
    throw new Error('Feishu long connection is not connected');
  }
  const core = parseFeishuCoreVerification(
    await input.management.request('verify', {}),
    input.config,
  );
  return {
    rawStatus: status,
    publicStatus: { ...redactFeishuManagementStatus(status), core },
  };
}
