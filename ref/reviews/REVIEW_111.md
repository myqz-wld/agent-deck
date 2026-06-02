# REVIEW_111 — 图片附件 hook 异步 race committed 回归测试补强（REVIEW_102 follow-up issue 6f86ac86）

> **REVIEW_102 图片附件子系统 deep-review 的 follow-up 收口**（非 scope 滚动批）。
> REVIEW_102 R2 双 reviewer 独立命中 INFO：本轮风险最高的 useImageAttachments / useImageBlob hook 级异步 race 行为（MED-1 / LOW-1 / LOW-2）仅靠 `/tmp/*.mjs` sim 实证，无 committed test，后续重构状态机不会自动挡回归。根因：项目无 React hook 测试环境（无 jsdom/@testing-library，vitest environment=node，现有 renderer 测试全是纯逻辑）。
> 用户拍板 reviewer 给的方案 **(a)**：引入轻量 React hook 测试环境（jsdom + @testing-library/react renderHook），覆盖三条异步状态机。**生产代码零改动**，纯测试基建。
> 本批 = 测试基建落地 + 单次异构对抗 simple-review 复核测试质量（防"假绿"）。

## scope（测试基建 + 2 新测试文件，生产代码零改动）

新增/改动：
- `src/renderer/hooks/__tests__/useImageBlob.test.tsx`（新增，8 测试，jsdom）—— LOW-1 loader reject 不永久 loading / LOW-2 cache hit 刷新 ts + 成功路径 / cacheKey=null 空态 / aborted guard
- `src/renderer/hooks/__tests__/useImageAttachments.test.tsx`（新增，9 测试，jsdom）—— MED-1 remove 不连坐 in-flight 兄弟 / clear-unmount 整批取消 / 复活不可达 / webp preflight / setError generation 守卫 / 基础路径
- `vitest.config.ts`（include 加 `.test.tsx` + per-file `// @vitest-environment jsdom` docblock 策略注释）
- `package.json` + `pnpm-lock.yaml`（+3 devDeps：`jsdom@^29` + `@testing-library/react@^16` + `@testing-library/dom@^10`，纯 JS 无 native binding）

被测生产代码（REVIEW_102 已审 + 本次零改动，仅作覆盖目标）：
- `src/renderer/hooks/useImageBlob.ts`
- `src/renderer/hooks/useImageAttachments.ts`

## 机器可读范围（File-level Review Expiry 用）

```review-scope
src/renderer/hooks/__tests__/useImageBlob.test.tsx
src/renderer/hooks/__tests__/useImageAttachments.test.tsx
vitest.config.ts
```

## 三条目标修法（测试必须真覆盖）

| 修法 | 文件 | 语义 | committed test |
|---|---|---|---|
| MED-1 | useImageAttachments | remove() 不 bump generationRef → 多图批量删任一张时同批 in-flight 兄弟不被连坐丢弃 | useImageAttachments.test.tsx「MED-1」describe（2 测试）+「复活不可达」（1 测试）|
| LOW-1 | useImageBlob | loader reject → loading:false + io_error result（不永久 loading）| useImageBlob.test.tsx「LOW-1」describe（3 测试）|
| LOW-2 | useImageBlob | cache hit 刷新 ts（LRU 非 FIFO）| useImageBlob.test.tsx「LOW-2」describe（1 测试）|

## 方法

`agent-deck:simple-review` 单次异构对抗：reviewer-claude（claude-code, Opus 4.7）`8d4c2db2` + reviewer-codex（codex-cli, gpt-5.5 xhigh）`019e880f`，teamId `61333c7a`。lead（本会话）三态裁决 + spike 验证（兼容性）+ mutation test（验测试能挡回归）。

**spike 前置**（spike-reports/spike1-jsdom-rtl-compat.md）：方案 (a) 两个未知风险实测——① React19+RTL16+vitest2+jsdom29 版本兼容（RTL16 peerDeps 明确 `react: ^18||^19`，esbuild 默认转 TSX 无需 plugin-react，docblock 单文件切 jsdom 工作）② useImageAttachments.add() 的 FileReader/Image/canvas 三 Web API 可 mock 让其不卡死 + MED-1 race 时序用手动 Image.onload 队列精确可控（mutation test 实证能挡回归）。

## R1 finding 三态裁决

> 0 HIGH。reviewer-claude 1 MED + 4 INFO；reviewer-codex 1 INFO。去重后 1 个真问题（MED 假绿）+ 1 组补强（双方 INFO 命中）。

### ✅ MED（unmount 测试假绿）— reviewer-claude 单方 + mutation 实证 + lead 独立确认

- **finding**：`useImageAttachments.test.tsx` 原 unmount 测试 docstring 声称覆盖「mountedRef + generation 守卫」，但唯一断言是 `expect(true).toBe(true)`。React 19 对 unmounted setState 静默 no-op（不再 warn 不抛错），"不抛错"恒成立与守卫无关。
- **reviewer-claude 验证手段（mutation 实证）**：把生产 `useImageAttachments.ts:396` 守卫整条置死 `if (false && ...)` → clear 测试正确变红（B 复活），但 **unmount 测试仍绿** → 证明它对 mountedRef + generation 两守卫双零覆盖。
- **lead 现场确认**：根因正确——unmount 后组件销毁、无可观测 state，且 mountedRef 与 cleanup 的 generation bump（useImageAttachments.ts:346）冗余，结构上无法对 mountedRef 做区分性覆盖（生产风险因此也低）。这是测试质量/覆盖声称失真，不阻塞合并但必修（假绿测试有害——给人"已覆盖"的错觉）。
- **修法**：诚实降级为 smoke test——改名「post-unmount：in-flight 图 resolve 不 hang / 不抛错 / 无 React warning（smoke）」+ 去掉 docstring 守卫覆盖虚假声称 + 实质断言 `vi.spyOn(console,'error')` 过滤 `'unmounted'` warning === [] + addDone 能 resolve 不抛。守卫的行为价值改由 clear() 测试经 mutation 守门（置死守卫 → clear 测试变红）。

### ✅ INFO 补强（更宽 race 分支）— 双方独立命中（reviewer-codex INFO + reviewer-claude INFO #4）

- **finding**：测试固定小 PNG + thumbnail onload 分支，未覆盖 `makeThumbnail` img.onerror 回退 / `readAndMaybeCompress` 大图 Path3 压缩 / `Promise.all` 任一分支 reject 后另一分支仍启动 / catch 后 `setError` 的 generation 守卫。两方都明示「不影响三条目标修法回归价值，属更宽 branch coverage 剩余空白」。
- **lead 分流**：其中两条**与 REVIEW_102 race 修法强相关 + 有区分性断言** → 顺手补 committed test；纯 branch coverage（img.onerror / 大图 Path3 降档）超出本 issue 三条 race 范围 → follow-up issue。
- **补强 1（REVIEW_102 R2 LOW，webp preflight）**：新增「超阈值 animated webp → preflight 拒 + thumbnail 未启动」。FakeFileReader 对 webp 返回超 `MAX_BASE64_BYTES_FOR_API` 大 base64 + `animatedWebpFile` 构造真实 VP8X+ANIM(0x02) 文件头，断言 error 含「webp 动图」+ **`imageOnloadQueue.toHaveLength(0)`**（区分性：preflight 在 `Promise.all` 之前 throw → makeThumbnail 不启动 → 队列空；旧版靠 readAndMaybeCompress Path2.5 拒则 Promise.all 已先启动 thumbnail → 队列有 1）。mutation（禁用生产 add() preflight）→ 测试变红实证。
- **补强 2（setError generation 守卫）**：新增「clear() 期间失配的 add 即使有 error 也不回灌」。混批 [bad-mime 同步攒 error, good-png await 卡点]，await 期间 clear() bump generation，断言 add 末尾 `setError`（useImageAttachments.ts:442）因 generation 失配不执行 → error 保持 null。mutation（去 generation 检查）→ 测试变红实证。

### ✅ INFO（确认 lead 论断成立，无需 action）— 双方独立核实

- **mock 保真度**（focus #2）：lead「小 PNG（base64 短）走 readAndMaybeCompress Path1 不碰压缩 Image、唯一手控 Image gate 是 makeThumbnail」论断**双方独立核实成立**。reviewer-claude 读 useImageAttachments.ts:232（Path1 同步 return 不调 :252 `new Image()`）+ :277（唯一 `new Image()` 在 makeThumbnail）；reviewer-codex 读 :231-233 / :274-307 / :391-398 同款确认。每 file 恰 1 个 Image 入队 → 手动 flush imageOnloadQueue = 精确控制 push 时机。
- **MED-1 race 真实性**（focus #3）：for 循环 sequential await + B/C 共享同一 `generationAtStart`（循环外拍一次）与生产 race 时序 1:1 对应；区分性断言是 `toEqual(['B','C'])`（mutation 确认变红把关）。
- **环境隔离**（focus #5）：afterEach 顺序正确（cleanup → unstubAllGlobals → restoreAllMocks），imageOnloadQueue module 级 let 在 beforeEach 重置；全量 126 文件（node+jsdom 混跑）零泄漏实证。per-file `// @vitest-environment jsdom` docblock + 全局 node 无隐患。

## lead mutation test（验「测试真能挡回归」非摆设绿）

每条目标修法 + 每条补强测试都插回旧 bug 验证对应测试变红，再撤销（生产代码最终 `git diff` 空 = 零改动）：

| mutation | 对应测试 | 结果 |
|---|---|---|
| remove() 插回 `generationRef.current++` | MED-1 3 测试（含复活不可达）| 全红 ✅ |
| useImageBlob 删 `cached.ts = Date.now()` | LOW-2 cache hit 刷新 ts | 红 ✅ |
| useImageBlob `.catch` 吞掉不 setState | LOW-1 3 测试（loading 永久 true → waitFor timeout）| 全红 ✅ |
| 禁用 add() webp preflight | webp preflight（imageOnloadQueue 空）| 红 ✅ |
| 去 setError generation 守卫 | clear 期间 error 不回灌 | 红 ✅ |
| 置死 mountedRef 守卫 | （reviewer-claude 实证）unmount 原测试仍绿 → 暴露假绿 | 即 MED finding |

## 验证

- typecheck 双配置（tsconfig.node.json + tsconfig.web.json）**双绿**（.test.tsx 入 tsconfig.web include，RTL/vitest/jsdom 类型可解析，无 React 19 类型冲突）
- vitest 全量 **1504 passed / 249 skipped / 0 failed**（baseline main HEAD `0d2bb1d` 1487 passed → delta **+17** = 8 useImageBlob + 9 useImageAttachments；skipped 249 不变 = SQLite 真测 `bindingAvailable` 守门，系统 node ABI 不匹配自动 skip 非 crash）
- jsdom ↔ node per-file environment 混跑无泄漏（同一 run 126 文件，hook 文件 docblock 切 jsdom、其余 node）
- 无 act warning / React unmounted warning 泄漏

## 异构对抗高光

- **MED 假绿单方命中 + mutation 实证**：reviewer-claude 用 mutation（置死守卫 → 原 unmount 测试仍绿）实证「测试假绿」——这是测试质量 review 最有价值的一类发现（断言恒真 = 给人虚假安全感），纯 code review 不跑 mutation 抓不到。
- **双方独立命中同一 INFO（更宽 branch coverage 空白）**：异构冗余即强验证；lead 分流「race 强相关补 committed / 纯 coverage 留 follow-up」。
- **双方独立核实 lead 关键论断**（小 PNG Path1 不碰压缩 Image）：两 reviewer 各自读生产代码不同行号区间得同结论，给 mock 保真度强背书。
- **lead spike + mutation 自验证闭环**：spike 先证「方案 (a) 可行 + race 时序可控」，mutation 后证「每条测试真能挡回归」，reviewer 独立复核 mutation 论断成立。

## 收口

- **0 HIGH / 0 真 MED（已修 1 MED 假绿）/ 0 未整改**；2 条 INFO 补强采纳（committed test）+ 纯 coverage 留 follow-up。
- **R2 双 reviewer 复核 fix（both-agree conclude）**：
  - **reviewer-codex R2**：0 findings，逐一独立复核 3 处 fix（自跑 32 tests + typecheck 全过）—— fix 1 `imageOnloadQueue.length===0` 对 preflight vs Path2.5 有区分性 / fix 2 真覆盖 setError generation guard（非形态绿）/ fix 3 已从假断言改诚实 smoke + restoreAllMocks 兜住 spy 清理。
  - **reviewer-claude R2**：0 HIGH 0 MED，明示 conclude。独立 mutation 复验 fix 2/3 真覆盖（置死生产守卫 → 恰好对应测试变红其余绿）；**额外铁证**：fix 3（webp preflight）置死后失败的是 `imageOnloadQueue.toHaveLength(0)` 而非 error 断言 → 证明测试外科级隔离 preflight vs Path2.5 defense-in-depth。**1 条 R2 INFO**：fix 1（unmount smoke）的 `reactWarnings`（spy console.error 过滤 'unmounted'）在 React 19.2.5 上恒空（grep node_modules/react-dom 零命中该 warning 字符串，18 起删除）= vacuous 子断言；非假绿（已诚实声明 smoke 不声称覆盖守卫）但属「无害死重」。
  - **R2 INFO 已采纳清理**：删掉 unmount smoke 的 `reactWarnings` 恒空断言，改留实质的 `settled` 标志断言（post-unmount add() resolve 能 settle 不 hang/不抛 —— 未来若有人在该路径加裸 deref 抛错会被抓）+ 注释点明删除理由。最终测试名「post-unmount：in-flight 图 resolve 能 settle（不 hang / 不抛错，smoke）」。
- **commits**：本会话（worktree `image-hook-race-tests-20260602` → ff-merge）。

## follow-up（非阻塞）

1. **更宽图片边界 branch coverage**（双方 INFO 剩余部分，超本 issue 三条 race 范围）：`makeThumbnail` img.onerror 回退 / `readAndMaybeCompress` 大图 Path3 canvas 重编码降档（`encodeToJpegBase64` + `COMPRESS_ATTEMPTS` 全仓零直测）/ gif 超阈值 reject。
2. **缩略图彻底修法**（承 REVIEW_102 follow-up，与本 issue 正交）：落盘 sidecar 缩略图 / IPC maxDim 降采样（本轮只做 cache 字节预算短期止血）。
