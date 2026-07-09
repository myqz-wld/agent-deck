# Spike 3: claudeCliPath 优先级链 design 验证

## 动机

plan §Step 0.5 spike3。RFC R1.Q1 user 选「镜像 codex」— 优先级链 `(claudeCliPath && trim) || getPathToClaudeCodeExecutable()`。spike 验证：

1. codex 的 inline pattern（`(path && path.trim()) || resolveBundledCodexBinary()`）能否字面照搬到 claude？
2. claude 端 call sites 数量 + 改动 LOC 估算？
3. 与现有 `getPathToClaudeCodeExecutable()` 的语义边界是否清晰？
4. tests 是否需要新增 / mock 调整？

注：本 spike 不在 worktree 内 modify 代码（代码 modify 是 Phase 1 实施）— 仅做静态 design 分析 + 关键 decision 落地。

## 假设

- H1：claude SDK call sites 数量 ≤ 3（≤ codex 的 2 个 + 给点 buffer），inline 改动 LOC 总 ≤ 10
- H2：`getPathToClaudeCodeExecutable()` 不需要重命名 / 重写 — 保留为「bundled fallback resolver」
- H3：`settingsStore` 在 caller 文件中可能尚未 import，需要 +1 import line
- H4：tests 不需要新加（已有的 mock `getPathToClaudeCodeExecutable: () => '/fake/cli'` 与 `settingsStore.get('claudeCliPath')` 的优先级链 fallback 都被现有 unit test 直接 / 间接覆盖）；新加 unit test 仅当想直接测优先级链行为本身

## 实测命令

### Step 1：枚举所有 `getPathToClaudeCodeExecutable()` call sites

```bash
grep -rn "getPathToClaudeCodeExecutable\\(\\)" src/
# 输出（去 helper 自身定义）：
# src/main/adapters/claude-code/sdk-bridge/index.ts:253  ← live SDK session createSession
# src/main/session/oneshot-llm/claude-runner.ts:55       ← oneshot summarizer + handoff runner
```

**实测 N = 2 production call sites**。与 codex 镜像数量一致（codex 也是 2 个：`codex-instance-pool.ts:46` + `codex-cli/sdk-bridge/index.ts:240`）。

### Step 2：审计 codex 端 inline pattern（mirror 模板）

`src/main/adapters/codex-cli/codex-instance-pool.ts:44-46`：

```ts
export async function getCodexInstance(): Promise<Codex> {
  const path = settingsStore.get('codexCliPath');
  const overridePath = (path && path.trim()) || resolveBundledCodexBinary();
  if (cachedCodex && cachedPath === overridePath) return cachedCodex;
  ...
}
```

`src/main/adapters/codex-cli/sdk-bridge/index.ts:239-240`：

```ts
const codexCliPath = settingsStore.get('codexCliPath');
const overridePath = (codexCliPath && codexCliPath.trim()) || resolveBundledCodexBinary();
```

**模式**：
1. settingsStore.get 读 path（同步，零开销）
2. trim 非空判断 → 用作 override
3. 否则 fallback bundled
4. `||` 短路求值确保 user override 永远胜过 bundled

### Step 3：claude 端 mirror inline pattern（draft，Phase 1 实施）

#### claude `sdk-bridge/index.ts:253` 改造（current snapshot）

```ts
// CURRENT (line 250-253)
const { query } = await loadSdk();
const runtime = getSdkRuntimeOptions();
const claudeBinary = getPathToClaudeCodeExecutable();
```

#### Phase 1 实施 target

```ts
const { query } = await loadSdk();
const runtime = getSdkRuntimeOptions();
const claudeCliPath = settingsStore.get('claudeCliPath');
const claudeBinary = (claudeCliPath && claudeCliPath.trim()) || getPathToClaudeCodeExecutable();
```

**改动 LOC**：+2（一行 settingsStore.get + 改一行赋值），需 +1 import line（如未存在）。

#### claude-runner.ts:55 改造（同款 mirror）

```ts
// CURRENT
const sdk = await loadSdk();
const runtime = getSdkRuntimeOptions();
const claudeBinary = getPathToClaudeCodeExecutable();
```

target：

```ts
const sdk = await loadSdk();
const runtime = getSdkRuntimeOptions();
const claudeCliPath = settingsStore.get('claudeCliPath');
const claudeBinary = (claudeCliPath && claudeCliPath.trim()) || getPathToClaudeCodeExecutable();
```

**改动 LOC**：+2，需 +1 import line `import { settingsStore } from '@main/store/settings-store';`（实测 grep 现文件无此 import）。

### Step 4：现有 import 状态

```bash
grep -n "settingsStore" src/main/adapters/claude-code/sdk-bridge/index.ts
# 输出：（无） — 需 +1 import
grep -n "settingsStore" src/main/session/oneshot-llm/claude-runner.ts
# 输出：（无） — 需 +1 import
```

两个 caller 都需新增 `import { settingsStore } from '@main/store/settings-store';`。

### Step 5：settings.ts schema 改动（draft，Phase 1 实施）

`src/shared/types/settings.ts`：

```ts
// 新增字段（紧挨 codexCliPath，~line 124）
/**
 * 用户填的 Claude CLI 二进制路径覆盖（与 codexCliPath 字面镜像）。
 * 留空 → fallback `getPathToClaudeCodeExecutable()` 用应用内置 SDK binary。
 * 填路径 → 走该 binary（如自装的 Claude CLI / 自构 binary）。
 *
 * agent-deck 不读不写 ~/.claude/.credentials.json — 鉴权由 user 终端处理。
 */
claudeCliPath: string | null;
```

`DEFAULT_SETTINGS` 新增：

```ts
codexCliPath: null,  // 现有
claudeCliPath: null,  // 新增（紧挨 codexCliPath）
```

### Step 6：ipc/settings.ts hot-toggle helper

`src/main/ipc/settings.ts`（现有 codexCliPath 钩子参考 line 85-87）：

```ts
// 现有
if ('codexCliPath' in p) {
  adapterRegistry.get('codex-cli')?.setCodexCliPath?.(next.codexCliPath);
}
// 新增（紧挨）
if ('claudeCliPath' in p) {
  // claude SDK call sites 每次 createSession 都重新 settingsStore.get（不像 codex 持 instance），
  // 不需要 invalidate ANY in-memory state — 即改即生效（下次 createSession 用新路径）
  // — 与 codex setCodexCliPath()「path 变更只 invalidate 缓存实例 + 已 spawn 子进程不受影响」
  // 同模式（spike 2 §1 同款 mental model）
}
```

**关键差异**（与 codex 不同）：claude 端不需要 `bridge.setClaudeCliPath()` invalidate 方法 — 因为 claude SDK 没有 instance pool / per-session bridge cache。每次 createSession 都重新 `settingsStore.get('claudeCliPath')`。已 spawn 中的 SDK 会话子进程已经把 binary path 喂给 cli.js 子进程，不受后续 setting 变更影响（与 codex 实测铁证一致）。

### Step 7：renderer ExternalToolsSection.tsx 控件

`src/renderer/components/settings/sections/ExternalToolsSection.tsx`（现有 codexCliPath UI 参考 line 13-18）：

```tsx
// 现有
<ExecutablePicker
  label="Codex 二进制路径"
  hint="留空 = 用应用内置 codex（推荐）。填路径 = 覆盖为外部 codex（如 `which codex` 给的路径）"
  path={settings.codexCliPath}
  onChange={(p) => void update({ codexCliPath: p })}
/>
// 新增（在 codex 控件之后追加 — 同 Section 内）
<ExecutablePicker
  label="Claude 二进制路径"
  hint="留空 = 用应用内置 Claude CLI（推荐）。填路径 = 覆盖为外部 Claude CLI（如 `which claude` 给的路径）"
  path={settings.claudeCliPath}
  onChange={(p) => void update({ claudeCliPath: p })}
/>
```

### Step 8：tests 影响 audit

#### 现有 mock 模式

```bash
grep -rn "getPathToClaudeCodeExecutable: ()" src/main
# 输出（实测）：
# src/main/adapters/claude-code/__tests__/sdk-bridge.consume-fork.test.ts:33
# src/main/adapters/claude-code/__tests__/sdk-bridge.recovery.test.ts:60
# src/main/adapters/claude-code/sdk-bridge/__tests__/createsession-fail-fast.test.ts:74
# src/main/adapters/claude-code/sdk-bridge/__tests__/setttimeout-fallback-symmetry.test.ts:76
# src/main/session/__tests__/hand-off.test.ts:24
# 共 5 处 mock，全部形如 `getPathToClaudeCodeExecutable: () => '/fake/cli'`
```

**改动后影响**：现有 mock 仍然有效 — 它们 mock 整个 `sdk-runtime` module（`vi.mock('@main/adapters/claude-code/sdk-runtime')`），返回固定的 `/fake/cli`。优先级链 `(path && trim) || getPathToClaudeCodeExecutable()` 跑到 `||` 右侧时 mock 仍生效。

#### 修订（Step 1.5 Deep-Review R1 L-HIGH-2 实测铁证）

**初版 spike3 §Step 8 列「4 处现有 mock — file-change-intent-delay.test.ts / hand-off.test.ts 没 mock」claim 与实测铁证矛盾,实测真实分布**:

```bash
grep -rln "settingsStore\\|settings-store" src/main/adapters/claude-code/__tests__ src/main/adapters/claude-code/sdk-bridge/__tests__ src/main/session/__tests__
# 实测命中 5 文件:
# src/main/adapters/claude-code/__tests__/sdk-bridge.recovery.test.ts
# src/main/adapters/claude-code/sdk-bridge/__tests__/createsession-fail-fast.test.ts
# src/main/adapters/claude-code/sdk-bridge/__tests__/setttimeout-fallback-symmetry.test.ts
# src/main/adapters/claude-code/sdk-bridge/__tests__/set-permission-mode-rollback.test.ts  ← 初版漏列
# src/main/session/__tests__/hand-off.test.ts                                              ← 初版列入"没 mock"误
# 不命中:
# src/main/adapters/claude-code/__tests__/sdk-bridge.consume-fork.test.ts                  ← 初版列入"已 mock"误
# src/main/adapters/claude-code/sdk-bridge/__tests__/file-change-intent-delay.test.ts      ← 初版列入"没 mock"误
```

**修正后实际 mock 状态**(每文件 grep + Read 实证):

| 测试文件 | 走 priority chain? | settings-store mock 状态 | 是否需新增 mock |
|---|---|---|---|
| `createsession-fail-fast.test.ts` | 是 | 已 mock | 否 |
| `setttimeout-fallback-symmetry.test.ts` | 是 | 已 mock | 否 |
| `sdk-bridge.recovery.test.ts` | 是 | 已 mock | 否 |
| `set-permission-mode-rollback.test.ts` | 是 | 已 mock(line 51-52)| 否 |
| `hand-off.test.ts` | 是(走 oneshot runner)| 未 vi.mock 但走真 store(line 197+202+210 `await import` + `settingsStore.set('handOffModel', ...)`),priority chain `(undefined && trim) || fallback` 短路至 fallback,sdk-runtime mock(line 24)接住 | 否(强加 vi.mock 会破坏现有 handOffModel 测试) |
| `sdk-bridge.consume-fork.test.ts` | 否(TestBridge override createSession 直接 return mock handle)| 不需要 | 否 |
| `file-change-intent-delay.test.ts` | 否(仅测 sdk-message-translate 纯函数 + StreamProcessor,0 处 sdk-bridge / sdk-runtime / settings-store 引用)| 不需要 | 否 |

#### 修法(Phase 1 实施时):**0 mock 改动需要**

priority chain `(claudeCliPath && trim) || fallback` 短路语义自动接住未 mock 的 `settingsStore.get` 返 undefined / null;现有 5 个测试已直接 / 间接 mock 接住。

**改动 LOC**:**+0**(初版估算 +16 LOC 是误判,plan §1.6 / §动机 LOC 估算同步修订)。如未来想加 test isolation 守门(防 user 真 settings.json 写过 claudeCliPath 让本地 test fail),可在 hand-off.test.ts 顶部 `beforeAll` 加 `settingsStore.set('claudeCliPath', null)` 显式归零,但不在 Phase 1 范围。

### Step 9：unit test 新增建议

新加一个 priority chain 行为单测（可选，但推荐 — 验证 user override 真生效）：

```ts
// 建议位置：src/main/adapters/claude-code/__tests__/claude-cli-path-priority.test.ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('@main/store/settings-store', () => ({ settingsStore: { get: vi.fn() } }));
vi.mock('@main/adapters/claude-code/sdk-runtime', () => ({
  getPathToClaudeCodeExecutable: vi.fn(() => '/bundled/claude'),
  getSdkRuntimeOptions: () => ({ executable: 'node', env: {} }),
}));

describe('claudeCliPath priority chain', () => {
  it('user 填非空路径 → 用 user override', async () => {
    const { settingsStore } = await import('@main/store/settings-store');
    (settingsStore.get as any).mockReturnValue('/user/claude');
    // ... 测试 sdk-bridge createSession 实际传给 query() 的 pathToClaudeCodeExecutable 是 /user/claude
  });

  it('user 填空 / null → fallback bundled', async () => {
    const { settingsStore } = await import('@main/store/settings-store');
    (settingsStore.get as any).mockReturnValue(null);
    // ... 验证 fallback 到 /bundled/claude
  });

  it('user 填全空白字符 → 视为空，fallback bundled', async () => {
    const { settingsStore } = await import('@main/store/settings-store');
    (settingsStore.get as any).mockReturnValue('   \t  ');
    // trim 后空 → fallback bundled
  });
});
```

**改动 LOC**：~80 LOC（新文件 + 3 test cases）。Phase 1 实施时可选加 — 不强求（codex 等价 priority chain 现没有专门 unit test，依靠 instance-pool 自身测）。

## 实测结果

### Design 验证 ✅

- **N=2 call sites 完全镜像 codex pattern**（与假设 H1 完全一致 — codex 也是 2 个）
- **getPathToClaudeCodeExecutable() 保留作 bundled fallback resolver**（H2 ✅ — 不需重命名 / 重写，纯加 caller 包裹层）
- **2 个 caller 文件需 +1 import settingsStore**（H3 ✅ 实测）
- **现有 5 个测试 mock 兼容 — priority chain `(claudeCliPath && trim) || fallback` 短路语义自动接住未 mock 的 settingsStore.get 返 undefined,无需新增 mock**(H4 ✅ 完整,详 §Step 8 修订节)

### LOC 估算（Phase 1 总改动量,Step 1.5 Deep-Review R1+R2 修订后精确）

| 改动点 | LOC |
|---|---|
| `settings.ts` 加字段 + DEFAULT 默认 | ~15 |
| `ipc/settings.ts` 加 hot-toggle 钩子 | ~5 |
| `sdk-bridge/index.ts` 加 priority chain inline + import | ~3 |
| `claude-runner.ts` 加 priority chain inline + import | ~3 |
| `ExternalToolsSection.tsx` 加 ExecutablePicker 控件 | ~6 |
| 新加 priority chain unit test（可选） | ~80 |
| **合计 base（必做）** | **~32** |
| **合计含可选 unit test** | **~112** |

base ~32 LOC 与 plan §Phase 1 标题描述对齐(R1+R2 修订后)。**确认 Phase 1 是 trivial 难度**。

### 边界 / 注意事项

#### B1：`(path && path.trim()) || ...` 短路语义 ✅

- `path=null` → falsy → 走 `||` 右侧 fallback ✅
- `path=""` → falsy → fallback ✅
- `path="   \t  "` → truthy 但 trim 后空 → `path.trim()=""` falsy → fallback ✅
- `path="/usr/bin/claude"` → truthy + trim 非空 → user override ✅
- `path="  /usr/bin/claude  "` → truthy + trim 非空（含空白前后缀） → 注意：返回 `path.trim()` 是 `/usr/bin/claude`，而不是原 path（含空白）✅ — 这是 codex 现行行为 + 静默自动 trim 是 user-friendly 的（filepicker 残留空白不会让 spawn 失败）

#### B2：existsSync 检查 — 不做 ❌

codex 现行 `(path && path.trim()) || resolveBundledCodexBinary()` 不调 `existsSync(path)` 验证 user 填的路径真实存在 — 让 SDK spawn 时自然报 ENOENT，user 自己处理。镜像 codex → claude 也不做 existsSync 检查。如想做更严的护栏（先 existsSync 再用），那是后续 follow-up，不在本 plan 范围。

#### B3：与 K7 unpack 解析的关系 ✅

claude SDK 内部 K7 函数 通过 `require.resolve('@anthropic-ai/claude-agent-sdk-${plat}-${arch}/claude')` 拿 binary 路径。当 user override `claudeCliPath` 非空时，priority chain 直接返回 user 路径 → query() 拿到的是 user 路径（不再走 K7） → SDK spawn 直接调用 user binary。**user override 短路 K7 完全成立**，不存在「K7 仍解析 bundled binary 把 user override 覆盖」的反向覆盖风险。

#### B4：dev 模式行为 ✅

dev 模式下 `getPathToClaudeCodeExecutable()` 返回 `node_modules/...` 真实路径（无 asar）。如果 dev user 测 claudeCliPath override 填了别的路径，priority chain 仍按 `user > bundled` 走。dev 模式不影响 priority chain 逻辑。

#### B5：peer dep `@anthropic-ai/sdk` warning 透明 ✅

spike1 §peer dep warning 节提到的 `@anthropic-ai/sdk@>=0.93.0` 警告与 priority chain 无关。两者解耦，priority chain 是设置项 → SDK options 透传；peer dep 是间接 dependency 版本约束。

## 结论

✅ **claudeCliPath priority chain 是 codex pattern 字面镜像**。Design 简单清晰，零边界争议。

- N=2 call sites（与 codex 一致）
- 改动总 LOC ~32（base）/ ~112（含可选 unit test）— Step 1.5 Deep-Review R1+R2 修订后精确数字
- inline `(path && path.trim()) || getPathToClaudeCodeExecutable()` pattern 可直接照搬 codex
- `getPathToClaudeCodeExecutable()` 保留语义（bundled fallback resolver），不需要重命名 / 重写
- 现有 5 个测试 mock 兼容(详 §Step 8 修订节);**无需新增 mock**(priority chain 短路语义自动接住未 mock 的 settingsStore.get)
- 可选新加 priority chain 单测（+80 LOC，Phase 1 自决）

## 残留风险

- **R1 LOW**：Phase 1 实施时如果 user 填的 claudeCliPath 撞 ENOENT，错误体现为 SDK spawn 失败 + recoverer cwd fallback 链触发。是 user 自己填错路径，不算 plan bug。如果未来想加 existsSync 护栏（保护 user）— follow-up plan 处理。
- **R2 LOW**：Phase 1 implementation 时如发现 sdk-bridge.ts:253 周围 import 顺序 / 注释顺序与 codex pattern 微差，按现行风格走 — 不强求字面镜像。

## 假设破灭分支

无。3 个假设 H1-H4 全部 ✅。Phase 1 直接按本 spike Step 5-9 写 design，不需触发任何 fallback 决策。
