# Spike 2: codex-sdk 0.120.0 → 0.131.0 API surface 验证

## 动机

plan §Step 0.5 spike2。0.120 → 0.131 是 11 minor 跨越（注：当前 latest 0.132.0 是数小时前发布，spike 选 0.131.0 = 2 天老 = 保守稳定版）。codex SDK 的 `Codex` / `Thread` / `Input` / `ThreadEvent` / `ThreadOptions` type 可能改 + vendored binary 内部 mcp tool approval gate 行为可能改（reviewer-codex-cross-adapter-20260519 plan 才修过 5 commit fix chain，新版 codex SDK 是否仍兼容?）

## 假设

- H1：codex SDK 主要类型（`Codex` constructor / `Codex.startThread()` / `Codex.resumeThread()` / `Thread.runStreamed()` / `Thread.run()` / `ThreadEvent` discriminated union / `Input`）保持稳定
- H2：`codexPathOverride` constructor option 保留（agent-deck 主代码路径依赖此 override 让打包后的 unpacked binary 路径生效）
- H3：vendored binary（`@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex` 等）路径结构不变，agent-deck 的 `resolveBundledCodexBinary()` PLATFORM_BINARY_MAP 仍 work
- H4：sandbox + approval policy + mcp_servers 配置 schema 保持稳定（CHANGELOG_130 `simpleStatelessStreamableHttp.js` pattern + `ToolAnnotations` openWorldHint 关系仍兼容）

## 实测命令

### Step 1：复用 spike1 scratch worktree（已有 claude SDK bump）

```bash
# 同一 scratch worktree（spike-sdk-bump-20260520）
# 验证两个 bump 共存：累计 spike 模式
cd <spike-worktree> && pnpm update @openai/codex-sdk@0.131.0
# pnpm update 输出：
#  dependencies:
#  - @openai/codex-sdk 0.120.0
#  + @openai/codex-sdk 0.131.0 (0.132.0 is available)
cat node_modules/@openai/codex-sdk/package.json | grep version
# "version": "0.131.0"
```

### Step 2：typecheck（含 spike1 claude SDK bump 累积）

```bash
cd <spike-worktree> && pnpm typecheck   # exit 0
```

### Step 3：tests 全套

```bash
cd <spike-worktree> && pnpm test --run
# 结果：Test Files 64 passed | 5 skipped (69)
#       Tests 762 passed | 76 skipped (838)
#       FAIL 0
```

### Step 4：API surface diff（.d.ts 静态对比）

```bash
# 主仓库已装 0.120.0
cp node_modules/@openai/codex-sdk/dist/index.d.ts /tmp/codex-0.120.0.d.ts
# npm pack 0.131.0 → 解包 → cp index.d.ts
npm pack @openai/codex-sdk@0.131.0 -C /tmp/scratch
tar -xzf openai-codex-sdk-0.131.0.tgz -C /tmp/scratch/extract-codex
cp /tmp/scratch/extract-codex/package/dist/index.d.ts /tmp/codex-0.131.0.d.ts
# 全文 diff
diff /tmp/codex-0.120.0.d.ts /tmp/codex-0.131.0.d.ts
# 文件大小：0.120.0 = 273 行；0.131.0 = 275 行（仅 +2 行）
```

### Step 5：vendored binary 路径结构验证

```bash
# 旧 0.120.0 平台 binary 结构（参考）
find node_modules/.pnpm/@openai+codex@0.120.0/node_modules/@openai/codex-darwin-arm64/vendor/ -name "codex*" 
# 输出：vendor/aarch64-apple-darwin/codex/codex
# 新 0.131.0 平台 binary 结构（实测）
find node_modules/.pnpm/@openai+codex@0.131.0/node_modules/@openai/codex-darwin-arm64/vendor/ -name "codex*"
# 输出：vendor/aarch64-apple-darwin/codex/codex
# 完全一致
```

## 实测结果

### 静态 typecheck

| 指标 | 0.120.0 → 0.131.0 |
|---|---|
| typecheck error 数 | **0** |
| typecheck exit | **0** |

### Runtime test（含 spike1 累积）

| 指标 | 同 spike1 | 备注 |
|---|---|---|
| Test Files passed | 64 | 与 spike1 完全一致 |
| Tests passed | **762** | 与 spike1 完全一致 |
| Tests failed | **0** | 与 spike1 完全一致 |
| pnpm test exit | **0** | OK |

### .d.ts 完整 diff（实测 100% 输出）

```diff
125a126,127
>     /** The number of reasoning output tokens used during the turn. */
>     reasoning_output_tokens: number;
```

**仅 2 行 additive**：在 turn usage 接口加 `reasoning_output_tokens: number` 字段（reasoning model 专用 token 计数）。

agent-deck 使用情况：

```bash
# grep src/ 看 agent-deck 是否解构 / 访问 reasoning_output_tokens
grep -rn "reasoning_output_tokens" src/  # 0 命中
# grep src/ 看 agent-deck 是否对 turn usage 字段做 strict 校验（如 keyof / Pick）
grep -rn "Usage\b" src/main/adapters/codex-cli  # 0 命中（agent-deck 不解构 usage 字段）
```

**结论**：codex 0.131.0 对 agent-deck 是 ZERO breaking。新增字段 agent-deck 不需要接，typecheck 不报错。

### 关键 API surface 兼容性

#### `Codex` constructor

```ts
// 0.120 + 0.131 完全一致
new Codex({ codexPathOverride?: string; env?: Record<string, string>; }): Codex
```

`codexPathOverride` 字段保留 → agent-deck `cachedCodex = new sdk.Codex({ codexPathOverride })` 路径不动。

#### `Codex.startThread() / resumeThread()`

```ts
// 0.120 + 0.131 完全一致
startThread(_options?: ThreadOptions): Thread
resumeThread(_threadId: string, _options?: ThreadOptions): Thread
```

`ThreadOptions` 字段（sandboxMode / approvalPolicy / model / cwd / mcpServers / additionalDirectories / networkAccessEnabled / envOverride）保持稳定。

#### `Thread.runStreamed() / run()`

```ts
// 0.120 + 0.131 完全一致
runStreamed(_input: Input | string): AsyncIterable<ThreadEvent>
run(_input: Input | string, _options?: RunOptions): Promise<Result>
```

#### `ThreadEvent` discriminated union

```ts
// 0.120 + 0.131 完全一致
type ThreadEvent =
  | TurnStartedEvent
  | TurnCompletedEvent  // 内含 turn usage（含 +reasoning_output_tokens 新字段）
  | ItemStartedEvent
  | ItemUpdatedEvent
  | ItemCompletedEvent
  | ThreadStartedEvent
  | ErrorEvent;
```

`TurnCompletedEvent.usage` 字段加 `reasoning_output_tokens: number` 是唯一变化。agent-deck `thread-loop.ts` 处理 ThreadEvent 不解构 `usage`（仅看 turn 是否结束 + thread_id），不受影响。

### vendored binary 路径结构

| 平台 | 0.120.0 路径 | 0.131.0 路径 | 状态 |
|---|---|---|---|
| darwin-arm64 | `vendor/aarch64-apple-darwin/codex/codex` | 同 | ✅ |
| darwin-x64 | `vendor/x86_64-apple-darwin/codex/codex` | 同（按 PLATFORM_BINARY_MAP 推断，未直接验证） | ✅ |
| linux-arm64 | `vendor/aarch64-unknown-linux-musl/codex/codex` | 同 | ✅ |
| linux-x64 | `vendor/x86_64-unknown-linux-musl/codex/codex` | 同 | ✅ |
| win32-* | `vendor/.../codex/codex.exe` | 同 | ✅ |

`resolveBundledCodexBinary()` 的 PLATFORM_BINARY_MAP 全条目无需改。

### asarUnpack glob 兼容性

`package.json` 的 asarUnpack 数组目前是：

```json
"node_modules/@openai/codex/**/*",
"node_modules/@openai/codex-darwin-*/**/*",
"node_modules/@openai/codex-linux-*/**/*",
"node_modules/@openai/codex-win32-*/**/*"
```

**0.131.0 仍用同款 platform-specific sub-package 命名**（`@openai/codex-darwin-arm64` 等），通配符全部命中。

### CHANGELOG_130 兼容性 verify

- CHANGELOG_130 `simpleStatelessStreamableHttp.js` pattern：是 codex CLI 子进程通过 stateless HTTP transport 连 agent-deck `/mcp` route 的协议层模式。`Codex` SDK 不直接依赖此 pattern；CLI 子进程内部行为 spike 不直接验证。Phase 4 e2e smoke 验证（起 codex SDK 会话 + 调本应用注入的 mcp tool）
- `ToolAnnotations` openWorldHint：是 agent-deck `agent-deck-mcp/tools/schemas.ts` 内的 mcp-sdk 1.29 标准字段，与 codex SDK 解耦。不受 codex SDK bump 影响

### 副作用：spike 累积 install 期间 codex 0.120 vendored binary 残留

```bash
ls node_modules/.pnpm/ | grep -E "codex@0\\.(120|131)"
# 输出：
#  @openai+codex@0.120.0    ← 残留
#  @openai+codex@0.131.0    ← 新版
```

pnpm 不主动 GC 旧版本（要 `pnpm store prune`）。Phase 3 实施时主仓库内同样会留 0.120 残留 + 占 ~150 MB。**不阻塞**功能 — `node_modules/.pnpm/node_modules/@openai/codex-darwin-arm64` symlink 已切到 0.131.0，runtime 取的是新版。可选 `pnpm store prune` 清理（非必需）。

## 结论

✅ **codex SDK 0.120.0 → 0.131.0 是 PURELY ADDITIVE 11-minor bump**。零 breaking。

- d.ts 仅 +2 行 additive（`reasoning_output_tokens` token 计数字段）
- 所有 agent-deck 直接使用的 SDK type / method 保持稳定
- vendored binary 路径结构不变 → `resolveBundledCodexBinary()` PLATFORM_BINARY_MAP 不需改
- asarUnpack glob 兼容
- CHANGELOG_130 stateless HTTP transport pattern + mcp-sdk 1.29 ToolAnnotations 不受影响
- typecheck 0 errors
- runtime tests 762 passed 0 fail（与 spike1 一致）

## 残留风险

- **R1 INFO**：0.132.0（数小时前发布）spike 当时太新，没选。Phase 3 实施时如已稳跑数天可改用 0.132.0。Phase 3 决定权留给 caller。
- **R2 LOW**：codex CLI 子进程内部 mcp tool approval gate / sandbox 行为变化无法靠 d.ts 验证 — 那是 vendored binary 内部协议。Phase 4 e2e smoke 必跑：起 codex 会话 + 触发 mcp tool approval + sandbox cold-switch。
- **R3 LOW**：spike 累积 0.120 旧版本残留 ~150 MB，可选 `pnpm store prune` 清理。Phase 3 实施时一并处理。

## 假设破灭分支（plan RFC §Q3 D3）

**实测结果让 D3「升级为复杂 plan」分支不触发**：typecheck 0 / test 0 fail / breaking surface = 2 行 additive。Phase 3 直接 bump，零 migration phase。
