# CHANGELOG_205

## 日志降噪 + webFrameMain disposed 静默化（plan log-noise-and-disposed-20260603）

> 关联 plan：`ref/plans/log-noise-and-disposed-20260603.md`（归档后生效）
> 关联 review：simple-review SKILL R1-R3 异构对抗（reviewer-claude + reviewer-codex）

### 改动总览（6 改 + 2 新 test）

- `src/main/adapters/codex-cli/translate.ts` —— `Ignoring malformed` loader warning 日志级别 `warn` → `debug`（fix B）。`REVIEW_80` 的 `'Ignoring malformed'` 锚点 filter + UI emit 抑制逻辑不动；改 debug 后 file transport (默认 level 'info') 不收，磁盘 5 天 264 行清零；dev 终端 console 'silly' 仍可见。
- `src/main/adapters/codex-cli/__tests__/translate.test.ts` —— loader warning case 断言 `warnSpy` → `debugSpy`（与代码改动同步）。
- `src/main/index/_deps.ts` —— 新增 `makeSafeSend(getWindow)` factory（纯函数，签名 `() => Electron.BrowserWindow | null`，返带 type 参数的 send 闭包）。从 `bootstrap-wiring.ts` 抽出，让单测可独立 import 而不走 `bootstrap-wiring.ts` 的 `window/lifecycle.ts:1` named `import 'electron'` 撞 vitest CJS interop 错的副作用链。
- `src/main/index/bootstrap-wiring.ts` —— `safeSend` 闭包改调 `makeSafeSend(() => floating.window)`，函数体重写加 `try/catch` 仅 catch 框架已知 race（**注：此 try/catch 在生产里实际不触发**——详 §Fix E 修订历史）。
- `src/main/index/__tests__/bootstrap-wiring.test.ts` —— **新增** 7 case：null window / window destroyed / wc destroyed / 框架 `Render frame was disposed` 静默 / `TypeError` 透传 / 非 Error 透传 / 正常路径。
- `src/main/utils/logger.ts` —— 新增 `shouldDropWebFrameMainDisposedNoise(message): boolean` + `installWebFrameMainDisposedFileFilter()` + module-load 时 install（fix E，详见下节）。
- `src/main/utils/__tests__/logger.test.ts` —— **新增** 9 case（7 shouldDrop 锚点 + 2 install 装到 `log.hooks` + dedup）。
- `src/main/utils/__tests__/logger-end-to-end.test.ts` —— **新增** 3 case 走 `electron-log/node` 真包（vitest-setup.ts:21 NOT mock）+ tmp file transport + 真 emit 验证：双关键词不落盘（HIGH-1 关键回归）/ 普通业务 log 落盘（HIGH-2 关键回归）/ 单独 'Render frame was disposed' 字符串不误吞。

### Fix E 修订历史（reviewer 双对抗 R1-R3 实证）

Fix E 经历 3 轮 review 修订，每轮 lead 端根因分析错位被 reviewer 抓出：

1. **R0 假设**（plan 初稿 + 实施期）——「Electron framework `webContents.send` 抛 `Render frame was disposed` → 应用层 `safeSend` 内 try/catch 静默」。
2. **R1 reviewer-claude 抓错层**（HIGH-1）—— 铁证 3 件：① framework binary 反汇编 `WebFrameMain.send` 内有 native `try/catch` + `console.error` 不 rethrow；② 14/14 日志样本全带 `"Error sending from webFrameMain: "` 前缀（应用层 src/ 0 命中该字符串）；③ `logger.ts:95 Object.assign(console, log.functions)` 接管 Electron 内部 `console.error` → file transport 'info' 级落盘。**根因 = framework 内部 console.error 落盘，应用层 try 永不进**。
3. **R2 reviewer-codex + reviewer-claude 抓错对象 + pass-through 语义**（HIGH-1 同款论 + HIGH-2 新论）—— ① hook 应装 `log.hooks`（Logger 实例级）不是 `log.transports.file.hooks`（Transport 无 hooks 字段，electron-log v5 `Logger.js:177` `this.hooks.reduce(...)` 才是真路径）；② keep-path 必返 `msg` 不是 `undefined`（reduce 短路语义 `msg ? hook(msg, transFn, transName) : msg` 依赖 truthy，返 undefined = 整条丢）。
4. **R3 加端到端测** —— 单测纯函数 + mock 是「测假象」（R1 no-op 二次重演的根因），新建 `logger-end-to-end.test.ts` 走 `electron-log/node` 真包 + tmp file transport + 验真落盘抓未来 regression。

最终落地：filter 装到 `log.hooks`，keep-path 返 `msg`，drop-path 返 `false`，加 `transportName !== 'file'` 门控（dev console transport 透传保留可见）。`safeSend` try/catch 保留作 defense-in-depth（无害，但不声称修了磁盘噪声）。

### 已知 trade-off / 残留

- `safeSend` try/catch 在生产中永不触发（Electron framework native try/catch 吞错先于应用层），但保留作为 defense-in-depth 防未来 framework 行为变化或非 framework 路径的同类 race。
- `installWebFrameMainDisposedFileFilter()` 在 logger.ts module-load 时跑，dedup by ref equality 防 HMR / 重 init 重复加。
- `shouldDropWebFrameMainDisposedNoise` 锚点 `'Error sending from webFrameMain' + 'Render frame was disposed'` 单 string 项**同时**命中（不 OR 拼接），与 `REVIEW_80` 'Ignoring malformed' 锚点 filter 同款窄匹配思路（防误吞其他 framework 错）。端到端测 case 3 锁住此语义防未来 drift。

### 验证

```
$ pnpm exec vitest run src/main/utils/__tests__/logger.test.ts src/main/utils/__tests__/logger-end-to-end.test.ts src/main/index/__tests__/bootstrap-wiring.test.ts src/main/adapters/codex-cli/__tests__/translate.test.ts
 Test Files  4 passed (4)
      Tests  72 passed (72)
   Duration  449ms

$ pnpm typecheck → tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json (双绿)
```

预期磁盘日志：5 天 264 行 codex loader warn + 18 行 webFrameMain disposed error 落盘清零（按 R3 fix 实际生效，下一次复现日验证）。
