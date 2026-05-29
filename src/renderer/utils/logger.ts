/**
 * Renderer 进程 logger (src/renderer/utils/logger.ts) — electron-log v5 renderer 入口封装
 *
 * Plan: runtime-logging-electron-log-20260529 §设计决策 D5 + D8 + §不变量 3 实现。
 *
 * 行为:
 * - `electron-log/renderer` 入口顶层不 require electron (D15 §mock 范围明确实证),
 *   vitest node env 可安全 import 不需 mock
 * - 通过 electron-log 内部 IPC bridge 把 log 转发到 main 进程, 落进同一份
 *   `~/Library/Logs/Agent Deck/main-YYYY-MM-DD.log` (D8 — main logger.ts 调
 *   `log.initialize()` 自动注入 preload script + 设 `__electronLog.sendToMain`)
 * - 接管 console.* (NODE_ENV/MODE 'test' 跳过保 vi.spyOn(console))
 *   - renderer 端用 `import.meta.env.MODE` (vite 注入 env, 无 process.env — §不变量 3)
 *
 * §不变量 8: 仅 import electron-log + vite env, 不 import 项目业务模块
 */

import log from 'electron-log/renderer';

/**
 * 守门纯函数 — 决定本进程是否应接管 console.* 转发到 logger
 *
 * Plan §D5 + §Step 3.0.3 修订（R2-9: 一次性抽出, 不再 Step 3.5.1.5 二改）:
 * - 'test' → false (保留原生 console 让 vi.spyOn 拦截)
 * - 'development' / 'production' / 其他 → true (接管)
 * - undefined → true (默认接管, 兜底未注入 vite env 的边角场景)
 *
 * @param mode 传入 `import.meta.env.MODE` (vite 注入), 测试时可传任意字符串验证守门
 * @returns true = 应接管 console, false = 跳过
 */
export function shouldCaptureRendererConsole(mode: string | undefined): boolean {
  return mode !== 'test';
}

// D5 + §不变量 3: renderer 端接管 console (vite MODE='test' 跳过保 vi.spyOn 兼容)
if (shouldCaptureRendererConsole(import.meta.env.MODE)) {
  Object.assign(console, log.functions);
}

// D12: 业务模块 const logger = log.scope('<kebab-case-name>') 拿 scoped logger
// 用法示例 (renderer 业务模块):
//   import log from '@renderer/utils/logger';
//   const logger = log.scope('session-detail');
//   logger.info('hello'); // → IPC bridge → main → file: [info] (session-detail) hello
export default log;
