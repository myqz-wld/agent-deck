# Spike (c) — NODE_ENV='test' 跳过 console 接管的可行性

## 动机

RFC 第 3 轮决策：「main + renderer 都全接管 console.*，NODE_ENV === 'test' 时跳过接管」让现有 51 处 `vi.spyOn(console, 'log/warn/error')` 零改动。Spike 验证：

1. NODE_ENV !== 'test' 时 `Object.assign(console, log.functions)` 后 console.* 转发到 logger 写文件 + 仍走 stdout（dev DX 不丢）
2. NODE_ENV === 'test' 时跳过接管，原生 console 保持，`vi.spyOn(console, 'log')` 仍能拦截
3. 接管后 `vi.spyOn(console, 'log')` 拦到的是 logger wrapper 还是原生

## 假设

- 假设 1：`Object.assign(console, log.functions)` 直接替换 console 的方法 reference，可被 `vi.spyOn` 再次替换
- 假设 2：electron-log console transport 保持启用（`level: 'silly'`）时，接管后 console.* 仍写 stdout
- 假设 3：测试环境跳过接管后，vi.spyOn 行为完全等同未引入 logger 前

## 实测命令

```bash
node spike-c-test-env.mjs > spike-c-test-env.log 2>&1
```

runner / log 保留在 `runners/spike-c-test-env.{mjs,log}`。

## 实测结果

### 验证 1：默认（未接管）console.log === originalConsoleLog ✅

```
hello from native console.log
console.log === originalConsoleLog ? true
```

未调 `Object.assign(console, log.functions)` 前，console.log 就是原生。

### 验证 2：接管后 console.log !== originalConsoleLog ✅

```
18:06:17.325 › console.log === originalConsoleLog ? false
18:06:17.327 › hello from logger-wrapped console.log
main.log content (after console wrapper):
[2026-05-29 18:06:17.325] [info]  console.log === originalConsoleLog ? false
[2026-05-29 18:06:17.327] [info]  hello from logger-wrapped console.log
```

`Object.assign(console, log.functions)` 后：
- console.log 被替换为 logger wrapper（reference 改变）
- 调用 `console.log(...)` 既写文件（main.log 有内容）
- 也走 console transport（stdout 出现 `18:06:17.325 › ...` 简化 format）

### 验证 3：vi.spyOn 模拟拦截能用 ✅

```
captured = [ [ 'this should be captured by spy' ] ]
spy captured length = 1
```

手写 `console.log = spy` 替换接管后的 wrapper，调用 `console.log(...)` 后 spy 数组拿到 args。**vi.spyOn 完全可用**（vi.spyOn 内部就是这样替换 + 还原）。

注意：spy 替换的是 logger wrapper（not 原生 console.log），但行为一致 — spy.mock.calls 收到的 args 与原生 console.log 收到的相同（因为 wrapper 只是中转）。

### 验证 4：接管后 console.log 仍走 stdout ✅

```
18:06:17.328 › test message after wrapper
stdout 接收次数: 1
stdout 内容: [ '18:06:17.328 › test message after wrapper' ]
```

`process.stdout.write` 被 monkey-patch 截听，接管后调 `console.log(...)`：
- stdout 接收 1 次（logger console transport 写到 stdout）
- 内容是 logger 格式化后的 `HH:MM:SS.mmm › <text>`

**关键点**：接管不吞 stdout，dev mode 下 user 跑 `pnpm dev` **仍能在终端看到 console.log 输出**，与未引入 logger 前 DX 一致。

## 结论

✅ **三个核心假设全部验证通过**：

```typescript
// 简化版 logger 初始化伪代码（main 进程）
import log from 'electron-log/main';

// ... 其他初始化（resolvePathFn / format / fatal hook 等）

if (process.env.NODE_ENV !== 'test') {
  // 生产 + dev 模式：接管 console.* → 写文件 + 走 stdout
  Object.assign(console, log.functions);
}
// 测试模式：保持原生 console，51 处 vi.spyOn(console) 零改动
```

## 残留风险

1. **vi.spyOn 在已接管的 console 上工作**：如果某个测试**先**让 logger 接管了 console 再 spy，spy 拦到的是 wrapper 不是原生。这破坏「测试环境保持原生」承诺。**修法**：logger 初始化要在 test setup 之前完成,且条件判断 NODE_ENV === 'test' 跳过接管。**bootstrap 顺序约束**：logger 模块 import 即跑接管,任何 vitest setup file 都在 import 之后,**只要 NODE_ENV === 'test' 时不接管,vi.spyOn 永远拦到原生**。
2. **NODE_ENV 默认值**：vitest 默认会 set `NODE_ENV=test`（vitest doc 明文），但用户如自定义 `vitest.config.ts` 改了可能撞 bug。**Plan 加单元测试**：写 1 个 test 显式 assert `console.log === originalConsoleLog` 监测此回归。
3. **renderer 端的 console 接管时机**：renderer 端要 `import log from 'electron-log/renderer'`，再 `Object.assign(console, log.functions)` 在 main.tsx 顶部跑。renderer 没 NODE_ENV 概念（除非 vite 注入 `import.meta.env.MODE`）— 改用 `import.meta.env.MODE !== 'test'` 判断。**Plan §设计决策注脚**。
4. **接管后 stdout 输出 format 与 file 不同**：stdout 看到的是 `HH:MM:SS.mmm › text`（electron-log console transport 默认），file 是 `[YYYY-MM-DD HH:MM:SS.mmm] [level]  text`。**可接受**：terminal 简化 format 利于人眼快速读，file 完整时间戳利于跨天对照。如要一致可设 `log.transports.console.format` = `log.transports.file.format`。
5. **接管前 stderr/stdout 已经 buffer 的内容**：electron-log 接管 console.* 不接管 `process.stdout.write` / `process.stderr.write` 直接调用。所以 native 模块（如 sqlite native 模块、worker_threads）直接写 stdout 的内容仍不入文件。**可接受**：项目代码本身都走 console.\* / log.\*，sqlite native 模块出错时 stderr 输出在 dev 模式仍可见，生产 .app 仍丢（这是 follow-up，不在本 plan 范围）。

## 影响 plan §设计决策

| 原 design | spike 后修正 |
|---|---|
| logger.ts 顶部 `Object.assign(console, log.functions)` 接管 console | **改为**`if (process.env.NODE_ENV !== 'test') Object.assign(...)` 加守门 |
| renderer 端同款接管 | **改为**`if (import.meta.env.MODE !== 'test') Object.assign(...)` 用 vite 注入 env |
| 测试改用 vi.spyOn(log, ...) | **不需要改**，原 51 处 vi.spyOn(console) 零改动 |
| 加 1 个 unit test assert 接管开关 | **必加**：tests/logger.test.ts 显式 `expect(console.log).toBe(originalConsoleLog)` 监测 NODE_ENV regression |
