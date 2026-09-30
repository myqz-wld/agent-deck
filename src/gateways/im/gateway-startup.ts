import type { FeishuClientPool } from './client-pool';
import { FeishuGatewayError, FeishuGatewayLifecycleError } from './errors';
import { assertStoreBoundToGateway } from './gateway-binding';
import type { FeishuGatewayBinding, FeishuGatewayLimits, FeishuGatewayStore } from './types';

export async function startFeishuGateway(
  store: FeishuGatewayStore, binding: FeishuGatewayBinding, limits: FeishuGatewayLimits,
  pool: FeishuClientPool, now: number, reportFailure: () => void,
): Promise<void> {
  assertStoreBoundToGateway(store, binding);
  store.pruneDeliveries(Math.max(0, now - limits.deliveryRetentionMs));
  store.pruneDeleteConfirmations(Math.max(0, now - 86_400_000), now);
  const contexts = store.listContexts();
  const chatCount = new Set(contexts.map(context => `${context.credentialId}\u001f${context.chatId}`)).size;
  if (chatCount > limits.maxConcurrentChatClients || chatCount > limits.maxNotificationLanes) {
    throw new FeishuGatewayError('invalid_configuration', 'Persisted Feishu chats exceed the configured startup ceiling');
  }
  const credentials = new Map(store.listActiveCredentials().map(credential => [
    `${credential.instanceId}\u001f${credential.credentialId}`, credential,
  ]));
  const results = await Promise.allSettled(contexts.map(async context => {
    const credential = credentials.get(`${context.instanceId}\u001f${context.credentialId}`);
    if (credential) await pool.get(credential, context.chatId);
  }));
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map(result => result.reason);
  if (failures.length > 0) { reportFailure(); throw new FeishuGatewayLifecycleError(failures, 'start'); }
}
