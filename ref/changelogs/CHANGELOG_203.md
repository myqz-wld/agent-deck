# CHANGELOG_203

## 修复两个独立 bug：vitest 图片 hook 测试 ERR_REQUIRE_ESM（jsdom→happy-dom）+ 问题页状态不刷新（issue eb0e5a9c + 追加）

用户 2026-06-02 报修两个独立问题，单会话一并收口。

### Bug ① — vitest（Electron-as-node）跑 renderer 图片 hook 测试报 html-encoding-sniffer ERR_REQUIRE_ESM

**现象**：全量 `pnpm test`（Electron-as-node，ABI 130）2 个 unhandled error（不致测试失败，但 vitest 警告 "might cause false positive tests"，且 2 个图片 hook 测试文件实际「no tests」—— 模块加载期就崩，断言根本没跑）：

```
Error: require() of ES Module .../@exodus/bytes/encoding-lite.js from
  .../html-encoding-sniffer@6.0.0/lib/html-encoding-sniffer.js not supported.
{ code: 'ERR_REQUIRE_ESM' }
```

**根因**：触发文件 `useImageAttachments.test.tsx` / `useImageBlob.test.tsx`（REVIEW_111 / CHANGELOG_202 新增，用 `@vitest-environment jsdom`）。Electron 33 内置 Node 是 **v20.18.3**，早于 `require(ESM)` 默认开启（Node 20.19+/22.12+）。jsdom@28+ 把整条 encoding 栈换成 ESM-only 的 `@exodus/bytes`（html-encoding-sniffer@6 / whatwg-url@16 / data-urls@7 均依赖），其 CJS 内部 `require()` 这些 ESM 包在旧 Node 直接抛 `ERR_REQUIRE_ESM`。

**排查中排除的方案（均实测不可行 / 不划算）**：
- `--experimental-require-module` flag：Electron 的 Node 20.18.3 **认这个 flag**，独立 `.cjs` probe 能 require 成功；但放进 vitest worker pool 后把 `ERR_REQUIRE_ESM` 换成 **`RangeError: Maximum call stack size exceeded`**（Electron patch 过的 `readFileSync` 在实验性 sync ESM loader 下无限递归）。死路。
- 降级 jsdom：whack-a-mole。jsdom@27.3 是最后一个全 CJS 链的版本，但 27.4 又把 html-encoding-sniffer 升回 @6；jsdom@26/27 的 cssstyle 栈还引入另一条 ESM-only（`@csstools/css-calc`）。整条现代 jsdom 线在旧 Node 下都炸。
- `server.deps.inline`：jsdom 由 vitest environment provider 在测试模块图外 `import()`，dep-inline 够不到。

**修法（happy-dom）**：两个图片 hook 测试 `@vitest-environment jsdom` → `happy-dom`。happy-dom 是纯 JS DOM 实现，无 native / 无 ESM-only 传递依赖，vitest 经 dynamic `import()` 加载其 ESM 栈无 CJS→ESM `require()` 边界 → 旧 Node 下不炸。两测试本就自带 `FileReader`/`Image`/`HTMLCanvasElement` 的 `vi.stubGlobal`/`spyOn`，对真实 DOM 依赖极少，happy-dom 完全满足（实测两文件 23 测试全绿）。`jsdom` devDep 删除（仓库内已无其他消费者）。

**附带 build-script 修复**：pnpm v10 默认 gate 依赖 build script，clean install（`rm -rf node_modules`）会因此漏建 electron / esbuild + 漏跑 better-sqlite3 的 electron-builder rebuild（原 `node_modules` 是 pnpm 9 装的没 gate 才一直 work）。加 `pnpm.onlyBuiltDependencies: ["electron", "esbuild"]`（这俩下载预编译二进制，不编译源码）。**故意不含 better-sqlite3** —— 它走 `postinstall` 的 `electron-builder install-app-deps`（`buildFromSource=false` 用预编译 binding，不需 Xcode）；若放进 allowlist 会触发它自己的 gyp 源码编译，无 CLT 环境直接 fail。binding ABI v130 全程保持（fingerprint `fa87c8c1` 未变）。

> ⚠️ clean re-resolve 顺带把一批无关 transitive dep 在已提交 caret 范围内升了 patch/minor（react 19.2.5→19.2.7、zod 4.3.6→4.4.3 等）。用户已确认接受（换 jsdom/@exodus/bytes 从树里彻底清掉，杜绝以后误用 `@vitest-environment jsdom` 复发）。全量测试 + typecheck + build 三绿背书。

### Bug ② — 切换到问题页面时不会刷新状态

**现象**：在别的 tab 时若 issue 状态变了（典型 MCP「起新会话解决」回写 `status=in-progress` / 解决会话 `update_issue_status` 翻 `resolved`），切回问题页仍显示旧状态。

**根因**：`onIssueChanged` 订阅写在 `IssuesPanel` 组件 `useEffect` 内（组件级）。App 按 `view` 条件渲染 panel，切走 tab → IssuesPanel **unmount** → 订阅被拆除 → 期间所有 issue-changed 事件**全漏**。切回时 remount 虽按当前 filter 重拉 list，但 `mergeIssuesFromList` 是 keep-all merge：已掉出当前 filter 的 stale 行（如 open→resolved 后「活跃」filter 重拉结果不含它）既不被刷新也不被移除 → store 仍是旧 `open` → 列表继续显示过期状态。

**修法**：新建常驻 hook `useIssuesBridge`（`src/renderer/hooks/use-issues-bridge.ts`），在 `App` 顶层只挂一次订阅 issue-changed → issues-store（与 session 的 `useEventBridge` always-on 同款）。事件永不漏，store 始终最新，`selectFilteredIssues` 每次渲染重过滤 → 切到问题页即见最新状态。IssuesPanel 内原组件级订阅 `useEffect` + 配套 `upsertIssue`/`removeIssue` 选择器删除（避免双订阅），保留其 list-fetch + debounce 两个 effect。新增 `use-issues-bridge.test.tsx`（5 测试，happy-dom + renderHook：mount 订阅 / unmount off / created·updated·hardDeleted 派发；mutation 实证 5 测试全能挡回归）。

### 影响文件

- `package.json` — jsdom→happy-dom devDep；新增 `pnpm.onlyBuiltDependencies`
- `pnpm-lock.yaml` — 重解析（jsdom/@exodus/bytes 移除 + happy-dom 加入 + caret 范围内 patch 漂移）
- `src/renderer/hooks/__tests__/useImageAttachments.test.tsx` / `useImageBlob.test.tsx` — `@vitest-environment` jsdom→happy-dom + 注释对齐
- `src/renderer/hooks/use-issues-bridge.ts` — 新建常驻 issue 事件桥
- `src/renderer/hooks/__tests__/use-issues-bridge.test.tsx` — 新建（5 测试）
- `src/renderer/App.tsx` — 挂 `useIssuesBridge()`
- `src/renderer/components/IssuesPanel.tsx` — 删组件级 onIssueChanged 订阅 + 头注对齐

### 验证

- `pnpm test`（Electron-as-node）：**131 files / 1814 passed / 0 errors**（基线 1786 + 2 errors）
- `pnpm typecheck` 双绿 · `pnpm build` 绿
