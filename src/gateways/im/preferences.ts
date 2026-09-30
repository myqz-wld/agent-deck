import { parseFeishuPreferencesResult, type FeishuPreferencesResult, type FeishuModelPreference,
  type FeishuPreferencePurpose, type SessionConsoleCapabilitiesResult } from '@contracts/index';
import { assertFeishuMethod } from './client-pool';
import { validateSessionConsoleCapabilitiesResult } from './core-output';
import { FeishuGatewayError } from './errors';
import { truncateUtf8 } from './redaction';
import type { ConnectedFeishuClient, FeishuGatewayLimits, SessionConsoleView } from './types';

export async function readPreferences(connected: ConnectedFeishuClient, remaining: () => number): Promise<FeishuPreferencesResult> {
  assertFeishuMethod(connected.hello, 'feishu.preferences.get');
  const raw = await connected.client.request('feishu.preferences.get', {}, { deadlineMs: remaining() });
  try { return parseFeishuPreferencesResult(raw); }
  catch { throw new FeishuGatewayError('invalid_core_response', 'Invalid model preferences'); }
}

export async function savePreference(connected: ConnectedFeishuClient, remaining: () => number,
  current: FeishuPreferencesResult, purpose: FeishuPreferencePurpose, preference: FeishuModelPreference,
  eventId: string): Promise<FeishuPreferencesResult> {
  if (JSON.stringify(current[purpose]) === JSON.stringify(preference)) return current;
  assertFeishuMethod(connected.hello, 'feishu.preferences.update');
  const raw = await connected.client.request('feishu.preferences.update', {
    purpose, preference, expectedSettingsRevision: current.settingsRevision,
  }, { deadlineMs: remaining(), idempotencyKey: `feishu:preference:${eventId}` });
  try { return parseFeishuPreferencesResult(raw); }
  catch { throw new FeishuGatewayError('invalid_core_response', 'Invalid model preferences'); }
}

export async function readModelCapabilities(connected: ConnectedFeishuClient, remaining: () => number,
  limits: FeishuGatewayLimits, adapterId: string | null, provider = '', workingDirectory = '.',
): Promise<SessionConsoleCapabilitiesResult> {
  assertFeishuMethod(connected.hello, 'session.console.capabilities');
  const params = { adapterId, provider, workingDirectory };
  return validateSessionConsoleCapabilitiesResult(await connected.client.request(
    'session.console.capabilities', params, { deadlineMs: remaining() }), limits, params);
}

export function preferenceLabel(value: FeishuModelPreference): string {
  if (!value.adapterId) return '尚未选择';
  return [value.adapterId, value.provider && `网关 ${value.provider}`,
    value.model || '模型跟随原生设置', value.thinking && `思考 ${value.thinking}`].filter(Boolean).join(' · ');
}

export function renderPreferences(value: FeishuPreferencesResult): SessionConsoleView {
  return { revision: value.revision, text: [
    `机器人聊天：${preferenceLabel(value.conversation)}`, `新建会话：${preferenceLabel(value.session)}`,
    '', '分别记住上次选择，与 Agent Deck 远端设置同步。已开始的会话保持原配置。',
    '', '发送 /models 查看可用选项。',
    '设置聊天：/settings chat <adapter-id>', '设置新会话：/settings session <adapter-id>',
    '可追加模型选项，例如：{"model":"模型名","thinking":"high"}',
    '普通文字发给助手；/new 新建工作会话；/send <内容> 发给所选工作会话。',
    '发送 /chat new 使用聊天配置重开助手聊天，保留旧记录。',
  ].join('\n') };
}

export function renderModels(value: SessionConsoleCapabilitiesResult, limit: number): SessionConsoleView {
  const lines = value.adapters.map((adapter) => `${adapter.displayName} · ${adapter.adapterId}${adapter.enabled ? '' : '（暂不可用）'}`);
  lines.push('', `当前查看：${value.create.displayName}`);
  for (const key of ['provider', 'model', 'thinking'] as const) {
    const option = value.create.options[key];
    if (!option.enabled) continue;
    lines.push(`${{ provider: '模型网关', model: '模型', thinking: '思考程度' }[key]}：${option.allowedValues?.join('、') || '使用原生设置'}${option.allowCustom ? '；支持自定义值' : ''}`);
  }
  lines.push('', '查看其他选项：/models <adapter-id> [provider]',
    '保存选择：/settings <chat|session> <adapter-id> [JSON]',
    '后续沿用上次选择，也可在 Agent Deck 远端设置中管理。');
  return { text: truncateUtf8(lines.join('\n'), limit), revision: value.revision };
}
