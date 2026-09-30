import { defaultFeishuModelPreference, parseFeishuModelPreference, type FeishuModelPreference,
  type FeishuPreferencePurpose } from '@contracts/index';
import { FeishuGatewayError } from './errors';

export type PreferenceCommand =
  | { kind: 'preferences-get' }
  | { kind: 'preferences-set'; purpose: FeishuPreferencePurpose; preference: FeishuModelPreference }
  | { kind: 'models'; adapterId: string | null; provider: string };

export function parsePreferenceCommand(input: string): PreferenceCommand | null {
  if (input === '/settings') return { kind: 'preferences-get' };
  if (input === '/models') return { kind: 'models', adapterId: null, provider: '' };
  if (input.startsWith('/models ')) {
    const match = input.match(/^\/models (claude-code|codex-cli|grok-build)(?: ([^\s]+))?$/);
    if (!match) throw new FeishuGatewayError('invalid_command', '用法：/models <adapter-id> [provider]');
    return { kind: 'models', adapterId: match[1], provider: match[2] ?? '' };
  }
  if (!input.startsWith('/settings ')) return null;
  const match = input.match(/^\/settings (chat|session) (claude-code|codex-cli|grok-build)(?: (\{.*\}))?$/s);
  if (!match) throw new FeishuGatewayError('invalid_command', '用法：/settings <chat|session> <adapter-id> [JSON]');
  try {
    const options: unknown = match[3] ? JSON.parse(match[3]) : {};
    if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some((key) => !['provider', 'model', 'thinking'].includes(key))) throw new Error('options');
    const preference = parseFeishuModelPreference({ ...defaultFeishuModelPreference(), ...options, adapterId: match[2] });
    return { kind: 'preferences-set', purpose: match[1] === 'chat' ? 'conversation' : 'session', preference };
  } catch { throw new FeishuGatewayError('invalid_command', '模型选项必须是有效的 provider、model、thinking JSON 字符串字段'); }
}

export function parseCreateOverrides(input: string): { directory: string; selection: Partial<FeishuModelPreference> } {
  const parts = input.split(/ --(provider|model|thinking) /);
  const selection: Partial<FeishuModelPreference> = {};
  for (let i = 1; i < parts.length; i += 2) {
    const key = parts[i] as 'provider' | 'model' | 'thinking';
    const value = parts[i + 1];
    if (key in selection || !value || /\s/.test(value) || value.length > 512) {
      throw new FeishuGatewayError('invalid_command', '模型选项不能重复、留空或包含空白');
    }
    selection[key] = value;
  }
  return { directory: parts[0], selection };
}
