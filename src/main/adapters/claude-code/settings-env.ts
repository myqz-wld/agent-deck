import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 把 ~/.claude/settings.json 的 `env` 字段强制覆盖到当前进程 env。
 *
 * 背景：Claude Agent SDK 内部 spawn `claude` CLI 子进程，env 继承自 process.env。
 * 用户通常在 settings.json 里配置代理（ANTHROPIC_BASE_URL）+ Bearer token
 * （ANTHROPIC_AUTH_TOKEN）等，CLI 自己也会读这份文件，但如果 shell 里有冲突的
 * 旧 env 或 SDK 自己的 env 隔离，就可能拿到错误凭证导致 Invalid API key。
 *
 * 这里在 bootstrap 时显式注入一次，让 settings.json 成为单一可信源。
 */
export function applyClaudeSettingsEnv(): void {
  const path = join(homedir(), '.claude', 'settings.json');
  if (!existsSync(path)) return;
  try {
    const raw = readFileSync(path, 'utf8');
    const json = JSON.parse(raw) as { env?: Record<string, string> };
    if (!json.env || typeof json.env !== 'object') return;
    let count = 0;
    for (const [k, v] of Object.entries(json.env)) {
      if (typeof v !== 'string') continue;
      process.env[k] = v;
      count += 1;
    }
    if (count > 0) {
      console.log(`[settings-env] applied ${count} env vars from ~/.claude/settings.json`);
    }
  } catch (err) {
    console.warn('[settings-env] failed to load ~/.claude/settings.json:', (err as Error).message);
  }
}
