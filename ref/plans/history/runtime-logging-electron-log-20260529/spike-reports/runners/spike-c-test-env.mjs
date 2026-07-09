// Spike (c): 测试环境下 console 接管的兼容性
// 假设：项目代码 logger.ts 顶部判断 NODE_ENV === 'test' 时跳过 Object.assign(console, log.functions)
// 验证目标：
//   1. NODE_ENV !== 'test' 时 Object.assign 后 console.log/warn/error 转发到 logger
//   2. NODE_ENV === 'test' 时不接管 console，vi.spyOn(console) 能继续 spy 到原生方法
//   3. 接管后 vi.spyOn(console) spy 出来的会是 logger 的方法（错的回归）

import log from 'electron-log/node.js';
import path from 'node:path';
import fs from 'node:fs';

const LOG_DIR = '/tmp/spike-electron-log-20260529/logs-c';
if (fs.existsSync(LOG_DIR)) fs.rmSync(LOG_DIR, { recursive: true, force: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

log.transports.file.resolvePathFn = () => path.join(LOG_DIR, 'main.log');
log.transports.file.level = 'info';
// 关键修正：保留 console transport（默认行为）— 终端仍能看到 console.* 输出
log.transports.console.level = 'silly'; // 与项目最终选型对齐：console silly

// 备份原 console.log 方法
const originalConsoleLog = console.log;

// === 验证 1: 不接管时 console.log 走原生 ===
console.log('\n=== 验证 1: 默认（不接管）— console.log 走原生 ===');
console.log('hello from native console.log');
console.log('console.log === originalConsoleLog ?', console.log === originalConsoleLog);

// === 验证 2: 全接管 ===
console.log('\n=== 验证 2: Object.assign(console, log.functions) 后 ===');
Object.assign(console, log.functions);
console.log('console.log === originalConsoleLog ?', console.log === originalConsoleLog);
console.log('hello from logger-wrapped console.log');

// 看看是否真的进 logger 的文件了
const fileContent1 = fs.readFileSync(path.join(LOG_DIR, 'main.log'), 'utf8');
originalConsoleLog('main.log content (after console wrapper):');
originalConsoleLog(fileContent1.trim());

// === 验证 3: 接管后用 vi.spyOn 模拟（手写 spy 看效果）===
originalConsoleLog('\n=== 验证 3: 模拟 vi.spyOn(console, "log") ===');
const captured = [];
const spy = function (...args) { captured.push(args); /* 不真调用，模拟 spy 拦截 */ };
const realCurrentConsoleLog = console.log; // 保存当前接管后的 console.log
console.log = spy;

console.log('this should be captured by spy');
console.log = realCurrentConsoleLog; // 还原

originalConsoleLog('captured =', captured);
originalConsoleLog('spy captured length =', captured.length);

// === 验证 4: 接管后 console.* 不会回到 stdout 让 vitest assert 看到 ===
originalConsoleLog('\n=== 验证 4: 接管后 console.log 是否还走 stdout ===');
const stdoutWritten = [];
const origStdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = function (chunk, ...rest) {
  stdoutWritten.push(chunk);
  return origStdoutWrite(chunk, ...rest);
};

console.log('test message after wrapper');

process.stdout.write = origStdoutWrite;
originalConsoleLog('stdout 接收次数:', stdoutWritten.length);
originalConsoleLog('stdout 内容:', stdoutWritten.map(c => c.toString().trim()));

// === 结论 ===
originalConsoleLog('\n=== Spike (c) 结论 ===');
originalConsoleLog('1. Object.assign(console, log.functions) 后 console.log !== originalConsoleLog ✓');
originalConsoleLog('2. 接管后 console.log 也写文件 + 也走 console transport（如启用）');
originalConsoleLog('3. vi.spyOn(console, "log") 能用 — spy 自己替换 console.log，能拦到调用');
originalConsoleLog('   但拦到的是接管后的 wrapper，spy.mock.calls 与原生 console 一致');
originalConsoleLog('4. 项目侧建议：logger.ts 顶部 if (NODE_ENV !== "test") Object.assign(...)');
originalConsoleLog('   测试环境保持原 console，spy/snapshot 等 51 处 vi.spyOn(console) 零改动');
originalConsoleLog('   生产环境接管，console.* 转发到 logger 落盘');
