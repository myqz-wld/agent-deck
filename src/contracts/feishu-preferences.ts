import { isJsonObject } from './json';
import { isAdapterSessionMode, isCodexApprovalPolicy, isSelectablePermissionMode,
  type AdapterSessionMode, type CodexApprovalPolicy, type SelectablePermissionMode } from '@shared/types';

export type FeishuPreferencePurpose = 'conversation' | 'session';
export interface FeishuModelPreference {
  adapterId: 'claude-code' | 'codex-cli' | 'grok-build' | null;
  provider: string;
  model: string;
  thinking: string;
  permissionMode?: SelectablePermissionMode | null;
  approvalPolicy?: CodexApprovalPolicy | null;
  sessionMode?: AdapterSessionMode | null;
  claudeCodeSandbox?: 'off' | 'workspace-write' | 'strict' | null;
  codexSandbox?: 'workspace-write' | 'read-only' | 'danger-full-access' | null;
  grokSandbox?: string | null;
}
export const FEISHU_RUNTIME_OPTION_KEYS = ['permissionMode', 'approvalPolicy', 'sessionMode',
  'claudeCodeSandbox', 'codexSandbox', 'grokSandbox'] as const;
export const FEISHU_PREFERENCE_OPTION_KEYS = ['provider', 'model', 'thinking', ...FEISHU_RUNTIME_OPTION_KEYS] as const;
export type FeishuRuntimeOptionKey = typeof FEISHU_RUNTIME_OPTION_KEYS[number];
export function feishuRuntimeOptionKeys(adapterId: FeishuModelPreference['adapterId']): readonly FeishuRuntimeOptionKey[] {
  return adapterId === 'claude-code' ? ['permissionMode', 'claudeCodeSandbox']
    : adapterId === 'codex-cli' ? ['approvalPolicy', 'codexSandbox']
      : adapterId === 'grok-build' ? ['sessionMode', 'grokSandbox'] : [];
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
function fail(): never { throw new Error('Invalid Feishu preferences'); }
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail();
  return Number(value);
}
function object(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!isJsonObject(value) || keys.some(key => !Object.hasOwn(value, key)) ||
    Object.keys(value).some(key => !keys.includes(key) && !optional.includes(key))) fail();
  return value;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || new TextEncoder().encode(value).byteLength > 512 ||
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)) fail();
  return value;
}
export function parseFeishuModelPreference(value: unknown): FeishuModelPreference {
  const raw = object(value, ['adapterId', 'provider', 'model', 'thinking'], FEISHU_RUNTIME_OPTION_KEYS);
  if (raw.adapterId !== null && (typeof raw.adapterId !== 'string' ||
    !['claude-code', 'codex-cli', 'grok-build'].includes(raw.adapterId))) fail();
  const result: FeishuModelPreference = { adapterId: raw.adapterId as FeishuModelPreference['adapterId'],
    provider: text(raw.provider), model: text(raw.model), thinking: text(raw.thinking) };
  if (result.adapterId === null && (result.provider || result.model || result.thinking)) fail();
  if (result.adapterId === 'grok-build' && result.provider !== '') fail();
  const owned = feishuRuntimeOptionKeys(result.adapterId);
  for (const key of FEISHU_RUNTIME_OPTION_KEYS) {
    if (!Object.hasOwn(raw, key)) continue;
    if (!owned.includes(key)) fail();
    const value = raw[key];
    if (key === 'approvalPolicy' && (value === null || isCodexApprovalPolicy(value))) result.approvalPolicy = value;
    else if (key === 'permissionMode' && (value === null || isSelectablePermissionMode(value))) result.permissionMode = value;
    else if (key === 'sessionMode' && (value === null || isAdapterSessionMode(value))) result.sessionMode = value;
    else if (key === 'claudeCodeSandbox' && (value === null || value === 'off' || value === 'workspace-write' || value === 'strict')) result.claudeCodeSandbox = value;
    else if (key === 'codexSandbox' && (value === null || value === 'workspace-write' || value === 'read-only' || value === 'danger-full-access')) result.codexSandbox = value;
    else if (key === 'grokSandbox' && (value === null || (typeof value === 'string' && value.length > 0 &&
      value === value.trim() && new TextEncoder().encode(value).byteLength <= 128))) result.grokSandbox = value === null ? null : text(value);
    else fail();
  }
  return result;
}
/** Same-adapter edits preserve omitted choices; a different adapter starts from its own defaults. */
export function mergeFeishuModelPreference(previous: FeishuModelPreference,
  patch: Partial<FeishuModelPreference>): FeishuModelPreference {
  const adapterId = patch.adapterId === undefined ? previous.adapterId : patch.adapterId;
  return parseFeishuModelPreference({ ...(adapterId === previous.adapterId ? previous : defaultFeishuModelPreference()),
    ...patch, adapterId });
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
