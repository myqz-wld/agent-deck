// Spike (a): 按天拆 + 保留 14 天 — 使用 electron-log/node.js entry（Node 端不依赖 Electron）
import log from 'electron-log/node.js';
import path from 'node:path';
import fs from 'node:fs';

const LOG_DIR = '/tmp/spike-electron-log-20260529/logs';
if (fs.existsSync(LOG_DIR)) fs.rmSync(LOG_DIR, { recursive: true, force: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

let mockedNow = new Date('2026-05-29T10:00:00Z');
function mockToday() {
  const y = mockedNow.getUTCFullYear();
  const m = String(mockedNow.getUTCMonth() + 1).padStart(2, '0');
  const d = String(mockedNow.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

log.transports.file.resolvePathFn = () => path.join(LOG_DIR, `main-${mockToday()}.log`);
log.transports.file.level = 'info';
log.transports.console.level = false;

log.info('day-1 message');
mockedNow = new Date('2026-05-30T10:00:00Z');
log.info('day-2 message');
mockedNow = new Date('2026-05-31T10:00:00Z');
log.info('day-3 message');

console.log('\n=== 验证 1: resolvePathFn 是否落到不同文件 ===');
const files = fs.readdirSync(LOG_DIR).sort();
console.log('logs/ 目录内容:', files);
for (const f of files) {
  const content = fs.readFileSync(path.join(LOG_DIR, f), 'utf8');
  console.log(`\n--- ${f} ---`);
  console.log(content.trim());
}

console.log('\n=== 验证 2: cleanup 函数删 14 天前的 ===');
const oldFile = path.join(LOG_DIR, 'main-2026-04-29.log');
fs.writeFileSync(oldFile, 'old content');
const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
fs.utimesSync(oldFile, thirtyDaysAgo, thirtyDaysAgo);

const recentFile = path.join(LOG_DIR, 'main-2026-05-19.log');
fs.writeFileSync(recentFile, 'recent content');
const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
fs.utimesSync(recentFile, tenDaysAgo, tenDaysAgo);

console.log('cleanup 前:', fs.readdirSync(LOG_DIR).sort());

function cleanupOldLogs(dir, retentionDays) {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let deleted = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!f.startsWith('main-') || !f.endsWith('.log')) continue;
    const fp = path.join(dir, f);
    const stat = fs.statSync(fp);
    if (stat.mtimeMs < cutoff) {
      fs.unlinkSync(fp);
      deleted++;
    }
  }
  return deleted;
}

const deleted = cleanupOldLogs(LOG_DIR, 14);
console.log(`cleanup 删了 ${deleted} 个文件`);
console.log('cleanup 后:', fs.readdirSync(LOG_DIR).sort());

console.log('\n=== 验证 3: resolvePathFn 抛错时 log.info 行为 ===');
log.transports.file.resolvePathFn = () => {
  throw new Error('mocked resolvePathFn failure');
};
try {
  log.info('after-error message');
  console.log('log.info 不抛错（electron-log 内部 try/catch）');
} catch (e) {
  console.log('log.info 抛错:', e.message);
}

console.log('\n=== 验证 4: scope 行为 ===');
log.transports.file.resolvePathFn = () => path.join(LOG_DIR, `main-2026-06-01.log`);
const sdkBridgeLog = log.scope('sdk-bridge');
const lifecycleLog = log.scope('lifecycle-scheduler');
sdkBridgeLog.info('hello from sdk-bridge');
lifecycleLog.warn('hello from lifecycle');
log.info('hello from root logger (no scope)');

const scopedFile = path.join(LOG_DIR, 'main-2026-06-01.log');
console.log(`\n--- ${scopedFile} ---`);
console.log(fs.readFileSync(scopedFile, 'utf8').trim());

console.log('\n=== 验证 5: format 自定义 ===');
log.transports.file.format = '[{level}][{scope}] {y}-{m}-{d} {h}:{i}:{s}.{ms} {text}';
log.transports.file.resolvePathFn = () => path.join(LOG_DIR, `main-2026-06-02.log`);
log.scope('sdk-bridge').info('custom format test');
log.info('no scope test');

console.log('\n--- main-2026-06-02.log ---');
console.log(fs.readFileSync(path.join(LOG_DIR, 'main-2026-06-02.log'), 'utf8').trim());

console.log('\n=== Spike (a) 完成 ===');
