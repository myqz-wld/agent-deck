import { FeishuGatewayError } from './errors';
import type {
  EnrolledFeishuCredential,
  FeishuGatewayBinding,
  FeishuGatewayStore,
  FeishuStableSubject,
} from './types';

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/$-]*$/;

function configurationToken(value: string, field: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > 256 ||
    !TOKEN.test(value)
  ) {
    throw new FeishuGatewayError(
      'invalid_configuration',
      `${field} must be a bounded stable identifier`,
    );
  }
  return value;
}

export function validateGatewayBinding(binding: FeishuGatewayBinding): FeishuGatewayBinding {
  if (!['relay', 'full'].includes(binding.topology)) {
    throw new FeishuGatewayError('invalid_configuration', 'Gateway topology is invalid');
  }
  return {
    appId: configurationToken(binding.appId, 'binding.appId'),
    tenantKey: configurationToken(binding.tenantKey, 'binding.tenantKey'),
    instanceId: configurationToken(binding.instanceId, 'binding.instanceId'),
    topology: binding.topology,
  };
}

export function credentialMatchesBinding(
  credential: EnrolledFeishuCredential,
  binding: FeishuGatewayBinding,
): boolean {
  return (
    credential.appId === binding.appId &&
    credential.tenantKey === binding.tenantKey &&
    credential.instanceId === binding.instanceId &&
    credential.topology === binding.topology
  );
}

export function subjectMatchesBinding(
  subject: FeishuStableSubject,
  binding: FeishuGatewayBinding,
): boolean {
  return subject.appId === binding.appId && subject.tenantKey === binding.tenantKey;
}

export function assertStoreBoundToGateway(
  store: FeishuGatewayStore,
  binding: FeishuGatewayBinding,
): void {
  const credentials = store.listActiveCredentials();
  if (credentials.some((credential) => !credentialMatchesBinding(credential, binding))) {
    throw new FeishuGatewayError(
      'invalid_configuration',
      'Active credential is outside the pinned gateway instance/topology/app/tenant',
    );
  }
  const credentialsById = new Map(
    credentials.map((credential) => [credential.credentialId, credential]),
  );
  if (
    store.listContexts().some(
      (context) => {
        const credential = credentialsById.get(context.credentialId);
        return (
          context.instanceId !== binding.instanceId ||
          !credential ||
          context.openId !== credential.openId
        );
      },
    )
  ) {
    throw new FeishuGatewayError(
      'invalid_configuration',
      'Persisted chat context is outside the pinned gateway instance or active credentials',
    );
  }
}
