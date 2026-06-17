/**
 * Main 进程 logger (src/main/utils/logger.ts) — electron-log v5 封装
 *
 * Plan: runtime-logging-electron-log-20260529 §设计决策 D1-D15 + §不变量 1-10 实现。
 *
 * 行为:
 * - 落盘到 `app.getPath('logs')` (macOS = ~/Library/Logs/Agent Deck/main-YYYY-MM-DD.log)
 * - 按天拆 (resolvePathFn) + 启动时 cleanup 14 天前 (cleanupOldLogs)
 * - File transport level 'info' (Settings logLevel 改, setFileLevel exported)
 * - Console transport level 'silly' (永远不变, dev 终端看全部输出)
 * - main + renderer 全接管 console.* (NODE_ENV='test' 跳过保 vi.spyOn(console))
 * - log.errorHandler.startCatching() init 即跑 (uncaughtException + unhandledRejection 落盘)
 * - app.setName('Agent Deck') 让 dev/prod logs path 一致 (避免 dev 落 ~/Library/Logs/Electron/)
 *
 * §不变量 8: 仅 import electron-log + electron + node:*, 不 import 项目业务模块
 */

import { app } from 'electron';
import log from 'electron-log/main';
import path from 'node:path';
import fs from 'node:fs';

// electron-log v5 LogLevel(无 fatal,有 verbose): 'error' | 'warn' | 'info' | 'verbose' | 'debug' | 'silly'
// 注: 原 plan §D4 写「silly|debug|info|warn|error|fatal」是错的(electron-log type defs 实证)
export type LogLevel = 'error' | 'warn' | 'info' | 'verbose' | 'debug' | 'silly';

// M7: app.setName 必须在 app.getPath('logs') 之前调, 让 dev/prod 路径统一
// dev 模式 app.name 默认 'Electron' → ~/Library/Logs/Electron/ (撞 §不变量 1)
// 显式 setName 后 dev 路径与 prod (.app Info.plist CFBundleName='Agent Deck') 一致
app.setName('Agent Deck');

const LOG_DIR = app.getPath('logs');

// D3: 按天拆文件 (resolvePathFn 每条 log 调一次, 跨天天然落新文件)
function todayStr(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// D3 cleanup: 启动时跑一次, 删 mtime > 14 天的 main-*.log
function cleanupOldLogs(dir: string, retentionDays: number): number {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  if (!fs.existsSync(dir)) return 0;
  let deleted = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!f.startsWith('main-') || !f.endsWith('.log')) continue;
    const fp = path.join(dir, f);
    try {
      const stat = fs.statSync(fp);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(fp);
        deleted++;
      }
    } catch {
      // ignore (并发 cleanup / 文件被外部删 / 权限错)
    }
  }
  return deleted;
}

// D8: 初始化 IPC bridge (preload 注入 + renderer 端 import 'electron-log/renderer' 自动经 IPC 转发)
log.initialize();

// D3: 按天拆 + cleanup
log.transports.file.resolvePathFn = () => path.join(LOG_DIR, `main-${todayStr()}.log`);
cleanupOldLogs(LOG_DIR, 14);

// D4: file default 'info' (Settings logLevel 控制); console default 'silly' (固定不变)
log.transports.file.level = 'info';
log.transports.console.level = 'silly';

// D6: 默认 format 已含 (scope) padding, 不自定义 (避免空 scope 显示 padded 空白)

// D7: fatal hook init 即跑, 落盘 uncaughtException + unhandledRejection
// REVIEW_68 batch-2 [MED, reviewer-claude + reviewer-codex 双方独立提出]: electron-log
// errorHandler.handle() 只 logFn 落盘 + (默认) 弹模态 showErrorBox，**不 rethrow / 不 exit** →
// 注册 listener 后 main 进程在 uncaughtException 后带病续跑（DB 半写 / 多 SDK 子进程状态不一致
// 风险），且生产弹技术堆栈模态给普通用户。修法：(a) showDialog 仅 dev（生产不弹堆栈）；
// (b) electron-log 落盘后补一道 uncaughtException → app.exit(1) 恢复 Node 默认 fatal 退出语义
// （electron-log file transport 同步写，本 listener 在 electron-log listener 之后注册 → 先落盘后退出）。
// unhandledRejection 仅落盘不强退（避免单个 stray promise rejection 过激杀进程）。
log.errorHandler.startCatching({ showDialog: !app.isPackaged });
if (process.env.NODE_ENV !== 'test') {
  process.on('uncaughtException', () => {
    app.exit(1);
  });
}

// D5 + §不变量 2: main 端接管 console.* (NODE_ENV='test' 跳过保 vi.spyOn 兼容)
// §不变量 10: 守门只控接管动作, 不管 import side effect (那由 D15 vitest setupFiles 全局 mock 守门)
if (process.env.NODE_ENV !== 'test') {
  Object.assign(console, log.functions);
}

// D4 / Settings IPC handler 调: 改 logLevel 只更新 file transport, console 永远 silly
export function setFileLevel(level: LogLevel): void {
  log.transports.file.level = level;
}

/**
 * plan log-noise-and-disposed-20260603 §D2-revised-v2 (reviewer-codex R2 HIGH-1 修法):
 *
 * Electron framework (v33) 内部 webContents.send 链路有 native try/catch 吞 framework
 * 自身报错, 走 console.error 输出 'Error sending from webFrameMain: Error: Render
 * frame was disposed ...'。main 端 logger.ts:95 Object.assign(console, log.functions)
 * 接管 console.* → 14/14 日志样本全带该前缀(06-02 单日 14 次,5 天 18 次)。
 *
 * 修法: Logger 实例级 hook(`log.hooks` 数组, 见 electron-log v5 src/core/Logger.js:177
 * `this.hooks.reduce((msg, hook) => msg ? hook(msg, transFn, transName) : msg, ...)`),
 * 窄过滤 + 限定 transportName === 'file' + 同一次 log call 内双关键词同时命中返 false 丢该行。
 *
 * **关键陷阱(reviewer-codex R2 HIGH-1 实证)**:
 * - 早期修法装到 `log.transports.file.hooks` 错(Transport 实际无 hooks 字段,
 *   真实 logger pipeline 只在 Logger 实例级 `this.hooks` reduce,Transport 自己
 *   消费的是 `transforms` 而非 hooks — 详 d.ts `Logger.Hook[]` 在 `Logger.hooks`
 *   字段不在 FileTransport)。
 * - pass-through 必须**返回原 message**(不是 undefined / null) — reduce 短路
 *   语义是「`msg ? hook(...) : msg`」,返 truthy message 继续 reduce 链;返
 *   false 短路并最终跳过该 transport(`if (transformedMsg) transFn(...)`)。
 *
 * 锚点 'Error sending from webFrameMain' + 'Render frame was disposed' 同一次 log call
 * 同时命中才丢,防误吞其他 framework 错(单关键词已通过 case 锁定透传)。Electron
 * framework 真实形态是 `console.error('Error sending from webFrameMain: ', error)`,
 * 因此必须覆盖 prefix string + Error object 分布在不同 data 项的情况。
 */

interface FilterLogMessage {
  data: unknown[];
}

export function shouldDropWebFrameMainDisposedNoise(
  message: FilterLogMessage,
): boolean {
  let hasWebFrameMainPrefix = false;
  let hasDisposedError = false;
  for (const item of message.data) {
    const text =
      typeof item === 'string'
        ? item
        : item instanceof Error
          ? `${item.name}: ${item.message}`
          : '';
    if (!text) continue;
    if (
      text.includes('Error sending from webFrameMain')
    ) {
      hasWebFrameMainPrefix = true;
    }
    if (text.includes('Render frame was disposed')) {
      hasDisposedError = true;
    }
    if (hasWebFrameMainPrefix && hasDisposedError) return true;
  }
  return false; // 不丢
}

const webFrameMainDisposedNoiseHook = (
  message: FilterLogMessage,
  _transport: unknown,
  transportName?: string,
): FilterLogMessage | false => {
  // 限定 file transport 落盘过滤(console transport 不动 — dev 终端应保留)
  if (transportName !== 'file') return message;
  return shouldDropWebFrameMainDisposedNoise(message) ? false : message;
};

export function installWebFrameMainDisposedFileFilter(): void {
  // 装到 Logger 实例级 `log.hooks` (electron-log v5 d.ts:600-603, runtime Logger.js:177
  // `this.hooks.reduce(...)`)。同一 hook ref dedup 防 HMR / 重 init 重复加。
  // `log.hooks` 在 d.ts Logger.hooks 字段已声明为 Hook[];FilterLogMessage 与 LogMessage
  // 结构子集兼容(date/level 由 electron-log reduce 链补),此位置强转收窄到 Hook[]。
  const hooks = log.hooks as unknown as ((m: FilterLogMessage, t: unknown, n?: string) => FilterLogMessage | false)[];
  if (hooks.includes(webFrameMainDisposedNoiseHook)) return;
  hooks.push(webFrameMainDisposedNoiseHook);
}

installWebFrameMainDisposedFileFilter();

// Settings UI 显示日志路径 + 「在 Finder 中显示」用
export { LOG_DIR };

// Plan §Step 3.5.1 testing API: cleanupOldLogs + todayStr export 让单测可直接调验证 D3 行为
// (避免间接 mock LOG_DIR + 预创 fake 老文件复杂 setup). 业务模块不应调用这两个 export.
export { cleanupOldLogs, todayStr };

// D12: 业务模块 const logger = log.scope('<kebab-case-name>') 拿 scoped logger
// 用法示例 (业务模块):
//   import log from '@main/utils/logger';
//   const logger = log.scope('sdk-bridge');
//   logger.info('hello'); // → [info] (sdk-bridge) hello
export default log;
