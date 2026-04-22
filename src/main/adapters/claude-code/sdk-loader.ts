/**
 * 共享 SDK 动态加载器。
 *
 * 为什么用 `new Function('s', 'return import(s)')`：
 * - `@anthropic-ai/claude-agent-sdk` 是 ESM-only 包。
 * - Vite / electron-vite 在静态分析阶段会把字面量 `import('@anthropic-ai/...')`
 *   转译成 `require('@anthropic-ai/...')`，对 ESM-only 包会运行时报
 *   `ERR_REQUIRE_ESM`。
 * - 用 `new Function` 绕过静态分析，让真正的动态 import 留到运行时执行。
 *
 * 此前 sdk-bridge.ts 与 summarizer.ts 各自实现了一份完全相同的 loader，
 * 抽到这里统一管：单例 sdkPromise，跨模块共享，避免两份独立的"首次加载"
 * 状态分裂（V8 module cache 会去重，但 Promise 状态不共享）。
 */

export type SdkModule = typeof import('@anthropic-ai/claude-agent-sdk');

const dynamicImport = new Function('s', 'return import(s)') as <T = unknown>(
  s: string,
) => Promise<T>;

let sdkPromise: Promise<SdkModule> | null = null;

export async function loadSdk(): Promise<SdkModule> {
  if (!sdkPromise) {
    sdkPromise = dynamicImport<SdkModule>('@anthropic-ai/claude-agent-sdk');
  }
  return sdkPromise;
}
