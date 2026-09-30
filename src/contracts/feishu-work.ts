import { isJsonObject } from './json';
import { FEISHU_PREFERENCE_OPTION_KEYS, parseFeishuModelPreference, type FeishuModelPreference } from './feishu-preferences';
import { parseSessionName } from './session-name';
import { parseSessionConsoleInitialMessage, parseWorkspaceDirectoryRef } from './session-console';

export interface FeishuWorkCreateArgs {
  requestId: string;
  title: string;
  initialMessage: string;
  expectedSettingsRevision: number;
  workingDirectory?: string;
  selection?: Partial<FeishuModelPreference>;
}
export interface FeishuWorkCreateResult {
  sessionId: string;
  title: string;
  preference: FeishuModelPreference;
  settingsRevision: number;
  revision: number;
}
export interface FeishuWorkEvent {
  assistantSessionId: string;
  requestId: string;
}

export function parseFeishuRequestId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error('requestId must be a stable 1-128 character ASCII identifier');
  }
  return value;
}

export function parseFeishuPreferencePatch(value: unknown): Partial<FeishuModelPreference> {
  const keys = ['adapterId', ...FEISHU_PREFERENCE_OPTION_KEYS];
  if (!isJsonObject(value) || Object.keys(value).some(k => !keys.includes(k))) throw new Error('Unknown preference override field');
  return Object.fromEntries(keys.filter(k => Object.hasOwn(value, k)).map(k => [k, value[k]]));
}

export function parseFeishuWorkCreateArgs(value: unknown): Required<FeishuWorkCreateArgs> {
  const required = ['requestId', 'title', 'initialMessage', 'expectedSettingsRevision'];
  if (!isJsonObject(value) || required.some(k => !Object.hasOwn(value, k)) ||
    Object.keys(value).some(k => ![...required, 'workingDirectory', 'selection'].includes(k)) ||
    !Number.isSafeInteger(value.expectedSettingsRevision) || Number(value.expectedSettingsRevision) < 0) {
    throw new Error('Work creation requires requestId, title, initialMessage and expectedSettingsRevision');
  }
  return { requestId: parseFeishuRequestId(value.requestId), title: parseSessionName(value.title),
    initialMessage: parseSessionConsoleInitialMessage(value.initialMessage),
    expectedSettingsRevision: Number(value.expectedSettingsRevision),
    workingDirectory: value.workingDirectory === undefined ? '.' : parseWorkspaceDirectoryRef(value.workingDirectory, 'workingDirectory'),
    selection: value.selection === undefined ? {} : parseFeishuPreferencePatch(value.selection) };
}

export function parseFeishuWorkEvent(value: unknown): FeishuWorkEvent {
  if (!isJsonObject(value) || Object.keys(value).sort().join(',') !== 'assistantSessionId,requestId' ||
    typeof value.assistantSessionId !== 'string' || value.assistantSessionId.length > 256 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(value.assistantSessionId)) throw new Error('Invalid Feishu work registration');
  return { assistantSessionId: value.assistantSessionId, requestId: parseFeishuRequestId(value.requestId) };
}

export function parseFeishuWorkCreateResult(value: unknown): FeishuWorkCreateResult {
  if (!isJsonObject(value) || Object.keys(value).sort().join(',') !== 'preference,revision,sessionId,settingsRevision,title' ||
    typeof value.sessionId !== 'string' || value.sessionId.length > 256 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(value.sessionId) ||
    !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 ||
    !Number.isSafeInteger(value.settingsRevision) || Number(value.settingsRevision) < 0) throw new Error('Invalid created work session result');
  return { sessionId: value.sessionId, title: parseSessionName(value.title), preference: parseFeishuModelPreference(value.preference),
    revision: Number(value.revision), settingsRevision: Number(value.settingsRevision) };
}
