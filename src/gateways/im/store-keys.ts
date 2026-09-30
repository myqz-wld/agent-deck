import type { FeishuStableSubject } from './types';

export function subjectKey(subject: FeishuStableSubject): string {
  return `${subject.appId}\u001f${subject.tenantKey}\u001f${subject.openId}`;
}

export function contextKey(instanceId: string, credentialId: string, chatId: string): string {
  return `${instanceId}\u001f${credentialId}\u001f${chatId}`;
}

export function subscriptionKey(
  instanceId: string,
  credentialId: string,
  chatId: string,
  sessionId: string,
): string {
  return `${contextKey(instanceId, credentialId, chatId)}\u001f${sessionId}`;
}

export function deliveryKey(instanceId: string, eventId: string): string {
  return `${instanceId}\u001f${eventId}`;
}
