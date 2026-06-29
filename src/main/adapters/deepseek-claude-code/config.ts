import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const DEEPSEEK_DIR = join(homedir(), '.agent-deck', '.deepseek');
const DEEPSEEK_SETTINGS = join(DEEPSEEK_DIR, 'settings.json');

const DEFAULT_ENV: Record<string, string> = {
  ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
  ANTHROPIC_AUTH_TOKEN: '',
  ANTHROPIC_MODEL: 'deepseek-v4-pro[1m]',
  ANTHROPIC_DEFAULT_FABLE_MODEL: 'deepseek-v4-pro[1m]',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-pro[1m]',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-pro[1m]',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
  CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-v4-flash',
  CLAUDE_CODE_EFFORT_LEVEL: 'max',
};

interface DeepseekSettingsFile {
  env?: Record<string, unknown>;
  baseUrl?: unknown;
  url?: unknown;
  token?: unknown;
  authToken?: unknown;
  apiKey?: unknown;
  model?: unknown;
  fableModel?: unknown;
  opusModel?: unknown;
  sonnetModel?: unknown;
  haikuModel?: unknown;
  subagentModel?: unknown;
  effortLevel?: unknown;
}

export function getDeepseekSettingsPath(): string {
  return DEEPSEEK_SETTINGS;
}

export function loadDeepseekClaudeEnv(): Readonly<Record<string, string>> {
  ensureDefaultSettingsFile();
  const parsed = readSettingsFile();
  const env = { ...DEFAULT_ENV, ...stringRecord(parsed.env) };

  setIfString(env, 'ANTHROPIC_BASE_URL', parsed.baseUrl ?? parsed.url);
  setIfString(env, 'ANTHROPIC_AUTH_TOKEN', parsed.authToken ?? parsed.token ?? parsed.apiKey);
  setIfString(env, 'ANTHROPIC_MODEL', parsed.model);
  setIfString(env, 'ANTHROPIC_DEFAULT_FABLE_MODEL', parsed.fableModel);
  setIfString(env, 'ANTHROPIC_DEFAULT_OPUS_MODEL', parsed.opusModel);
  setIfString(env, 'ANTHROPIC_DEFAULT_SONNET_MODEL', parsed.sonnetModel);
  setIfString(env, 'ANTHROPIC_DEFAULT_HAIKU_MODEL', parsed.haikuModel);
  setIfString(env, 'CLAUDE_CODE_SUBAGENT_MODEL', parsed.subagentModel);
  setIfString(env, 'CLAUDE_CODE_EFFORT_LEVEL', parsed.effortLevel);

  const token = (env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || '').trim();
  if (!token || token === '<your DeepSeek API Key>') {
    throw new Error(
      `Deepseek (Claude Code) requires an API key. Edit ${DEEPSEEK_SETTINGS} and set env.ANTHROPIC_AUTH_TOKEN.`,
    );
  }
  env.ANTHROPIC_AUTH_TOKEN = token;
  delete env.ANTHROPIC_API_KEY;
  return env;
}

export function getDeepseekDefaultModel(): string | undefined {
  const env = loadDeepseekClaudeEnv();
  const model = env.ANTHROPIC_MODEL?.trim();
  return model || undefined;
}

function ensureDefaultSettingsFile(): void {
  if (existsSync(DEEPSEEK_SETTINGS)) return;
  mkdirSync(dirname(DEEPSEEK_SETTINGS), { recursive: true });
  const text = `${JSON.stringify({ env: DEFAULT_ENV }, null, 2)}\n`;
  const tmp = `${DEEPSEEK_SETTINGS}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, DEEPSEEK_SETTINGS);
  } finally {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
  }
}

function readSettingsFile(): DeepseekSettingsFile {
  try {
    const raw = readFileSync(DEEPSEEK_SETTINGS, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as DeepseekSettingsFile)
      : {};
  } catch (err) {
    throw new Error(
      `Failed to read Deepseek config ${DEEPSEEK_SETTINGS}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

function stringRecord(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

function setIfString(env: Record<string, string>, key: string, value: unknown): void {
  if (typeof value === 'string' && value.trim().length > 0) {
    env[key] = value.trim();
  }
}
