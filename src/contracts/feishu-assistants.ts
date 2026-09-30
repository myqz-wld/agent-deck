import { isJsonObject } from './json';

export const FEISHU_ASSISTANT_REGISTRATION_LIMIT = 128;
export interface FeishuAssistantsRegisterParams { sessionIds: string[] }
export interface FeishuAssistantsRegisterResult {
  registeredSessionIds: string[];
  revision: number;
}

export function parseFeishuAssistantSessionIds(value: unknown, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum || value.some(id =>
    typeof id !== 'string' || id.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(id)) ||
    new Set(value).size !== value.length) throw new Error('Invalid Feishu assistant identities');
  return [...value];
}

export function parseFeishuAssistantsRegisterParams(value: unknown): FeishuAssistantsRegisterParams {
  if (!isJsonObject(value) || Object.keys(value).join(',') !== 'sessionIds') {
    throw new Error('Invalid Feishu assistant registration');
  }
  const sessionIds = parseFeishuAssistantSessionIds(value.sessionIds, FEISHU_ASSISTANT_REGISTRATION_LIMIT);
  if (!sessionIds.length) throw new Error('Feishu assistant registration requires an identity');
  return { sessionIds: sessionIds.sort() };
}

export function parseFeishuAssistantsRegisterResult(value: unknown): FeishuAssistantsRegisterResult {
  if (!isJsonObject(value) || Object.keys(value).sort().join(',') !== 'registeredSessionIds,revision' ||
    !Number.isSafeInteger(value.revision) || Number(value.revision) < 0) {
    throw new Error('Invalid Feishu assistant registration result');
  }
  return { registeredSessionIds: parseFeishuAssistantSessionIds(
    value.registeredSessionIds, FEISHU_ASSISTANT_REGISTRATION_LIMIT,
  ), revision: Number(value.revision) };
}
