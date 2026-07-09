# CHANGELOG_202 — useImageAttachments 三条图片边界 committed test（REVIEW_111 follow-up issue a28d008f 收口）

## 概要

REVIEW_111 R1 双 reviewer 命中 INFO「更宽 branch coverage 空白」剩余部分：`makeThumbnail` img.onerror 回退 / `readAndMaybeCompress` 大图 Path3 canvas 重编码降档 / gif 超阈值 reject。REVIEW_111 当批只 commit 了与三条 race 强相关的补强（webp preflight / setError generation 守卫），剩 3 条「与 race 主题正交 + 工作量独立」的边界留给 follow-up。本 issue a28d008f 收口这 3 条。

复用 REVIEW_111 已建的 jsdom 测试环境 + `FakeFileReader` / `QueuedImage` / canvas mock 基建，扩展 3 个 helper 控 mock 行为：

- `setMockBigBase64(charLen)` — FakeFileReader 返指定长度大 base64（驱动 Path3 / gif 超阈值）
- `setMockImageFail(bool)` — QueuedImage 推 onerror 而非 onload（驱动 makeThumbnail img.onerror）
- `setMockCompressLengths([{size}|'no-ctx'])` — canvas.toDataURL 按 callCount 排队返回（模拟 7 档降档）；`'no-ctx'` 按 callCount 索引让 getContext 返 null（encodeToJpegBase64 短路）

生产代码零改动（diff 仅测试文件 +289/-19）。

## 变更内容

### 新增 6 个 committed test（src/renderer/hooks/__tests__/useImageAttachments.test.tsx）

#### 1. makeThumbnail img.onerror 回退

- `缩略图 Image decode 失败 → thumbnailDataUrl 回退为 fullDataUrl（不入 reject 链）`
  - 区分性断言：`thumbnailDataUrl === 'data:image/png;base64,aGVsbG8='`（FakeFileReader mock 的小 base64 完整字符串；onerror 回退原图而**不**走 canvas jpeg 编码）+ mime 仍为 `image/png` + `error === null`
  - 区分性 vs 旧版：旧 hook 测试 QueuedImage mock 只触发 onload，**未覆盖** onerror 路径（生产 useImageAttachments.ts:278 `img.onerror = () => resolve(fullDataUrl)`）

#### 2. readAndMaybeCompress 大图 Path3 canvas 重编码降档

- `大图 base64 > 阈值 → 走 canvas 重编码 JPEG，前 3 档 oversize + 第 4 档命中 → mime 变 jpeg + entry 正常入列`
  - 区分性断言：mime `image/png` → `image/jpeg`（encodeToJpegBase64 固定 jpeg 输出）+ `originalBytes === 5 * 1024 * 1024`（标记压缩前）+ `bytes === base64ByteLength(size - 1000)`（解码后字节而非 base64 字符串长度）+ `error === null` + toDataURL 被调 ≥ 4 次（前 3 档 oversize + 第 4 档命中 return）
  - 区分性 vs 旧版：FakeFileReader 对 png 恒返小 base64（< MAX）→ 永远走 Path 1 同步 return，**全仓零直测** `encodeToJpegBase64` + `COMPRESS_ATTEMPTS` 降档循环（grep 仅命中源文件）
- `大图走 7 档全 oversize → reject 让 UI 报错（catch → setError），不入列`
  - 区分性断言：attachments length === 0 + `error` 含「即使最低质量」（catch 路径 setError）
- `encodeToJpegBase64 拿不到 ctx（getContext 返 null）→ 该档 out=null 跳过继续下一档`
  - 区分性断言：跳过 no-ctx 档 → 第 2 档 fits → 正常入列 jpeg（`if (!out) continue` 路径覆盖）

#### 3. gif 动图超阈值 reject（Path 2）

- `gif + base64 长度 > MAX → reject 「gif 动图」+ 不入列 + imageOnloadQueue 空`
  - 区分性断言：`error` 含「gif 动图」+「无法自动压缩」+ `attachments` length === 0 + `imageOnloadQueue` length === 0（gif 跳过 makeThumbnail `new Image()`，line 275 `if (mime === 'image/gif') return fullDataUrl`，保留动图语义不进 canvas 缩略图）
  - 区分性 vs 旧版：FakeFileReader 恒返小 base64，gif 永远走 Path 1，**全仓零直测** Path 2 throw
- `gif + base64 长度 ≤ MAX → 走 Path 1 正常入列（小动图无需压缩）`
  - 区分性断言：mime 仍 `image/gif`（Path 1 不改 mime）+ `thumbnailDataUrl === fullDataUrl`（gif 走 makeThumbnail `if (mime === 'image/gif') return fullDataUrl` 直接返原图）+ `imageOnloadQueue` length === 0

### 关键 mock 发现（lead 现场发现 + 修正）

Path3 触发时**不是 1 个 Image 入队，而是 2 个**（与 spike 结论「每 file 恰 1 个 Image 入队」不符）：

- ① `readAndMaybeCompress` 内 `await loadImageFromDataUrl(dataUrl)` 调 `new Image()`（useImageAttachments.ts:252）—— Path 3 必然触发
- ② `makeThumbnail` 调 `new Image()`（useImageAttachments.ts:277）—— 永远触发

两者 `Promise.all` 并行共享同一 fullDataUrl。Path3 测试 `expect(imageOnloadQueue).toHaveLength(2)` 修正了原 lead 论断（`spike1-jsdom-rtl-compat.md`「Path1 不碰压缩 Image，唯一手控 Image gate 是 makeThumbnail」仅对 Path1 成立）。原 lead 论断在 Path1 / Path 2.5 仍正确。

### mutation 实证（验测试真能挡回归）

| mutation | 对应测试 | 结果 |
|---|---|---|
| 改 `img.onerror = () => resolve('MUTATED')`（失去回退 fullDataUrl 语义）| onerror 回退（thumbnailDataUrl 断言）| 红 ✅ |
| 改 `for (COMPRESS_ATTEMPTS)` → `if` 只跑第 1 档 | Path3 命中 / no-ctx 跳过（attachments length === 1 断言）| 全红 ✅ |
| 改 `if (mime === 'image/gif') throw` → `if (false && ...)` 跳过 throw | gif 大图（timeout 走 Path 3 卡 Image）+ gif 小图（hook.current null 因 act 抛错）| 全红 ✅ |

## 验证

- typecheck 双配置（tsconfig.node.json + tsconfig.web.json）**双绿**
- vitest 全量 **1519 passed / 262 skipped / 0 failed**（baseline main HEAD bc81b5e 1504 passed → delta **+15** = 9 老测 + 6 新测；skipped 262 是 SQLite 真测 `bindingAvailable` 守门）
- 9 个老测试无回归（mock 改动向后兼容：`mockHooks` 默认值还原老行为）
- 3 个 mutation 全部实证测试能挡回归

## 异构对抗高光

**lead 单方**完成（纯测试增量，无 design 决策 → 走 simple-review 成本不划算；如未来扩展到 race / 设计层再走双对抗）。3 个 mutation 自验 + 类型对齐 + 与 REVIEW_111 补强测试同样基线（jsdom + renderHook + FakeFileReader/QueuedImage/canvas mock）已能闭环收口。

## 关联

- REVIEW_111（图片附件 hook 异步 race committed 回归测试补强）— 当批已 commit 2 INFO 补强（webp preflight / setError generation 守卫）；剩 3 条更宽 branch coverage 留 follow-up，本 CHANGELOG 收口
- REVIEW_102（图片附件子系统 deep-review）— MED-3 修法 detectAnimatedWebp + Path 2.5 的本批 mock 通过 `setMockBigBase64` 仍兼容（webp + 超阈值 → 仍走 preflight 拒）
- issue a28d008f「图片附件更宽边界缺 committed test」— 收口
