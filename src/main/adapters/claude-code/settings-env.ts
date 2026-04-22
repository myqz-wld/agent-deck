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
 *
 * 安全：不再无差别注入。任何写过 ~/.claude/settings.json 的工具 / 项目模板都能塞
 * `NODE_OPTIONS=--inspect=0.0.0.0:9229` / `NODE_TLS_REJECT_UNAUTHORIZED=0` /
 * `PATH=/tmp/evil:...` / `ELECTRON_RUN_AS_NODE=1` 进去；后续 sdk-runtime 又把
 * process.env 整体复制给 SDK 子进程，整条信任链被污染。
 *
 * 白名单只放鉴权 / 模型 / 代理这三类，足够 Claude Code 正常工作；其它键统一拒绝并 warn。
 */

/** 前缀白名单：Anthropic / Claude 自家变量族 */
const ALLOWED_PREFIXES = ['ANTHROPIC_', 'CLAUDE_'];

/** 完全匹配白名单：标准代理 / 网络变量（大小写两种形式） */
const ALLOWED_KEYS = new Set<string>([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
]);

function isAllowed(key: string): boolean {
  if (ALLOWED_KEYS.has(key)) return true;
  return ALLOWED_PREFIXES.some((p) => key.startsWith(p));
}

export function applyClaudeSettingsEnv(): void {
  const path = join(homedir(), '.claude', 'settings.json');
  if (!existsSync(path)) return;
  try {
    const raw = readFileSync(path, 'utf8');
    const json = JSON.parse(raw) as { env?: Record<string, string> };
    if (!json.env || typeof json.env !== 'object') return;
    let applied = 0;
    let rejected = 0;
    for (const [k, v] of Object.entries(json.env)) {
      if (typeof v !== 'string') continue;
      if (!isAllowed(k)) {
        console.warn(`[settings-env] reject "${k}": not in whitelist (only ANTHROPIC_*/CLAUDE_*/proxy vars)`);
        rejected += 1;
        continue;
      }
      process.env[k] = v;
      applied += 1;
    }
    if (applied > 0 || rejected > 0) {
      console.log(
        `[settings-env] applied ${applied} env vars from ~/.claude/settings.json` +
          (rejected > 0 ? ` (rejected ${rejected} non-whitelisted)` : ''),
      );
    }
  } catch (err) {
    console.warn('[settings-env] failed to load ~/.claude/settings.json:', (err as Error).message);
  }
}
