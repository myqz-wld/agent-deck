# CHANGELOG_72: 决策对抗节统一姿势 + 大图自动压缩 + Bug 3 bypass 短路修复

## 概要

三件事一份 PR：

1. **决策对抗节去 subagent**：~/.claude/CLAUDE.md / resources/claude-config/CLAUDE.md / deep-code-review SKILL.md 全清「subagent」字眼，统一到「双 Bash 起外部 CLI」单一姿势（已废弃 plugin 自带 `Task(subagent_type:...)` 模式 + 老 Fallback 节）。两份 CLAUDE.md 决策对抗节同步成 149 行同款。
2. **大图自动压缩**：renderer 上传图片时检测 base64 大小，超 ~4.8MB（API 5MB 上限留 200KB safety）走 canvas 重编码 JPEG，按 quality 0.85→0.55 + scale 1.0→0.5 序列尝试，避开「5.3MB 截图发出去 API 直接拒收」让会话堵死的故障。
3. **Bug 3 修复**：bypassPermissions 模式下 SDK 仍调 canUseTool 弹 Write/Edit/Bash 给用户审批 —— 上一会话 sql 铁证（b81c509b session permission_mode='bypassPermissions' 但 17:00:06 Write 仍走 emit `waiting-for-user permission-request`）。修法：InternalSession 加 `permissionMode` in-memory cache + canUseTool 默认路径前 + 4 特殊分支后插 bypass 短路。

## 变更内容

### 决策对抗节统一姿势

- **`~/.claude/CLAUDE.md`**：删 4 处 sub agent 字眼（line 31 / 34 / 175 / 615）+ 整段删 §Fallback 节（与新主路径双 Bash CLI 完全冗余）
- **`resources/claude-config/CLAUDE.md`**：决策对抗节整段同步成新主路径双 Bash CLI 版（149 行），与 ~/.claude/CLAUDE.md 一致；删 7 处 sub agent 字眼 + REVIEW 模板里的「subagent 类型」改「实现路径」
- **`resources/claude-config/agent-deck-plugin/skills/deep-code-review/SKILL.md`** line 211：「多轮 review 别走 subagent / 单 Bash 一次性起」→「多轮 review 别走单 Bash 一次性起」（subagent 模式已彻底下线）

### 图片自动压缩（`src/renderer/hooks/useImageAttachments.ts`）

- 加 `MAX_BASE64_BYTES_FOR_API = 5 * 1024 * 1024 - 200 * 1024`（≈4.8MB）阈值常量；等价 raw threshold ≈ 3.6MB
- 加 `readAndMaybeCompress(file, mime)` 三层路径：
  - 原图 base64 ≤ 阈值 → 直接返回（无质量损失）
  - GIF 超阈值 → 直接 reject（动图 canvas 重编码会丢动）
  - 其他超阈值 → 按 `COMPRESS_ATTEMPTS` 序列（quality 0.85/0.7/0.55，scale 1.0/0.7/0.5 共 7 档）逐档 canvas 重编码 JPEG，第一个 ≤ 阈值返回；全档失败 → reject
- 加 `encodeToJpegBase64(img, scale, quality)` helper：白底（jpeg 不支持 alpha）+ canvas.toDataURL 失败容错
- 加 `base64ByteLength(b64)` 纯算长度避免对大 string 多创建 ArrayBuffer
- `add()` 流程改：`readFileAsBase64` → `readAndMaybeCompress`，runningTotal 用压缩后字节累计（与 entry.bytes 对齐）；entry 加可选 `originalBytes` 字段供 UI 提示「已自动压缩 X→Y MB」
- 缩略图通道独立保留（与压缩独立跑，缩略图永远基于原图）
- `MAX_BYTES_PER_IMAGE` (20MB raw) / `MAX_TOTAL_BYTES` (30MB raw) 上限保持不变

### Bug 3 修复 — bypassPermissions canUseTool 短路（双 Bash CLI 对抗审视）

**根因**：SDK 端 `allowDangerouslySkipPermissions: true` 只是「启用门栓」，注册了 canUseTool 后 SDK 仍 invoke callback 把所有工具调用丢给应用决策（包括 bypass 模式）。`can-use-tool.ts:285` 默认路径无 bypass 短路 → emit `waiting-for-user` 弹给用户。

**对抗审视**（双 Bash CLI 并发起 reviewer-claude Opus 4.7 xhigh + reviewer-codex gpt-5.5 xhigh）：
- ✅ 双方共识：方案方向正确，HIGH 修法无 ❌ 反对
- 🔥 **race HIGH-1**（双方独立提出，角度不同）：
  - claude 视角：`renameSdkSession(OLD,NEW)` 后 `sessionRepo.get(OLD)` 返回 null（窄窗口，fail-secure）
  - codex 视角：`adapters.ts:159 await createSession → :176 recordCreatedPermissionMode` 时序，**新建 bypass 会话首条 prompt 触发的工具调用就撞 race**（常见路径，不是边角）
  - 共同结论：`sessionRepo.get(realId)` 不可靠，必须读「与 SDK options 同源」的真值
- ✅ MED-2：补 4-6 单测（双方一致）

**修法**（升级方案，不只是简单加 bypass 短路）：
- **`sdk-bridge/types.ts`** `InternalSession` 加 `permissionMode: PermissionMode`（mutable in-memory cache）+ import `PermissionMode` from `@main/adapters/types`
- **`sdk-bridge/index.ts:202`** `createSession` 创建 internal 时 `permissionMode: opts.permissionMode ?? 'default'`（与同 opts 传给 SDK options 同源）
- **`sdk-bridge/index.ts:235`** `makeCanUseTool` deps 加 `getPermissionMode: () => internal.permissionMode`
- **`sdk-bridge/index.ts:709`** `setPermissionMode` 切档时**先**同步 `s.permissionMode = mode` 再 await SDK round-trip（让 canUseTool 立刻按新 mode 短路；restartWithPermissionMode 走 close+create 自然带新值无需改）
- **`sdk-bridge/can-use-tool.ts`** `MakeCanUseToolDeps` 加 `getPermissionMode: () => PermissionMode` + 默认路径前 / 4 特殊分支后插 bypass 短路：`if (getPermissionMode() === 'bypassPermissions') return { behavior: 'allow', updatedInput: input };`
- **插点不绕开 4 个特殊分支**（reviewer 一致结论）：
  - READ_ONLY 白名单：在 bypass 短路之前已 return，无影响
  - SandboxNetworkAccess：bypass 仍 auto-deny（沙盒语义独立护栏，与 settings.claudeCodeSandbox 解耦）
  - AskUserQuestion：bypass 仍走 UI 通路（Claude 主动询问语义不属"危险工具需审批"）
  - ExitPlanMode：bypass 仍走 UI（plan + bypass 互斥但保留三态 resolver 行为）

**单测**（`sdk-bridge/__tests__/can-use-tool.test.ts` 新建，6 用例，纯函数 stub deps）：
- bypass + 普通工具（Write）→ allow，不进 pendingPermissions / 不 emit waiting-for-user
- bypass + SandboxNetworkAccess → auto-deny + 引导 fallback（短路不覆盖）
- bypass + AskUserQuestion → 走 UI 通路（短路不覆盖）
- bypass + READ_ONLY (Read) → 白名单优先放行
- default + 普通工具（Write）→ 走默认路径 emit waiting-for-user（regression baseline）
- 热切换 setPermissionMode 等价：`internal.permissionMode='bypassPermissions'` 后立刻按新 mode 短路（验证 cache 单飞 + 无需 SDK round-trip）

## 备注

- 决策对抗结构调整（删 §Fallback 节）属约定升级，按全局「决策对抗」节本应走对抗 —— 但本次是用户在前会话已明确「两个场景两个姿势，不存在兜底链」原则的执行落地，非新决策；不重新对抗
- Bug 修复关联：上一会话用户报的 3 个 bug
  - **Bug 1**（hand off 旧 plan / Vertex Read cache）：CHANGELOG_70 / `~/.claude/CLAUDE.md` + `resources/claude-config/CLAUDE.md` 复杂 plan 节已加 `Bash: cat` 硬约束 + 红字 callout，无新代码改动
  - **Bug 2**（resume 历史丢失）：未定位、未修（待下一次专项调研复现条件）
  - **Bug 3**（bypass 模式仍弹 Write 审批）：本 CHANGELOG 修复 ✅
- typecheck ✅ + 35 测试全过（sandbox-config 22 + can-use-tool 6 + sdk-bridge 7，无 regression）
- 图片压缩功能用户可在 ComposerSdk / NewSessionDialog 验证（贴 5MB+ PNG 截图，发送前 hover 缩略图能看到 tooltip 显示原始字节）
- Bug 3 修复运行时验证（重启 dev 后）：bypass 会话调 Write/Edit/Bash 不再弹 PendingTab；切到 default → 立刻按新 mode 弹审批
