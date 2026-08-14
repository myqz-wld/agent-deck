import type { PendingActionNoncePort } from '..';

function hash(value: string): string {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result = Math.imul(result ^ value.charCodeAt(index), 16777619);
  }
  return (result >>> 0).toString(36);
}

function nonceValue(binding: Parameters<PendingActionNoncePort['issue']>[0]): string {
  return JSON.stringify([
    binding.instanceId,
    binding.credentialId,
    binding.chatId,
    binding.chatType,
    binding.sessionId,
    binding.requestId,
    binding.revision,
    binding.contentDigest,
    binding.action,
  ]);
}

export const testNonce: PendingActionNoncePort = {
  issue: (binding) => `nonce-${hash(nonceValue(binding))}`,
  verify: (binding, nonce) => nonce === `nonce-${hash(nonceValue(binding))}`,
};
