# Spike 1: claude-agent-sdk 0.2.118 → 0.3.144 API surface 验证

## 动机

plan §Step 0.5 spike1。0.2 → 0.3 是 major version bump，可能含 query() options shape / message event types / hook event types / 内部 SDK 字段 agent-deck 直接访问的 breaking change。spike 出 typecheck error 数量 + test fail 数量 + breaking change inventory。

## 假设

- H1：`query()` 函数签名 `query(_params: { prompt, options? })` 在 0.2 → 0.3 保持稳定
- H2：`Options` type 字段 agent-deck 用到的（cwd / permissionMode / executable / env / pathToClaudeCodeExecutable / sandbox / mcpServers / hooks 等）保持稳定
- H3：`SDKMessage` discriminated union 中 agent-deck 处理的 case（system init / assistant / user / result）shape 保持稳定
- H4：内部 K7 native binary 解析逻辑（`@anthropic-ai/claude-agent-sdk-${platform}-${arch}`）path 段格式不变，agent-deck 的 K7 复刻代码（`getPathToClaudeCodeExecutable()`）仍 work

## 实测命令

### Step 1：scratch worktree 创建（避开污染主仓库）

```bash
git -C /Users/apple/Repository/personal/agent-deck worktree add \
  -b spike/sdk-bump-20260520 \
  /Users/apple/Repository/personal/agent-deck/.claude/worktrees/spike-sdk-bump-20260520
# Verify worktree HEAD == main HEAD（避开 v2.1.112 stale base bug）
git -C <worktree> rev-parse HEAD == git -C <main-repo> rev-parse HEAD
# 实测两者均为 10999c4
```

### Step 2：安装并 baseline typecheck

```bash
cd <spike-worktree> && pnpm install     # 3.9s 内完成（pnpm content-cache hit）
cd <spike-worktree> && pnpm typecheck   # exit 0
```

### Step 3：bump claude SDK + 重 typecheck

```bash
cd <spike-worktree> && pnpm update @anthropic-ai/claude-agent-sdk@0.3.144
# pnpm update 输出：
#  dependencies:
#  - @anthropic-ai/claude-agent-sdk 0.2.118
#  + @anthropic-ai/claude-agent-sdk 0.3.144 (0.3.145 is available)
#  WARN unmet peer @anthropic-ai/sdk@>=0.93.0: found 0.81.0
cd <spike-worktree> && pnpm typecheck   # exit 0
```

### Step 4：tests 全套

```bash
cd <spike-worktree> && pnpm rebuild electron && \
  cd node_modules/.pnpm/electron@33.4.11/node_modules/electron && node install.js  # 修 scratch worktree 后台 install 没跑 electron post-install
cd <spike-worktree> && pnpm test --run
# 结果：Test Files 64 passed | 5 skipped (69)
#       Tests 762 passed | 76 skipped (838)
#       FAIL 0
```

### Step 5：API surface diff（.d.ts 静态对比）

```bash
# 主仓库已装 0.2.118 → cp sdk.d.ts
cp node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts /tmp/claude-0.2.118.d.ts
# npm pack 0.3.144 → 解包 → cp sdk.d.ts
npm pack @anthropic-ai/claude-agent-sdk@0.3.144 -C /tmp/scratch
tar -xzf anthropic-ai-claude-agent-sdk-0.3.144.tgz -C /tmp/scratch/extract
cp /tmp/scratch/extract/package/sdk.d.ts /tmp/claude-0.3.144.d.ts
# Diff 导出名
grep -E "^(export|declare)" /tmp/claude-0.2.118.d.ts | sort -u > /tmp/exports-0.2.118.txt
grep -E "^(export|declare)" /tmp/claude-0.3.144.d.ts | sort -u > /tmp/exports-0.3.144.txt
diff -u /tmp/exports-0.2.118.txt /tmp/exports-0.3.144.txt
# 文件大小：0.2.118 = 5332 行；0.3.144 = 5722 行（+390 行 additive）
# 导出数量：0.2.118 = 253；0.3.144 = 256（净 +3）
```

## 实测结果

### 静态 typecheck

| 指标 | 0.2.118 → 0.3.144 |
|---|---|
| typecheck error 数 | **0** |
| typecheck exit | **0** |

### Runtime test

| 指标 | 0.2.118 → 0.3.144 |
|---|---|
| Test Files passed | 64 |
| Test Files skipped | 5 |
| Tests passed | **762** |
| Tests skipped | 76 |
| Tests failed | **0** |
| pnpm test exit | **0** |

### .d.ts 导出 diff（关键 surface）

#### 移除（4 个）

- `unstable_v2_createSession()` / `unstable_v2_prompt()` / `unstable_v2_resumeSession()` — v2 unstable 实验 API
- `SDKSession` interface / `SDKSessionOptions` type — v2 配套类型
- `PromptRequest` / `PromptRequestOption` / `PromptResponse` types — 旧 SDK 内部 prompt 协议类型

**agent-deck 使用情况**：grep 全 src/ 0 命中（实测命令 `grep -rn "unstable_v2|SDKSession\b|SDKSessionOptions|PromptRequest|PromptResponse" src` 返回空）。**全部安全**。

#### 新增（多个）

- 新 SDK control request 类型：`SDKControlBackgroundTasksRequest` / `SDKControlGetBinaryVersionRequest` / `SDKControlSubmitFeedbackRequest`
- 新 message：`SDKPermissionDeniedMessage`、`SDKTaskSummaryMessage`（出现在 `StdoutMessage` union）
- 新设置 surface：`ResolvedSettings` / `ResolvedSettingSource` / `PolicySettingsOrigin` / `ProvenanceEntry` / `resolveSettings()` / `filterEscalatingDefaultMode()`
- 新 hook：`SessionStoreFlush` literal union
- `Options.toolAliases?: Record<string, string>` 字段（map alias names）
- `Options.allowedTools` jsdoc 警告 `'Skill'` deprecated 改用 `skills` option

**agent-deck 使用情况**：全部 additive，agent-deck 不需要立刻接（也没接），typecheck 不报错。

#### 修改（关键 1 处）

- `SDKAssistantMessageError` enum 加 2 个值：`'oauth_org_not_allowed'` / `'model_not_found'`
- 0.2.118：`'authentication_failed' | 'billing_error' | 'rate_limit' | 'invalid_request' | 'server_error' | 'unknown' | 'max_output_tokens'`
- 0.3.144：`'authentication_failed' | 'oauth_org_not_allowed' | 'billing_error' | 'rate_limit' | 'invalid_request' | 'model_not_found' | 'server_error' | 'unknown' | 'max_output_tokens'`
- agent-deck 使用：grep `SDKAssistantMessageError` 全 src/ 0 命中（实测命令 0 行）。**全部安全**。

### `query()` 签名（agent-deck 主入口）

**0.2.118 与 0.3.144 完全一致**：

```ts
export declare function query(_params: {
    prompt: string | AsyncIterable<SDKUserMessage>;
    options?: Options;
}): Query;
```

`Options` shape 字段对比（agent-deck 用到的部分）：

| 字段 | 0.2.118 | 0.3.144 | 备注 |
|---|---|---|---|
| `cwd?` | `string` | `string` | 不变 |
| `permissionMode?` | `'default' \| 'acceptEdits' \| 'plan' \| 'bypassPermissions'` | 同 | 不变 |
| `executable?` | `'bun' \| 'deno' \| 'node'` | 同 | 不变 |
| `env?` | `Record<string, string \| undefined>` | 同 | 不变 |
| `pathToClaudeCodeExecutable?` | `string` | `string` | 不变（agent-deck SDK runtime helper 接此字段，行为不变） |
| `canUseTool?` | `CanUseTool` callback | 同 | 不变 |
| `hooks?` | `Partial<Record<HookEvent, HookCallbackMatcher[]>>` | 同 | 不变 |
| `sandbox?` | `SandboxSettings` | 同 | 不变 |
| `settingSources?` | `SettingSource[]` | 同 | 不变 |
| `forkSession?` | `boolean` | 同 | 不变 |
| `resume?` | `string` | 同 | 不变 |
| `mcpServers?` | `Record<string, McpServer\|McpSdkServerConfigWithInstance>` | 同 | 不变 |
| `systemPrompt?` | `string \| { type:'preset'... }` | 同 | 不变 |
| `model?` | `string` | 同 | 不变 |

**结论**：agent-deck 的 query() options 24+ 字段调用全部兼容，零 breaking change。

### asarUnpack glob 兼容性

`package.json` 的 asarUnpack 数组目前是：

```json
"node_modules/@anthropic-ai/claude-agent-sdk-darwin-*/**/*",
"node_modules/@anthropic-ai/claude-agent-sdk-linux-*/**/*",
"node_modules/@anthropic-ai/claude-agent-sdk-win32-*/**/*"
```

**0.3.144 仍用同款 platform-specific sub-package 命名**（`@anthropic-ai/claude-agent-sdk-darwin-arm64` 等），通配符全部命中。`getPathToClaudeCodeExecutable()` 内的 `requireFromHere.resolve('@anthropic-ai/claude-agent-sdk-${plat}-${arch}/claude')` 解析逻辑无需改动。实测在 worktree 内 `find node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/` 仍返回 `claude` binary 文件。

### Peer dep warning

`unmet peer @anthropic-ai/sdk@>=0.93.0: found 0.81.0` — claude-agent-sdk 0.3.144 声明 `@anthropic-ai/sdk` peer dep 收紧，agent-deck 自身没直接装 `@anthropic-ai/sdk`（间接通过 claude-agent-sdk 拉的旧版 0.81.0）。pnpm WARN 不阻塞 install / typecheck / test，所有功能正常。可选改进：在 Phase 2 同步装 `@anthropic-ai/sdk@^0.93.0` 当作 dependency 让 peer 满足；但当前不接也无影响，权当 backlog。

## 结论

✅ **claude SDK 0.2.118 → 0.3.144 是 PURELY ADDITIVE major bump**。Major version 数字改了但 API surface 对 agent-deck 零 breaking。

- 所有 agent-deck 直接使用的 query() options 字段不变
- 移除的 4 个导出（unstable_v2_* / SDKSession / PromptRequest 系）agent-deck 0 grep 命中 → 完全无关
- 新增的 6+ 个导出 agent-deck 不需要接 → 无 typecheck 影响
- 1 处修改（`SDKAssistantMessageError` enum 加值）agent-deck 0 grep 命中 → 完全无关
- typecheck 0 errors
- runtime tests 762 passed 0 fail
- asarUnpack glob 兼容
- K7 复刻代码 `getPathToClaudeCodeExecutable()` 路径解析仍 work

## 残留风险

- **R1 LOW**：`@anthropic-ai/sdk` peer dep warning 应在 Phase 2 一并装上当 dependency。不阻塞但留个尾巴。改动：`pnpm add @anthropic-ai/sdk@^0.93.0`，约 +1 dep。
- **R2 LOW**：spike 在 scratch worktree 实测，不等于实施 worktree 实测；Phase 2 重 install 时仍可能撞 npm registry 临时不可用。fallback 走 plan §RFC R1.Q3 D3 升级决策。
- **R3 INFO**：0.3.145 是 spike 当时最新版（< 24h 老）— 选 0.3.144（2 天老）保守。Phase 2 实施时如果 0.3.145 已稳跑数天可选 latest 版。Phase 2 决定权留给 caller。
- **R4 INFO**：spike 验证不含「runtime 真起 SDK session 实跑 query」end-to-end smoke。这是 §Phase 4 e2e smoke 的范围。typecheck + 现有 unit/integration tests 已捕获绝大多数 surface 错；遗漏只能在 Phase 4 实测发现。

## 假设破灭分支（plan RFC §Q3 D3）

**实测结果让 D3「升级为复杂 plan」分支不触发**：typecheck 0 errors / test 0 fail / breaking surface = 0。Phase 2 直接 bump，零 migration phase 需要。
