/**
 * 让 SDK 子进程跑在「Electron 二进制以 Node 模式启动」的状态下 + 解析 native binary 路径。
 *
 * ## getSdkRuntimeOptions：executable + env
 *
 * 0.1.x SDK 通过 `executable: 'node'` spawn 一个 cli.js 脚本，executable 起作用。
 * macOS .app 走 launchd 启动时 PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin`，nvm/homebrew
 * 装的 node 都不在里面 → spawn ENOENT。修法用 `process.execPath`（指向 .app 主进程二进制）+
 * 设 ELECTRON_RUN_AS_NODE=1，复用 Electron 内置 Node runtime。
 *
 * 0.2.x SDK 把 `cli.js` 拆成 native binary（platform-specific npm 包），SDK 内部
 * `K7()` 通过 `require.resolve('@anthropic-ai/claude-agent-sdk-${plat}-${arch}/claude')`
 * 拿到 binary 路径直接 spawn —— **executable 完全被绕过**（j8 = isBinary → command = binary）。
 * 所以 `executable: process.execPath` 在 0.2.x 实际不起作用，但保留无害（万一未来某条
 * fallback 路径还会用到 executable，不至于落到 'node' alias）。
 *
 * ## getPathToClaudeCodeExecutable：解决 ENOTDIR
 *
 * SDK 自己的 K7() 通过 `require.resolve` 拿到的 binary 路径在 .app 里是
 *   `/Applications/Agent Deck.app/Contents/Resources/app.asar/node_modules/.../claude`
 * Electron fs patch 让 `existsSync`/`statSync` 透明回退到 `app.asar.unpacked/`，
 * 但 `child_process.spawn` 走系统 `posix_spawn` syscall **不经过 fs patch**，看到
 * `app.asar` 是文件而非目录 → spawn ENOTDIR → summarizer 100% 走兜底 / 应用内
 * SDK 会话发消息全死。
 *
 * 修法：手动复刻 K7 的解析逻辑（含 linux musl 优先），把 `app.asar` 路径段替换成
 * `app.asar.unpacked` 路径段，把结果显式传给 `query({ pathToClaudeCodeExecutable })`，
 * 绕开 SDK 自己的 K7。dev 模式 `require.resolve` 返回真实 node_modules 路径不含 asar，
 * replace 是 no-op，无副作用。
 *
 * 注：electron-builder 已经自动把 native binary 包识别并 unpack 到 app.asar.unpacked/，
 * 但 package.json 也显式 asarUnpack 把 `@anthropic-ai/claude-agent-sdk-` 系列 native 包
 * 全量加入硬化（防止 builder 未来识别启发式变化）。
 */

import {
  getPathToClaudeCodeExecutableCore,
  getSdkRuntimeOptionsCore,
} from './sdk-runtime-core';
import { desktopClaudeSdkRuntimeHost } from './sdk-runtime-host';

export function getSdkRuntimeOptions(): {
  executable: 'node';
  env: Record<string, string>;
} {
  return getSdkRuntimeOptionsCore(desktopClaudeSdkRuntimeHost);
}

/**
 * 复刻 SDK 内部 K7 的 native binary 包解析顺序：
 *   - linux: 先试 `-musl` 后缀（Alpine 等），再试 glibc
 *   - darwin / win32：单包
 *   - win32 binary 名 `claude.exe`，其余 `claude`
 *
 * 找到后把路径里的 `app.asar` 路径段（前后必须是 `/` 或 `\`）替换成 `app.asar.unpacked`，
 * 让 `child_process.spawn` 能直接命中 unpack 出来的真实文件。
 *
 * 返回 undefined 时 SDK 会走默认 K7 → 在打包应用里会报 ENOTDIR。dev 模式 require.resolve
 * 直接命中真实 node_modules 路径，replace 是 no-op，工作正常。
 */
export function getPathToClaudeCodeExecutable(): string | undefined {
  return getPathToClaudeCodeExecutableCore(desktopClaudeSdkRuntimeHost);
}
