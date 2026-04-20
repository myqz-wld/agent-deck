/**
 * 让 SDK 子进程跑在「Electron 二进制以 Node 模式启动」的状态下。
 *
 * 背景：@anthropic-ai/claude-agent-sdk 默认 `executable: 'node'`，会直接 spawn `node`。
 * 但 macOS 上的 .app 通过 launchd 启动时 PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin`，
 * nvm / homebrew 装的 node 都不在里面 → spawn ENOENT → SDK throw → summarizer 全降级
 * （用户报告：装好的 .app 总结全是「最近 N 条事件」那种事件统计兜底）。
 *
 * dev 模式从 terminal 起，PATH 完整有 node，所以一直没暴露这个问题。
 *
 * 修法：用 `process.execPath`（指向 .app 主进程二进制）+ 设 ELECTRON_RUN_AS_NODE=1，
 * Electron 二进制自带的 Node runtime 就会被复用，零依赖系统 node、跨设备一致。
 *
 * 调用方把返回值合并到 `query({ options })` 即可。
 *
 * 关于 executable 的 type cast：SDK 的 .d.ts 把 executable 限制为 `'bun' | 'deno' | 'node'`
 * 联合，但运行时 sdk.mjs 直接 `spawn(executable, args)` —— 任意路径 string 都行，type
 * 只是 SDK 的便利约束。这里用 `as 'node'` 集中绕过，调用方拿到的就是合法 type。
 */
export function getSdkRuntimeOptions(): {
  executable: 'node';
  env: Record<string, string>;
} {
  const baseEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') baseEnv[k] = v;
  }
  return {
    executable: process.execPath as unknown as 'node',
    env: {
      ...baseEnv,
      ELECTRON_RUN_AS_NODE: '1',
    },
  };
}
