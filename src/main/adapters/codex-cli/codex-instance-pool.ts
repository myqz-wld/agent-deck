/**
 * Codex SDK 实例 pool — 仅服务 oneshot LLM caller（summarizer-runner / handoff-runner）。
 *
 * **scope（重要 — 与 sdk-bridge live cache 不重叠）**：
 * - 本 pool 仅给 oneshot caller 用：`@main/adapters/codex-cli/summarizer-runner.ts` +
 *   `@main/adapters/codex-cli/handoff-runner.ts`（两处都直接 `getCodexInstance()`）
 * - **不**服务 `adapters/codex-cli/sdk-bridge/index.ts` 的 live session bridge — bridge 自带
 *   `private codex` + `ensureCodex()`，因为 live bridge 实例化 Codex 时需要按 settings + hookServer
 *   动态拼 `mcp_servers.agent-deck.url` config 注入（详 sdk-bridge/index.ts:131-141），本 pool
 *   接口仅接受 codexPathOverride 不接受 `config`，bridge 不能用 pool
 *
 * 两套 cache 实质需求不同（oneshot 不需要 mcp，live bridge 必须 mcp），不强行合并；
 * 但 path 失效信号统一：`setCodexCliPath` 既清 bridge.codex 也调 invalidateCodexInstance()
 * （详 sdk-bridge/index.ts:99-105），让 settings 改 path 后两侧下次 call 都重建实例。
 *
 * **抽出动机**（R37 P1 Step 1.2 / G）：
 * 原本 oneshot 两处（summarizer-runner / handoff-runner）各自维护 module-level cache 镜像，
 * 行为零差异。收口到本 pool 让 path 改时一处 invalidate 同步所有 oneshot caller。
 *
 * **Codex 实例本身轻量**（lightweight handle）— 真正 spawn 子进程是 startThread() 时才发生。
 * 共享 1 个 instance 等价于让 oneshot caller 共享同款 SDK config（codexPathOverride），不会因为
 * 共享造成跨用途 lifecycle 干扰（每个 thread 独立、Codex 实例只是 thread 工厂）。
 *
 * **bundled rg helper PATH（与 ensureCodex 的差异，刻意不补）**：codexPathOverride 短路 SDK
 * resolve → SDK 不注入 bundled `codex-path/rg`（详 codex-binary.ts §pathDirs）。live bridge 的
 * ensureCodex 会 `prependBundledCodexPathDirs` 补回；本 pool **不补** —— oneshot caller
 * （summarizer 出文字总结 / handoff 起接力 prompt）不触发 codex 的 rg-依赖功能（文件搜索类），
 * 且本 pool 不传 `env`（子进程继承 process.env，系统装了 rg 时仍可用）。如未来 oneshot caller
 * 需要 rg，改走传 env + prependBundledCodexPathDirs（issue 8c116860 同款修法）。
 */
import type { Codex } from '@openai/codex-sdk';
import { settingsStore } from '@main/store/settings-store';
import { loadCodexSdk } from '@main/adapters/codex-cli/sdk-loader';
import { resolveBundledCodexBinary } from '@main/adapters/codex-cli/sdk-bridge/codex-binary';

let cachedCodex: Codex | null = null;
let cachedPath: string | null = null;

/**
 * 拿（或懒创建）oneshot caller 共享的 codex 实例。当前 codex 二进制路径取自 settings.codexCliPath
 * （IPC setCodexCliPath 路径同步写）/ 缺省 `resolveBundledCodexBinary()`（打包内置 unpacked 路径）。
 *
 * settings.codexCliPath 改了 → 旧实例失效 → 下次 call 重建。这层 path 检查每次调用都执行
 * （单同步读 settingsStore + 同步 fs.existsSync，开销可忽略），不需要 IPC push 主动 invalidate；
 * 但 IPC setCodexCliPath 仍可显式调 `invalidateCodexInstance()` 作为提示性 invalidation
 * （让下次 call 立刻进 sdk re-load 路径，不等惰性 path mismatch）。
 *
 * 不接受 mcp_servers config 注入 — live session bridge 需要 mcp 注入因此自带
 * `private codex` cache（详 `sdk-bridge/index.ts:131-141`），不走本 pool。
 */
export async function getCodexInstance(): Promise<Codex> {
  const path = settingsStore.get('codexCliPath');
  const overridePath = (path && path.trim()) || resolveBundledCodexBinary();
  if (cachedCodex && cachedPath === overridePath) return cachedCodex;
  const sdk = await loadCodexSdk();
  cachedCodex = new sdk.Codex(overridePath ? { codexPathOverride: overridePath } : {});
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
  cachedCodex = null;
  cachedPath = null;
}
