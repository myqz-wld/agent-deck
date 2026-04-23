/**
 * Codex SDK 动态加载器。
 *
 * 与 claude-code/sdk-loader.ts 同套路：`@openai/codex-sdk` 是 ESM-only
 * （package.json `"type": "module"`），Vite / electron-vite 静态分析阶段会把字面量
 * `import('@openai/codex-sdk')` 转译成 `require(...)`，对 ESM-only 包运行时报
 * `ERR_REQUIRE_ESM`。用 `new Function` 绕开静态分析，把动态 import 留到运行时。
 *
 * 单例 codexSdkPromise 保证多模块共享同一份 SDK module。
 */

export type CodexSdkModule = typeof import('@openai/codex-sdk');

const dynamicImport = new Function('s', 'return import(s)') as <T = unknown>(
  s: string,
) => Promise<T>;

let codexSdkPromise: Promise<CodexSdkModule> | null = null;

export async function loadCodexSdk(): Promise<CodexSdkModule> {
  if (!codexSdkPromise) {
    codexSdkPromise = dynamicImport<CodexSdkModule>('@openai/codex-sdk');
  }
  return codexSdkPromise;
}
