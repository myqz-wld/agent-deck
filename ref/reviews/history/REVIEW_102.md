# REVIEW_102 — 图片附件子系统 deep-review（R1+R2 双轮异构对抗收口）

> 关联 commits：`7d05d67`（R1 合并修法：generationRef race / cache 字节预算 / animated webp / loader catch + 30 回归测试）
> 性质：滚动「全项目 deep review」Batch 4（debug/加固 —— 无新功能引入，归 reviews）
> follow-up（注释标注，建议落 issue）：缩略图彻底修法（落盘 sidecar 缩略图 / IPC maxDim 降采样，本轮只做 cache 字节预算短期止血）

## 背景与诉求

用户「deep review 全项目，BUG 排查 + 代码优化」滚动任务，自主推进 + 自主 hand off。Batch 1（resume-history，REVIEW_99）+ Batch 2（teamless-dm + universal-message-watcher，REVIEW_100）+ Batch 3（codex-cli sdk-bridge 断连恢复链，REVIEW_101）收口后，按 churn / file-level-review-expiry 重算下一最大未审面。

**关键方法学修正**：file-level-review-expiry.sh 脚本只解析到 REVIEW_65（66-101 共 36 份 review 未进映射 + 老 review base 全 fallback 到初始 commit `03c16e47` churn 计算失真）→ 脚本版「已审」严重低估，本批改用 `grep -rlF <file> ref/reviews/` 逐文件精确核验绕过脚本 bug。issue UI 三件套（IssueDetail→REVIEW_67/69/70、IssuesPanel/ResolveInNewSession 2-3 天前刚审 churn≈0）确认不重审排除。

scope（8 文件 ~1228 LOC，全 repo root 内无 sandbox cp）= **图片附件子系统**（全新风险面，与 Batch 1/2/3 mental model 重叠低）：
- `renderer/hooks/useImageAttachments.ts`(467) — 粘贴/拖放/上传三件套；完整 base64 存 useRef Map 不进 state；canvas 压缩降档 + 缩略图；mountedRef/generationRef race guard
- `main/store/image-uploads.ts`(261) — 写盘 writeUploadedImage / 读 loadUploadedImage / reaper；mime 反查 ext + base64 实测对账 + realpath 五步 TOCTOU
- `renderer/hooks/useImageBlob.ts`(88) — 图片加载 cache + loading 状态机 + abort flag
- `renderer/lib/image-blob-cache.ts`(19) — sharedImageBlobCache module
- `renderer/components/ImageLightbox.tsx`(91) — fixed overlay + Esc 关闭
- `renderer/components/UploadedImageThumb.tsx`(91) — 历史附图缩略图 + reason→中文灰底
- `main/ipc/_image-constants.ts`(71) — ext/mime/size 白名单
- `main/ipc/adapters.ts`(430) — persistAttachments 落盘 + createSession/sendMessage 回滚事务

**选批依据**：图片子系统 8+ 文件几乎全未审（仅 ipc/images.ts 在极早期 REVIEW_18 审过且 churn=0），是 Batch 1/2/3 之外的最大内聚未审域；风险面全新（文件上传持久化 + blob URL 内存生命周期 + 粘贴/拖放并发 race + IPC 路径 TOCTOU）。

## 方法

`agent-deck:deep-review` SKILL，R1+R2 双轮异构对抗：
- **reviewer-claude**（claude-code adapter，Opus 4.7）—— R1 首个实例 `845a5813` 卡死（两次收口 nudge 有 event 响应但始终不产出 reply，lastEventAt 停滞 ~5min / 距 spawn ~28min 接近卡死线）→ shutdown + 重 spawn `ecd64613`（要求 12 分钟内交付）重跑 Round 1 全量
- **reviewer-codex**（codex-cli adapter，gpt-5.5 xhigh）sid `019e855b`
- teamId `894e7802-d061-4618-82d0-dfdb78605645`
- lead（本会话）三态裁决 + 现场验证（8 文件独立通读建 mental model + 4 个 Node sim 实证 + web 规范逻辑链 + base64 数值对账 + 防穿越 guard 矩阵）

**失败兜底实践**：reviewer-claude 首实例卡死走 SKILL §失败兜底「合规兜底（仍异构）」—— shutdown 卡死实例 + 重 spawn 一个 reviewer-claude，与未动的健在 reviewer-codex 仍构成 Opus 4.7 vs gpt-5.5 异构对，未降级同源双 Codex。

## 轮次概览

| 轮 | reviewer-claude | reviewer-codex | lead 裁决 |
|---|---|---|---|
| R1 | 0 HIGH / 3 MED（generationRef race / 缩略图全图 cache / 零单测）/ 4 INFO | 0 HIGH / 2 MED（缩略图全图 cache / animated webp）/ 2 LOW（loader 永久 loading / cache FIFO）/ 1 INFO（零单测）| 异构高光：claude 独立命中 generationRef race + 推理复活不可达；双方独立命中缩略图全图 cache（强冗余）；codex 独有 animated webp + loader catch；全部现场验证成立。reviewer-claude 首实例卡死 → 重 spawn 重跑 Round 1 |
| R2 | 0 新 HIGH / 0 新 MED，逐 fix 验完 5 focus 点全 ✅，明示 conclude + 可合 / 2 INFO（hook test）| 0 HIGH / 0 MED，主路径全认可明示可合 / 1 LOW（webp 被拒后 thumbnail 仍启动）/ 1 INFO（hook test）| 双方 both-agree conclude；codex LOW 现场 sim 实证 → fix；双方 INFO（hook test）部分补强 + follow-up issue |
| R3 | R3 confirm 可最终收口（逐点验 preflight 0 新问题）| R3 confirm 可最终收口（preflight 验证 + 自跑 15 tests）| 双方 both-agree 最终收口，0 HIGH 0 MED |

## R1 finding 三态裁决（全部现场验证）

> 0 HIGH。9 条 finding（去重后 7 个独立问题），全部现场验证成立。异构对抗双方命中互补 + 1 条双方独立命中强冗余。

### ✅ MED-1（generationRef 误伤同批 in-flight）— claude 单方 + lead sim 复现 + 复活不可达铁证

- **finding**：`useImageAttachments.ts` 多图批量上传时 entry 逐张 push（line 361 在 for 内），删任一张 → `remove()` 无差别 bump 全局 `generationRef`（旧 line 383），而整批 add 只在开头拍一次 `generationAtStart`（line 304）→ 同批仍在 `await Promise.all([compress,thumb])` 的其余图 resolve 后 generation 失配，命中 line 323 `continue` 被**静默丢弃**（无 error 无提示）。
- **异构高光**：reviewer-claude 独立命中（reviewer-codex 未提），且推理比 lead 预备分析更深——指出 remove 注释担心的「被删 entry 因 add resolve 后复活」**不可达**：entry 的 id 在 `await` 之后 line 327 才 `nextId()` 生成，in-flight 图还没 id、UI 列表里没有它、用户根本点不到「删」它 → remove 的 bump 纯属过度取消。
- **lead 现场验证**：`/tmp/img-gen-race.mjs` sim 复现「拖入 [A快,B慢,C慢]，删 A → B/C 静默丢弃」（admitted 仅 [A]，dropped [B,C]）；`/tmp/img-med1-fix.mjs` 3 场景验证修法（删 A 不再误伤 B/C + clear 仍整批取消 + 复活场景不可达 remove(in-flight id) 是 no-op）。
- **修法**（commit 7d05d67）：`remove()` 去掉 `generationRef.current++`，只删该 id（同步 ref + state）；clear()/unmount 的整批取消 bump 保留（那才是「丢弃所有 in-flight」正确语义）。

### ✅ MED-2（缩略图全图加载 + cache 无字节预算）— 双方独立命中（强冗余）

- **finding**：`UploadedImageThumb` 渲染 56px 缩略图却 `loadUploadedImage(path)` 读**整张原图**（无降采样），单图最大 20MB → base64 dataUrl ~27MB，进 module 级 `sharedImageBlobCache`（应用生命周期内永不清空），旧逻辑只按 50 *条数* LRU 驱逐 → 最坏 50×27MB ≈ 1.3GB 常驻 + 每次滚动历史触发整图 decode/IPC。
- **双方独立**：reviewer-codex MED-1 + reviewer-claude MED-2 各自独立命中（异构强冗余即算验证）。
- **lead 现场验证**：读码确认 thumb line 83 用 full dataUrl / cache cap=50（useImageBlob line 29/66）/ 单图 20MB（_image-constants line 68）；`sharedImageBlobCache` 仅 thumb+lightbox 两 consumer 共享一个 50-entry cache 无字节预算。
- **修法**（commit 7d05d67，短期止血）：`evictToBudget` 加 `MAX_CACHE_BYTES=128MB` 字节预算，条数 + 字节双闸门 LRU 驱逐（newKey 保护防超大图自我驱逐）。`/tmp/evict-budget.mjs` 4 场景验证（60×27MB→压到108MB / 60×1MB→条数触发 / 200MB newKey 保护 / LRU 顺序）。**彻底修法**（落盘 sidecar 缩略图 / IPC maxDim 降采样）留 follow-up。

### ✅ MED-3（animated webp 静默静态化）— codex 单方 + lead web 规范逻辑链验证

- **finding**：`readAndMaybeCompress` 白名单允许 image/webp，但超 base64 阈值压缩路径只拦了 GIF（line 193），animated webp 进 canvas → JPEG → 只剩首帧 + mime 变 image/jpeg，用户发给模型的内容与原图静默不一致。
- **lead 现场验证**：web 规范确定性事实——canvas `drawImage` 对动图只绘制当前帧 + jpeg 格式无动画能力（非推测）；触发条件 animated webp 且 base64 > 4.8MB（高帧率长动画不罕见）。
- **修法**（commit 7d05d67）：加 `detectAnimatedWebp`（读文件头 32 字节检测 VP8X chunk 的 ANIM bit 0x02）+ Path 2.5 animated webp 与 gif 同样拒；静态 webp 仍走正常 canvas 压缩。检测纯逻辑 `isAnimatedWebpHeader` 已 export + 6 测试覆盖。

### ✅ LOW-1（loader reject 永久 loading）— codex 单方 + lead sim 实证

- **finding**：`useImageBlob` 的 `loader().then()` 无 `.catch`（旧 line 62）。正常业务错误返 `{ok:false,reason}`，但 transport/preload bridge/main handler 未捕获异常仍会 reject → `loading` 永久 true（UI 永远「加载中…」）+ unhandledRejection。
- **lead 现场验证**：`/tmp/blob-reject2.mjs` sim 实证（loader async reject 后 state.loading 恒 true + unhandledRejection 触发）。
- **修法**（commit 7d05d67）：补 `.catch` 归一成 `{ok:false,reason:'io_error',detail}` + 沿用 aborted guard 防 unmount 后 setState；不缓存失败（与既有 result.ok 才缓存策略一致）。

### ✅ LOW-2（cache hit 不刷 ts = FIFO 非 LRU）— 双方命中（codex LOW-2 / claude INFO）

- **finding**：`useImageBlob` cache hit path（旧 line 56-58）只 setState 不更新 `ts`，淘汰只按插入时间 = FIFO 非 LRU，频繁访问的老图仍被新条目挤掉，lightbox 重开重复 IPC 拉全图。
- **修法**（commit 7d05d67）：hit 时 `cached.ts = Date.now()` 刷新访问时间。

### ✅ INFO-1（同文件读两遍）— claude + lead 核验

- **finding**：`readAndMaybeCompress`（line 184）和 `makeThumbnail`（line 220）各自 `readFileAsDataUrl(file)` → Promise.all 并发跑大图瞬时 2× 内存 + 2× base64 编码 + 2× 解码。
- **修法**（commit 7d05d67）：add() 先读一次 dataUrl 传给两者复用（canvas 编码仍并发，共享同一份 dataUrl）。

### ✅ INFO-2（lightbox keydown listener 重挂）— claude + lead 核验

- **finding**：`ImageLightbox` keydown effect `deps=[onClose]`，caller（message-row.tsx:291）传 inline `onClose={() => setLightboxPath(null)}` → 每父 render onClose 新引用 → 反复 remove/add window keydown listener（仅 lightbox 打开期间）。
- **修法**（commit 7d05d67）：改 `onCloseRef` + `deps=[]`，listener 对 onClose 引用变化免疫（mount/unmount 各挂卸一次）。

### ✅ MED/INFO（零单测覆盖）— 双方命中（codex INFO / claude MED-3）

- **finding**：整个上传子系统零专门单测，grep 命中的全是 codex-cli adapter 的 local_image 测试（无关）。子系统密集承载 race 修法 / TOCTOU / base64 对账 / 落盘回滚——最该有回归 test。
- **修法**（commit 7d05d67）：补 30 个回归测试：
  - `image-uploads.test.ts`(19)：write bytes 对账/mime 反查/cap/空图、load 前缀穿越/ext/size、delete `..` 穿越防护、reaper mtime 判定（纯 fs 真测，不依赖 SQLite binding）。
  - `image-attachments-logic.test.ts`(11)：evictToBudget 双预算 LRU 5 例 + isAnimatedWebpHeader 6 例。

## lead 额外验证的健壮项（finding 反向证伪储备）

现场验证以下角度健壮（未来误报有铁证反驳）：
- `base64ByteLength`（line 122-127）与 Node Buffer 解码 0-300 全一致，无 off-by-one（`/tmp/base64-math.mjs`）
- `writeUploadedImage` cap 公式 `ceil(MAX*4/3)+4` 不误拒恰好 20MB 合法图（real 27962028 ≤ cap 27962031）
- `deleteUploadIfExists` resolve+前缀 guard 防穿越 5 case 全过（REVIEW_91 修法成立）
- `loadUploadedImage` realpath 失败回退路径不可达（reqPath realpath 先 ENOENT）
- `nextId` Date.now()+__idSeq 单调自增无碰撞 / reaper mtime=now 新文件不被 14 天 cutoff 误删

## 验证

- typecheck 双配置（tsconfig.node + tsconfig.web）绿
- 全量 vitest **1387 passed / 236 skipped 零回归**（比 Batch 3 收口 1357 多 30 = 新增测试）
- MED-1 控制流 `/tmp/img-med1-fix.mjs` 3 场景 sim 实证；LOW-1 `/tmp/blob-reject2.mjs` 实证永久 loading；MED-2 `/tmp/evict-budget.mjs` 4 场景；MED-3 `/tmp/webp-anim-detect.mjs` VP8X ANIM 检测

## R2 复审结论（双方 both-agree conclude）

R2 双 reviewer 复审 commit 7d05d67 fix 正确性 + 深挖，均明示「可 conclude / 可合」，0 新 HIGH 0 新 MED。

**reviewer-claude R2**：逐 fix 验完 5 个 focus 点全 ✅：
- evictToBudget 无死循环（每轮 delete 或 break）+ 字节累加每次从头重算无双计 + entryBytes 失败返 0 是死路径无害（cache.set 被 if(result.ok) 包裹失败 result 永不入 cache）+ newKey 保护边界正确
- detectAnimatedWebp generation 中途变化无副作用 + catch→false 近乎不可达（readFileAsDataUrl 已先读整文件成功 → 读前 32 字节几乎必成）
- remove() 去 bump 无隐藏依赖（toIpcInputs 不读 generation）+ 无新复活/孤儿 + 总量预算交互正确
- loader().catch then/catch 互斥两支都先 aborted guard + err optional chaining 不崩

**reviewer-codex R2**：主路径全认可（evictToBudget 无死循环 / VP8X offset 20 & 0x02 准确 / loader catch aborted guard 正确 reject 不缓存 / remove 去 bump 无复活路径）。新提 2 条：

### ✅ R2 LOW（codex 单方 + lead sim 实证）animated webp 被拒后 thumbnail 仍启动

- **finding**：`add()` 先读 dataUrl 后用 `Promise.all` 同时启动 `readAndMaybeCompress` + `makeThumbnail`。oversize animated webp 在 readAndMaybeCompress Path 2.5 被拒，但 makeThumbnail 已同步创建 Promise（new Image + img.src = fullDataUrl）→ 仍 decode 大图 + canvas 取首帧；Promise.all reject 不取消另一分支 → 被拒的 20MB 级 animated webp 仍有一次无用内存/CPU 峰值。
- **lead 现场验证**：`/tmp/promise-all-branch.mjs` sim 实证（compress reject 后 thumb 仍启动并跑完）。
- **修法**（commit 486386b）：add() 内 Promise.all **之前** preflight —— webp 且 base64 超阈值时先 detectAnimatedWebp，命中直接 throw（走 catch → push error），不启动 thumbnail。readAndMaybeCompress 内 Path 2.5 保留作 defense-in-depth（直接调用方 / 未来 caller 兜底）。

### ✅ R2 INFO（双方独立命中）hook 级 race 无 committed test —— 部分补强 + follow-up

- **finding**：本轮风险最高的 hook 异步行为（remove 不连坐 in-flight 兄弟 / loader reject loading:false / cache hit 刷新 ts）仍只靠 /tmp sim，未落 repo committed test。根因：项目无 React hook 测试环境（无 jsdom/@testing-library，vitest environment=node）。
- **部分补强**（commit 486386b）：export detectAnimatedWebp + 补 4 个 fake File 端到端集成测试（含 file.slice().arrayBuffer() async 路径）。
- **follow-up**（issue `6f86ac86`）：完整 hook 异步 race 测试需引入 jsdom + @testing-library（reviewer 给的两选项：a 引入 hook 测试环境 / b 转可测 reducer），属独立测试基建改进，两 reviewer 均明示非阻塞可合。

## R3 最终确认（双方 both-agree 收口）

R3 轻量确认 commit 486386b 的 preflight fix（动了 add() 核心路径，需双方确认）。

- **reviewer-codex R3 confirm**：preflight 在 Promise.all 构造前完成，oversize animated webp throw 进 catch，makeThumbnail 不被调用 → 无用 decode 峰值已消除。边界检查全过（静态/非 oversize webp 不受影响 + Path 2.5 防御层次合理 + 检测成本可忽略）。自跑 15 tests passed。
- **reviewer-claude R3 confirm**（首条 reply 漏调 send_message 卡在自身 session，lead nudge 后补发，结论不变）：逐点确认 0 新问题（throw 走 catch / short-circuit 顺序最优 type→length→detect / 边界未破坏 / 额外核验 preflight throw 早于 generation 检查但 error setState 仍受 mountedRef+generation 守卫无越权）。

**三轮（R1+R2+R3）双 reviewer 全程 both-agree conclude，0 HIGH 0 MED，最终收口。**

## 收口结论

- **finding 汇总**：0 HIGH / 3 MED（generationRef race / cache 字节预算 / animated webp）+ 3 LOW（loader 永久 loading / cache FIFO / webp 被拒 thumbnail）+ 4 INFO（读两遍 / listener 重挂 / 零单测 / R2 hook test）**全部 fix 或 follow-up**。
- **commits**：`7d05d67`（R1 合并修法 + 30 测试）+ `486386b`（R2 preflight + 4 集成测试）。
- **测试**：补 34 个回归测试（image-uploads.test.ts 19 + image-attachments-logic.test.ts 15），typecheck 双配置绿 + 全量 vitest 1391 passed / 236 skipped 零回归。
- **follow-up**：① 缩略图彻底修法（落盘 sidecar 缩略图 / IPC maxDim 降采样，本轮只做 cache 字节预算短期止血）② hook 异步 race committed test（issue `6f86ac86`，需 jsdom 测试环境）。
- **异构对抗价值复盘**：① claude 独立命中 generationRef race 且推理复活不可达比 lead 预备分析更深 ② 双方独立命中缩略图全图 cache（强冗余）③ codex 独有 animated webp + loader catch + R2 thumbnail 峰值 ④ reviewer-claude 首实例卡死走合规兜底重 spawn 仍保异构（未降级同源）。
