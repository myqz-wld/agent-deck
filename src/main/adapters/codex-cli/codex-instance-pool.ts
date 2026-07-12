/**
 * Codex app-server client pool — 服务周期总结与 Continuation Context compactor oneshot caller。
 *
 * live session bridge 需要 per-session MCP token/config，仍由 sdk-bridge 自己持 per-session
 * client；本 pool 不挂 MCP，仅复用同一个 app-server stdio 进程给 oneshot thread 工厂使用。
 */
import { CodexAppServerClient } from '@main/adapters/codex-cli/app-server/client';
import { settingsStore } from '@main/store/settings-store';

let cachedCodex: CodexAppServerClient | null = null;
let cachedPath: string | null = null;

function snapshotProcessEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) out[k] = v;
  }
  out.AGENT_DECK_ORIGIN = 'sdk';
  return out;
}

/**
 * 拿（或懒创建）oneshot caller 共享的 codex app-server client。当前 codex 二进制路径取自
 * settings.codexCliPath；缺省交给 CodexAppServerClient resolveCodexBinary()，dev 和打包路径统一。
 *
 * settings.codexCliPath 改了 → 旧 client 失效并 dispose → 下次 call 重建。这层 path 检查每次调用都执行
 * （单同步读 settingsStore，开销可忽略），不需要 IPC push 主动 invalidate；
 * 但 IPC setCodexCliPath 仍可显式调 `invalidateCodexInstance()` 作为提示性 invalidation
 * （让下次 call 立刻进 app-server 重建路径，不等惰性 path mismatch）。
 *
 * 不接受 mcp_servers config 注入 — live session bridge 需要 mcp 注入因此自带
 * `private codex` cache（详 `sdk-bridge/index.ts:131-141`），不走本 pool。
 */
export async function getCodexInstance(): Promise<CodexAppServerClient> {
  const path = settingsStore.get('codexCliPath');
  const overridePath = (path && path.trim()) || null;
  if (cachedCodex && cachedPath === overridePath) return cachedCodex;
  cachedCodex?.dispose();
  cachedCodex = new CodexAppServerClient({
    codexPathOverride: overridePath,
    config: null,
    env: snapshotProcessEnv(),
  });
  cachedPath = overridePath;
  return cachedCodex;
}

/**
 * 主动让 pool 失效。sdk-bridge.setCodexCliPath / IPC handler 改 path 时调，让下次
 * `getCodexInstance()` 不依赖 path 比较快速感知变更。
 *
 * 不调也行（getCodexInstance 内部 path 比较会兜底），但显式调能让「设置面板改 path
 * → 在跑的 oneshot summary / hand-off 不会复用旧实例」更直观。
 */
export function invalidateCodexInstance(): void {
  cachedCodex?.dispose();
  cachedCodex = null;
  cachedPath = null;
}
