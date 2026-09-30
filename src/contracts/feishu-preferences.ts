import { isJsonObject } from './json';

export type FeishuPreferencePurpose = 'conversation' | 'session';
export interface FeishuModelPreference {
  adapterId: 'claude-code' | 'codex-cli' | 'grok-build' | null;
  provider: string;
  model: string;
  thinking: string;
}
export interface FeishuPreferences {
  conversation: FeishuModelPreference;
  session: FeishuModelPreference;
  settingsRevision: number;
}
export interface FeishuPreferencesResult extends FeishuPreferences { revision: number }
export interface FeishuPreferencesUpdateParams {
  purpose: FeishuPreferencePurpose;
  preference: FeishuModelPreference;
  expectedSettingsRevision: number;
}

export function defaultFeishuModelPreference(): FeishuModelPreference {
  return { adapterId: null, provider: '', model: '', thinking: '' };
}
function fail(): never { throw new Error('Invalid Feishu model preferences'); }
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail();
  return Number(value);
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!isJsonObject(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail();
  return value;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || new TextEncoder().encode(value).byteLength > 512 ||
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)) fail();
  return value;
}
export function parseFeishuModelPreference(value: unknown): FeishuModelPreference {
  const raw = object(value, ['adapterId', 'provider', 'model', 'thinking']);
  if (raw.adapterId !== null && (typeof raw.adapterId !== 'string' ||
    !['claude-code', 'codex-cli', 'grok-build'].includes(raw.adapterId))) fail();
  const result = { adapterId: raw.adapterId as FeishuModelPreference['adapterId'],
    provider: text(raw.provider), model: text(raw.model), thinking: text(raw.thinking) };
  if (result.adapterId === null && (result.provider || result.model || result.thinking)) fail();
  if (result.adapterId === 'grok-build' && result.provider !== '') fail();
  return result;
}
export function parseFeishuPreferences(value: unknown): FeishuPreferences {
  const raw = object(value, ['conversation', 'session', 'settingsRevision']);
  return { conversation: parseFeishuModelPreference(raw.conversation), session: parseFeishuModelPreference(raw.session),
    settingsRevision: integer(raw.settingsRevision) };
}
export function parseFeishuPreferencesResult(value: unknown): FeishuPreferencesResult {
  const raw = object(value, ['conversation', 'session', 'settingsRevision', 'revision']);
  return { ...parseFeishuPreferences({ conversation: raw.conversation, session: raw.session,
    settingsRevision: raw.settingsRevision }), revision: integer(raw.revision) };
}
export function parseFeishuPreferencesUpdate(value: unknown): FeishuPreferencesUpdateParams {
  const raw = object(value, ['purpose', 'preference', 'expectedSettingsRevision']);
  if (raw.purpose !== 'conversation' && raw.purpose !== 'session') fail();
  return { purpose: raw.purpose, preference: parseFeishuModelPreference(raw.preference),
    expectedSettingsRevision: integer(raw.expectedSettingsRevision) };
}
