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

// D7: fatal hook init 即跑, 覆盖 uncaughtException + unhandledRejection
log.errorHandler.startCatching();

// D5 + §不变量 2: main 端接管 console.* (NODE_ENV='test' 跳过保 vi.spyOn 兼容)
// §不变量 10: 守门只控接管动作, 不管 import side effect (那由 D15 vitest setupFiles 全局 mock 守门)
if (process.env.NODE_ENV !== 'test') {
  Object.assign(console, log.functions);
}

// D4 / Settings IPC handler 调: 改 logLevel 只更新 file transport, console 永远 silly
export function setFileLevel(level: LogLevel): void {
  log.transports.file.level = level;
}

// Settings UI 显示日志路径 + 「在 Finder 中显示」用
export { LOG_DIR };

// D12: 业务模块 const logger = log.scope('<kebab-case-name>') 拿 scoped logger
// 用法示例 (业务模块):
//   import log from '@main/utils/logger';
//   const logger = log.scope('sdk-bridge');
//   logger.info('hello'); // → [info] (sdk-bridge) hello
export default log;
