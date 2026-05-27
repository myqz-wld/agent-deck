---
spike_id: spike1
topic: SDK 0.3.144 system prompt 注入位置与 preset 行为实测
created_at: 2026-05-27
plan: prompt-asset-review-optimize-20260527
---

# Spike 1：SDK 0.3.144 system prompt 注入位置 / preset 替换语义

## 动机

需求 3「agent-deck 内置提示词放 system prompt 最前面（现在最后）」需要确认 SDK API 实际能力：
- 是否支持 prepend
- 用 string 形式自定义 system prompt 时，preset claude_code 内容（environment / git status / system reminder / tools 说明等）是否会自动追加
- preset.append 强化措辞达到「优先级最高」是否切实可行（替代 prepend）

## 假设（待验证）

H1：SDK 没有 prepend 字段，要前置只能用 string 形式 → string 形式会丢 preset claude_code 内容
H2：preset.append 强化措辞「本节优先级最高 / 覆盖前文冲突」可达到等价语义效果
H3：preset 内容（environment / git status / tools）走 SDK CLI flag 注入，可从 CLI binary 帮助 doc 反查实际语义

## 实测命令

### 1. SDK 内部 systemPrompt 字段处理（sdk.mjs 源码）

```bash
zsh -i -l -c 'node -e "..." (见下方代码段)'
```

实测节选 sdk.mjs 第 115 行字面代码：

```javascript
let {systemPrompt:X, ...} = $??{}, V, B, z;
if (X === void 0) V = "";
else if (typeof X === "string") V = X;          // string 形式
else if (Array.isArray(X)) V = X;               // string[] 形式
else if (X.type === "preset") {
  B = X.append;                                  // preset.append
  z = X.excludeDynamicSections;
}
// ... 然后透传给 CLI
let CS = {
  systemPrompt: V,         // 走 CLI --system-prompt flag
  appendSystemPrompt: B,   // 走 CLI --append-system-prompt flag
  excludeDynamicSections: z,
  ...
};
```

### 2. CLI flag 实际语义（claude --help 文档）

```bash
zsh -i -l -c "claude --help" | grep -A 2 -i 'system'
```

输出（关键三段）：

```
--system-prompt <prompt>                          System prompt to use for the session
--append-system-prompt <prompt>                   Append a system prompt to the default system prompt
--exclude-dynamic-system-prompt-sections          Move per-machine sections (cwd, env info, memory paths,
                                                  git status) from the system prompt into the first user
                                                  message. ... Only applies with the default system prompt
                                                  (ignored with --system-prompt). (default: false)
```

### 3. SDK 暴露的 preset 复刻 API 反查

```javascript
['SYSTEM_PROMPT_DYNAMIC', 'getSystemPrompt', 'defaultSystemPrompt',
 'PRESET_CLAUDE_CODE', 'claudeCodePreset', 'baseSystemPrompt'].forEach(...)
```

实测：
- `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` **存在**（仅作 string[] 形式 cache 边界标记，非 preset 内容）
- 其余 5 个 **NOT FOUND** —— **SDK 不暴露 preset claude_code 实际内容**

## 实测结果

### H1 验证：✅ 成立（铁证）

- `--system-prompt`（即 SDK string 形式）= **完全替换** 默认 preset，preset claude_code 整段不展开（含 environment / git status / system reminder / tools 说明 / 模型 cutoff / IMPORTANT 安全约束等）
- `--append-system-prompt`（即 SDK preset.append 形式）= 追加到默认 preset 末尾
- **SDK 没有 prepend 字段** — string 形式整段替换 / preset 形式只能末尾追加

### H2 验证：⚠️ 部分成立（语义最高优先级 ≠ 字面位置最前）

- 强化措辞如「本节优先级最高 / 与前文冲突时本节胜」可让模型把这段当 highest priority 处理
- **但物理位置仍在 system prompt 末尾**（在 user/project/local CLAUDE.md 之后）
- 字面意义「放最前面」需要走 string 形式 + 自己复刻 preset 内容

### H3 验证：✅ 成立但代价高

- preset 内容走 CLI 内置注入（不走 SDK 暴露 API），SDK / CLI 都不导出 preset 字符串
- 想完整复刻必须靠**反向工程 cli.js**（13MB 压缩 binary，反编译 + 跟踪每次 SDK 升级，工程不可持续）
- 仅靠 SDK 暴露的 SYSTEM_PROMPT_DYNAMIC_BOUNDARY 不足以复刻 preset 内容

## 结论

### 两条实现路径对比

| 路径 | SDK 字段 | 物理位置 | 维护成本 | excludeDynamicSections 是否生效 | 风险 |
|---|---|---|---|---|---|
| **A. preset.append + 强化措辞** | `systemPrompt: { type:'preset', preset:'claude_code', append: <agent-deck 头部强措辞 + body> }` | 末尾（preset 之后） | 低（沿用现状） | ✅ 生效（fleet 缓存友好） | 物理位置不是字面「最前」，但语义可由强措辞达到优先级最高 |
| **B. string 形式 + 复刻 preset** | `systemPrompt: <agent-deck body> + <复刻 preset 内容>` | 字面最前 | 极高（反编译 cli.js 复刻 + 跟踪每次升级） | ❌ Ignored（CLI 实测 only applies with default system prompt） | (1) 复刻不全漏 preset 关键节如系统 reminder / tools 说明（模型行为可能漂移） (2) SDK 升级 preset 不会自动跟随 (3) 失去 cross-user prompt cache reuse 优化 (4) 高出错风险 |

### 推荐：**Path A（preset.append + 强化措辞）**

理由：
1. 用户需求 3「放最前面」语义本质是「这部分约定优先级要最高，覆盖前文冲突」 — 强化措辞可等价达成
2. Path B 工程不可持续（cli.js 13MB binary 反编译跟踪 + SDK 升级跟随成本）
3. Path A 保留 SDK preset 内置约束（如 IMPORTANT 安全 / tools 说明 / environment）— 这些是模型必备 baseline
4. excludeDynamicSections 字段保留可用，未来若需 fleet cache 优化仍可启用

### 残留风险

1. 强化措辞的「优先级最高」是软约束，模型在极端冲突场景仍可能优先 preset 内置规则（如 IMPORTANT 安全约束）— 应用层无法绕过 SDK 内置安全规则（这是合理边界，agent-deck 约定不应覆盖安全规则）
2. agent-deck CLAUDE.md 头部强措辞需要每个版本回归验证（避免措辞不够强导致模型忽略），加 review checkpoint
3. 用户若坚持物理位置「字面最前」，需走 Path B + 接受 4 项风险（极端不推荐）

### 落地动作（Path A）

1. agent-deck CLAUDE.md（claude / codex 两份）头部加强化措辞节
2. 不改 sdk-injection.ts 的 SDK 字段
3. 不动 SDK 升级跟随
