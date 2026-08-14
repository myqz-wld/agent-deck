import { createHash } from 'node:crypto';
import {
  AgentDeckClientErrorCode,
  CHANNEL_INTERNAL_METHODS,
  REMOTE_OWNER_PRODUCT_V1_METHODS,
  type CoreMethod,
  type JsonValue,
} from '@contracts/index';
import {
  FeishuGatewayError,
  type EnrolledFeishuCredential,
  type FeishuGatewayClock,
} from '@gateways/im';
import { validateHostHello } from '@gateways/im/host-hello';
import { CURRENT_PROTOCOL_VERSION } from '@protocol/version';
import { boundedFeishuOperation } from './bounded-operation';
import type {
  FeishuProductionConfig,
  LoadedFeishuRuntimeFactoryOptions,
} from './types';

function exactMethods(
  actual: readonly CoreMethod[],
  expected: readonly CoreMethod[],
): boolean {
  return actual.length === expected.length &&
    actual.every((method) => expected.includes(method));
}

function accessDenied(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    (error as { code?: unknown }).code === AgentDeckClientErrorCode.AccessDenied;
}

export function createFeishuCoreProbe(
  config: FeishuProductionConfig,
  options: LoadedFeishuRuntimeFactoryOptions,
  clock: FeishuGatewayClock,
): () => Promise<JsonValue> {
  const configured = config.credentials[0];
  if (!configured || configured.status !== 'active') {
    throw new FeishuGatewayError('invalid_configuration', 'Feishu Core probe credential is inactive');
  }
  const digest = createHash('sha256')
    .update(config.instanceId, 'utf8')
    .update('\0', 'utf8')
    .update(configured.credentialId, 'utf8')
    .digest('base64url');
  const clientId = `feishu-verify-${digest}`;
  const credential: EnrolledFeishuCredential = {
    appId: config.appId,
    tenantKey: config.tenantKey,
    openId: configured.openId ?? 'unpaired',
    instanceId: config.instanceId,
    credentialId: configured.credentialId,
    connectionScope: configured.connectionScope,
    topology: config.topology,
    status: 'active',
    authority: 'owner-equivalent',
  };
  return async () => {
    const client = options.clientFactory({
      instanceId: config.instanceId,
      credentialId: configured.credentialId,
      clientId,
      topology: config.topology,
    });
    try {
      const raw = await boundedFeishuOperation(client.connect({
        protocolVersion: CURRENT_PROTOCOL_VERSION,
        appVersion: options.appVersion,
        clientId,
        requestedTopology: config.topology,
      }), clock, config.startupTimeoutMs, 'Feishu Core verification exceeded the production bound');
      const hello = validateHostHello(raw, credential, clientId);
      const grant = hello.access.kind === 'authenticated-client' ? hello.access.grant : null;
      if (
        grant === null ||
        !exactMethods(grant.productMethods, REMOTE_OWNER_PRODUCT_V1_METHODS) ||
        !exactMethods(grant.channelMethods, CHANNEL_INTERNAL_METHODS.feishu)
      ) {
        throw new FeishuGatewayError(
          'invalid_core_response',
          'Core returned an incomplete Feishu owner grant',
        );
      }
      try {
        await boundedFeishuOperation(
          client.request('system.health', {}, { deadlineMs: config.startupTimeoutMs }),
          clock,
          config.startupTimeoutMs,
          'Feishu Core denial verification exceeded the production bound',
        );
        throw new FeishuGatewayError(
          'invalid_core_response',
          'Core allowed a method outside the Feishu owner grant',
        );
      } catch (error) {
        if (error instanceof FeishuGatewayError) throw error;
        if (!accessDenied(error)) {
          throw new FeishuGatewayError(
            'invalid_core_response',
            'Core did not prove the Feishu owner grant boundary',
          );
        }
      }
      return {
        topology: hello.topology,
        policy: grant.policy,
        policyVersion: grant.policyVersion,
        policyRevision: grant.policyRevision,
        productMethodCount: grant.productMethods.length,
        channelMethodCount: grant.channelMethods.length,
        broaderMethodDenied: true,
      };
    } finally {
      await boundedFeishuOperation(
        client.close(),
        clock,
        config.shutdownTimeoutMs,
        'Feishu Core verification cleanup exceeded the production bound',
      );
    }
  };
}
