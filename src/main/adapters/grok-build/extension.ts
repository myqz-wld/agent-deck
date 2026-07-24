export const GROK_EXTENSION_UPDATE_METHOD = '_x.ai/session/update';

export interface GrokExtensionNotification {
  sessionId?: string;
  update?: GrokExtensionUpdate;
  timestamp?: number;
  _meta?: {
    agentTimestampMs?: number;
    promptId?: string;
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
}

export interface GrokExtensionUpdate {
  sessionUpdate?: string;
  prompt_id?: string;
  promptId?: string;
  usage?: GrokTurnUsage;
  [key: string]: unknown;
}

export interface GrokTurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  reasoningTokens?: number;
  thoughtTokens?: number;
  modelCalls?: number;
  apiDurationMs?: number;
  modelUsage?: Record<string, GrokTurnUsage>;
  [key: string]: unknown;
}

export function parseGrokExtensionNotification(
  params: unknown,
): GrokExtensionNotification {
  if (!isRecord(params)) return {};
  const update = isRecord(params.update) ? params.update : undefined;
  return {
    ...params,
    ...(update ? { update: update as GrokExtensionUpdate } : {}),
  } as GrokExtensionNotification;
}

export function grokExtensionTimestampMs(
  notification: GrokExtensionNotification,
  fallback = Date.now(),
): number {
  const agentTimestamp = finiteNumber(notification._meta?.agentTimestampMs);
  if (agentTimestamp !== null) return agentTimestamp;
  const timestamp = finiteNumber(notification.timestamp);
  if (timestamp !== null) return timestamp > 1_000_000_000_000 ? timestamp : timestamp * 1000;
  return fallback;
}

export function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function extensionPromptId(update: GrokExtensionUpdate): string | null {
  const promptId = update.prompt_id ?? update.promptId;
  return typeof promptId === 'string' && promptId.trim() ? promptId : null;
}

export function notificationPromptId(
  notification: GrokExtensionNotification,
): string | null {
  const fromUpdate = notification.update ? extensionPromptId(notification.update) : null;
  if (fromUpdate) return fromUpdate;
  const promptId = notification._meta?.promptId;
  return typeof promptId === 'string' && promptId.trim() ? promptId : null;
}

export function firstModelUsageKey(usage: GrokTurnUsage): string | null {
  const modelUsage = usage.modelUsage;
  if (!modelUsage || typeof modelUsage !== 'object') return null;
  const key = Object.keys(modelUsage).find((value) => value.trim());
  return key ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
