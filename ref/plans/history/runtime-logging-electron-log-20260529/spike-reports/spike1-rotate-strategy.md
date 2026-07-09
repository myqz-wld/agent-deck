# Spike (a) — electron-log rotate 策略实证

## 动机

RFC 第 2 轮选定 rotate 策略为「按天拆 + 保留 14 天」，但 electron-log 默认 rotate 是按文件大小（默认 5MB）触发 `archiveLog` hook，不是按天。Spike 验证：用 `resolvePathFn` 让每条 log 动态计算当天日期写入 `main-YYYY-MM-DD.log`，配合启动时跑一次 cleanup 删 14 天前的旧文件，是否能完全替代 archiveLog hook 实现按天拆。

## 假设

- 假设 1：`transports.file.resolvePathFn` 返回的路径会让每条 log 落到对应文件，无 startup 缓存
- 假设 2：cleanup 简单实现（`fs.readdir` + `fs.statSync(mtime)` + `fs.unlinkSync`）足够，无需 electron-log 内置 rotate
- 假设 3：`resolvePathFn` 内部抛错时 log 调用本身不传递错误（被 electron-log 内部 try/catch）

## 实测命令

```bash
cd /tmp/spike-electron-log-20260529
npm install electron-log@5
node spike-a-rotate.mjs > spike-a-rotate.log 2>&1
```

实测 electron-log 版本：5.4.4。runner / log 完整保留在 `runners/spike-a-rotate.{mjs,log}`。

## 实测结果

### 验证 1：resolvePathFn 按天落到不同文件 ✅

mockedNow 三次切日期（2026-05-29 / 2026-05-30 / 2026-05-31）+ `resolvePathFn` 动态返回 `main-${mockedDate}.log`，结果：
```
logs/ 目录内容: [ 'main-2026-05-29.log', 'main-2026-05-30.log', 'main-2026-05-31.log' ]

--- main-2026-05-29.log ---
[2026-05-29 18:05:26.775] [info]  day-1 message
--- main-2026-05-30.log ---
[2026-05-29 18:05:26.777] [info]  day-2 message
--- main-2026-05-31.log ---
[2026-05-29 18:05:26.777] [info]  day-3 message
```

**结论**：electron-log 5.4.4 内部 file transport 每条 log 都会调一次 `resolvePathFn`（不缓存），跨天写不同文件天然按天拆。

### 验证 2：cleanup 函数删 14 天前 ✅

人工 `fs.utimesSync` 制造两个老文件（30 天前 + 10 天前），跑 `cleanupOldLogs(LOG_DIR, 14)`：
```
cleanup 前: ['main-2026-04-29.log', 'main-2026-05-19.log', 'main-2026-05-29.log', 'main-2026-05-30.log', 'main-2026-05-31.log']
cleanup 删了 1 个文件
cleanup 后: ['main-2026-05-19.log', 'main-2026-05-29.log', 'main-2026-05-30.log', 'main-2026-05-31.log']
```

**结论**：30 天前文件被删，10 天前文件保留。简单 `mtime < cutoff` 判断足够。

### 验证 3：resolvePathFn 抛错时业务代码不挂 ✅

`resolvePathFn` 强制 throw，再调 `log.info(...)`：
```
Unhandled electron-log error Error: mocked resolvePathFn failure   # ← electron-log 内部 emit 到 stderr
    at log.transports.file.resolvePathFn (...)
    ...
log.info 不抛错（electron-log 内部 try/catch）
```

**结论**：`resolvePathFn` 内部抛错 electron-log 自己 catch，emit 到 stderr 但不 propagate 给业务调用方。**生产环境 logger init 出问题不会让主进程挂掉**。

### 验证 4：scope 行为 ✅

```
[2026-05-29 18:05:26.779] [info]  (sdk-bridge)          hello from sdk-bridge
[2026-05-29 18:05:26.779] [warn]  (lifecycle-scheduler) hello from lifecycle
[2026-05-29 18:05:26.779] [info]                        hello from root logger (no scope)
```

electron-log 5.x 默认 format 已经内置 scope，显示为 `(scope-name)` + padding 对齐。**不需要自定义 format 就能拿到「[level][scope] text」效果**（scope 占位用括号 + padding 而非 brackets）。

### 验证 5：自定义 format 含 `[{scope}]` ⚠️

```
[info] [ (sdk-bridge)         ] 2026-05-29 18:05:26.779 custom format test
[info] [                      ] 2026-05-29 18:05:26.779 no scope test
```

**踩坑**：自定义 format `[{level}][{scope}]` 时空 scope 显示 `[                      ]`（padded 空白，丑陋）。

**修法**：要么用 electron-log 默认 format（直接用 `(scope)` 占位）；要么改用 format function `format: ({ data, level, scope }) => \`[${level}]${scope ? '[' + scope + ']' : ''} ${data.join(' ')}\`` 处理空 scope 不带括号。

## 结论

✅ **resolvePathFn + 启动时 cleanup 完全替代 archiveLog hook**：

> ⚠️ **Round 1 fix M9 注脚**：spike runner（`runners/spike-a-rotate.mjs:11-16`）实测时用 `mockedNow.getUTCFullYear()` / `getUTCMonth()` / `getUTCDate()` (UTC time)，**这只是 spike 环境固定时区不影响实际行为**；下面 `todayStr()` 生产 sample 与 plan §设计决策 D3 落地用 `now.getFullYear()` / `getMonth()` / `getDate()` (**local time**) — user 看本地日期分类是直觉。跨时区切换时跨天歧义见 §残留风险 5（运行时观察，spike 环境无法实测）。

```typescript
// 简化版 logger 初始化伪代码（生产用 local time，非 spike runner UTC time）
import log from 'electron-log/main';
import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

const LOG_DIR = app.getPath('logs');

function todayStr() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

log.transports.file.resolvePathFn = () => path.join(LOG_DIR, `main-${todayStr()}.log`);
log.transports.file.level = 'info';
log.transports.console.level = 'silly';

// 启动时跑一次 cleanup
function cleanupOldLogs(dir: string, retentionDays: number) {
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
    } catch { /* ignore */ }
  }
  return deleted;
}

cleanupOldLogs(LOG_DIR, 14);
```

## 残留风险

1. **跨天「跨午夜」边界**：long-running process 在午夜跨天瞬间，旧日期文件最后一条 log 可能落在跨午夜后 0-100ms 内（resolvePathFn 在 log 调用时计算当天）。**可接受**：log 时间戳与文件日期偏移 ≤ 1 秒，debug 无影响。
2. **`resolvePathFn` 每条 log 调一次有开销**：每次构造 Date + format string。**实测开销可忽略**：连续写 3 条 log 总耗时 < 5ms（spike (a) log 时间戳 18:05:26.775 → .777）。
3. **cleanup 在 logger 启动时跑一次**：long-running 7 天以上的 .app 中间没机会再 cleanup。**轻度问题**：14 天保留实际可能变 21 天（启动后 7 天 + 启动时清掉 14 天前）。如要严格 14 天，可加 daily setInterval cleanup。**Plan 内决策：MVP 仅启动时清，setInterval 列入 known followup**。
4. **format 自定义需处理空 scope**：默认 format 已含 scope 显示，建议直接用默认 format 不再自定义（已 spike 验证默认 format `(scope)` 占位足够清晰）。
5. **macOS 时区**：resolvePathFn 用 `new Date()` 走系统本地时区，user 在不同时区切换会有跨天歧义。**可接受**：日志文件按本地日期分类是直觉的（user 跨时区看 log 时知道是「我那天」）。**Round 1 fix M9 注脚**：spike runner 本身用 UTC time (`getUTCFullYear` 等)，**没有真测过 local time 跨时区行为** — runner 等于固定一个时区跑；生产 logger.ts 走 local time 实际效果（user 在 UTC+8 → UTC-5 时区切换）需 Step 3.7.3 实际跑应用观察，spike 环境无法实测。

## 影响 plan §设计决策

| 原 design | spike 后修正 |
|---|---|
| 用 archiveLog hook 实现按天拆 + 14 天保留 | **改为 resolvePathFn + 启动时 cleanup**（更简单、无需薄包装 archiveLog） |
| format `[level][scope] text` | **沿用 electron-log 默认 format**（已含 `(scope)` 占位 + padding），不再自定义 |
| 文件名 `main.log` + 历史 archive | **文件名 `main-YYYY-MM-DD.log`**，无历史 archive 概念，每天一个文件 |
| Settings「清空当前 main.log」按钮 | **改为「清空今天的 main-YYYY-MM-DD.log」**，truncate 当天文件不删历史 |
