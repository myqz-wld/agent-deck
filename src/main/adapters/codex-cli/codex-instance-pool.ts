/**
 * Codex SDK 实例 pool（R37 P1 Step 1.2 / G）— 应用全局唯一 codex 实例。
 *
 * **抽出动机**（reviewer-claude F1[HIGH] + grep 实证）：
 * 原本 3 处独立维护「懒创建 + 按 codexCliPath 缓存 Codex 实例」逻辑：
 * - `adapters/codex-cli/sdk-bridge/index.ts:80` instance field `private codex` + `ensureCodex()`
 * - `adapters/codex-cli/summarizer-runner.ts:29` module-level `cachedCodex` / `cachedPath` / `ensureCodex()`
 * - `adapters/codex-cli/handoff-runner.ts:31` 同款 module-level（注释明示「与 summarizer-runner 完全字面对称」）
 *
 * 三处行为差异为 0（都是 `if cachedCodex && cachedPath === overridePath return cachedCodex；
 * else loadCodexSdk + new sdk.Codex(...)`），仅 codexCliPath 来源差异：sdk-bridge 用 instance
 * field（IPC setCodexCliPath 同步 push），两 runner 直接 `settingsStore.get('codexCliPath')`。
 * 但 setCodexCliPath 内部就是写 settingsStore，两者最终值等价 — 三处独立缓存等于让 path 改变
 * 时 3 个 cache 各自 miss 才同步。
 *
 * **本 pool 收益**：
 * 1. 一处缓存，path 改时 invalidate 一次所有 caller 同步生效
 * 2. sdk-bridge 不再需要 `private codex` field + `private codexCliPath` field（可删）
 * 3. 节省 sdk-loader 重复加载（spike-A3 实测共享单实例 ~44 MB RSS，3 路独立缓存可能各起一份）
 * 4. 未来加新 codex oneshot 用例（如 batch summarizer / 第 4 种 LLM 调用）零模板压力
 *
 * **Codex 实例本身轻量**（lightweight handle）— 真正 spawn 子进程是 startThread() 时才发生。
 * 共享 1 个 instance 等价于让所有 caller 共享同款 SDK config（codexPathOverride），不会因为
 * 共享造成跨用途 lifecycle 干扰（每个 thread 独立、Codex 实例只是 thread 工厂）。
 */
import type { Codex } from '@openai/codex-sdk';
import { settingsStore } from '@main/store/settings-store';
import { loadCodexSdk } from '@main/adapters/codex-cli/sdk-loader';
import { resolveBundledCodexBinary } from '@main/adapters/codex-cli/sdk-bridge/codex-binary';

let cachedCodex: Codex | null = null;
let cachedPath: string | null = null;

/**
 * 拿（或懒创建）应用全局唯一 codex 实例。当前 codex 二进制路径取自 settings.codexCliPath
 * （IPC setCodexCliPath 路径同步写）/ 缺省 `resolveBundledCodexBinary()`（打包内置 unpacked 路径）。
 *
 * settings.codexCliPath 改了 → 旧实例失效 → 下次 call 重建。这层 path 检查每次调用都执行
 * （单同步读 settingsStore + 同步 fs.existsSync，开销可忽略），不需要 IPC push 主动 invalidate；
 * 但 IPC setCodexCliPath 仍可显式调 `invalidateCodexInstance()` 作为提示性 invalidation
 * （让下次 call 立刻进 sdk re-load 路径，不等惰性 path mismatch）。
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
