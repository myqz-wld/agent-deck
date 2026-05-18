# Spike 4 Report: claude -p 内部 Bash / Read 工具在 codex sandbox 嵌套层下是否跑通

**Date**: 2026-05-18
**Status**: ✅ Complete — **PASS**
**Drives**: P4 Step 4.3 决策(reviewer-claude.md `codex 视角` wrapper 是否限「纯文本 review,不用工具」)
**codex-sdk version**: 0.120.0
**claude CLI version**: 安装在 `/Users/apple/.nvm/versions/node/v24.10.0/bin/claude`

## 问题

Spike 3 已实证 codex sandbox `workspace-write` 内 spawn `claude -p "say hi"` 完整跑通(spawn + 网络 + OAuth + jsonl 写,33s 返回 "你好 👋")。但**没测 claude 自己内部调用 Bash / Read / Write 工具**。

claude CLI 在 codex 子 sandbox 内被 spawn 出来后,自己会再起一层 sandbox-exec(macOS claude SDK 自身的工具隔离机制)。**双层嵌套 sandbox-exec 是否会拦下 claude 的内部工具调用?**

结论分流(plan §P4 Step 4.0):
- ✅ **PASS** → 进 Step 4.3 — reviewer-claude.md (codex 视角) wrapper 正常写,claude 可以真用 Bash / Read 读源码做 review
- ❌ **FAIL** → 决策:要么调整 wrapper 让 claude 只跑「纯文本 review,不用工具」(功能阉割但仍 feasible);要么找 claude CLI 的 `--no-sandbox` 类似 escape hatch(无该 flag 时只能阉割)

## 验证手段

写 `spike4-runner.mjs`(本目录) — 与 spike3-runner 同款架构(file:// 绝对路径 import codex-sdk + 绝对路径 node binary + 中性变量名 + `low` reasoning effort + webSearchEnabled=false)。

单 sandbox mode (`workspace-write`,D3 决策的生产默认档) 跑一遍 2 个 Test,每个 Test 让 codex 内 shell 起一次 `claude -p` 跑指定工具:

| Test | claude 内部工具 | 验证 | 关键字 |
|---|---|---|---|
| **Test 1** | `Bash` 工具 | claude 调 Bash 跑 `cat /tmp/hello.txt`,把 "say hi" 报告 + 单独说 "BASH_TOOL_OK" | BASH_TOOL_OK + "say hi" |
| **Test 2** | `Read` 工具 | claude 调 Read 工具读 `/tmp/hello.txt`,把内容报告 + 单独说 "READ_TOOL_OK" | READ_TOOL_OK + "say hi" |

`startThread` 关键 option(同 spike3):
- `sandboxMode: 'workspace-write'`(生产默认档)
- `approvalPolicy: 'never'`(SDK 无 UI 弹审批会挂)
- `networkAccessEnabled: true`(claude CLI 需 HTTP 调 Anthropic API)
- `additionalDirectories: ['/Users/apple/.claude', '/Users/apple/.codex', '/tmp']`(claude 读 OAuth creds + 写 session jsonl + Test 1/2 工作区)
- `workingDirectory: <worktree-abs-path>` + `skipGitRepoCheck: true`

`claude -p` 关键 flag:
- `--permission-mode bypassPermissions`(oneshot 模式必需 — 不然 claude 内部工具撞默认 default 模式会试图弹审批 → SDK 无 UI 挂死)

## 结论

✅ **codex workspace-write sandbox + claude 自己嵌套 sandbox-exec 双层下,claude 内部 Bash + Read 工具都跑通。reviewer-claude.md (codex 视角) wrapper 可以正常让 claude 真用工具读源码做 review。**

### 实测结果

| Test | 耗时(端到端含 codex 一轮)| 内部工具 | 关键字命中 | 结论 |
|---|---|---|---|---|
| **Test 1** | 49.4s 两 Test 合跑 | Bash | ✅ `BASH_TOOL_OK` + `say hi` | **PASS** |
| **Test 2** | 同上 | Read | ✅ `READ_TOOL_OK` + `say hi` | **PASS** |

完整 finalResponse(codex 端反馈):

```text
**Test 1**

完整 stdout：

```text

cat 输出：
\`\`\`
say hi
\`\`\`

BASH_TOOL_OK
EXIT=0
```

- 退出码：`EXIT=0`
- 是否出现 `BASH_TOOL_OK`：是
- 输出是否含 `say hi`：是

**Test 2**

完整 stdout：

```text

文件内容：
\`\`\`
say hi
\`\`\`

READ_TOOL_OK
EXIT=0
```

- 退出码：`EXIT=0`
- 是否出现 `READ_TOOL_OK`：是
- 输出是否含 `say hi`：是

**总结**
- Test 1 PASS：出现 `BASH_TOOL_OK`，且输出含 `say hi`
- Test 2 PASS：出现 `READ_TOOL_OK`，且输出含 `say hi`
```

runner SUMMARY 块(机器解析):

```json
{
  "elapsedSeconds": 49.4,
  "test1_bash_pass": true,
  "test2_read_pass": true,
  "responseLen": 378
}
```

### 关键观察:嵌套 sandbox-exec 不互相干扰

双层 sandbox-exec 嵌套场景实测**透明**:
- 外层 codex sandbox `workspace-write`:允许 spawn 外部 CLI(spike 3 证)+ 允许 claude 写 `~/.claude/`(jsonl)+ 允许网络(API)
- 内层 claude 自己起的 sandbox:允许 claude 内部 Bash 跑 `cat /tmp/hello.txt`(`/tmp` 已在 `additionalDirectories`)+ 允许 Read 工具读 `/tmp/hello.txt`

两层叠加后,Test 1 的 `cat /tmp/hello.txt` 经过路径:
1. codex SDK 的 shell tool 在 codex sandbox-exec 内 spawn `claude -p` 子进程 — 允许(spike3 证)
2. claude SDK 在自己 sandbox-exec 内调内部 Bash 工具 spawn `cat` — 允许
3. `cat` 读 `/tmp/hello.txt` — 允许(两层 sandbox 都准 `/tmp` 读)

任一层拦下都会失败,实测两层全允许。

### `additionalDirectories` 必须包含 `/tmp`(关键发现)

spike3 的 `additionalDirectories` 只含 `/Users/apple/.claude`(够用 spike3 的 "say hi" 因为没 fs 操作)。spike4 因为 Test 1/2 涉及 `/tmp/hello.txt` 读,必须显式加 `/tmp`,否则:
- 外层 codex sandbox 不准 claude 子进程 spawn 的 `cat` 访问 `/tmp`(`workspace-write` 默认只准 `workingDirectory` 即 worktree)→ `cat` 撞 sandbox-exec 拒读
- 实测加了 `/tmp` 后 PASS

**对 P4 Step 4.2/4.3 实施影响**:`additionalDirectories` 至少需要 `['/Users/apple/.claude', '/Users/apple/.codex', '/tmp']`(或更精确按 reviewer 实际读写路径调)。reviewer-claude wrapper 让 claude 读项目源码做 review 时,`additionalDirectories` 必须包含项目根(`workingDirectory` 自动允许 + workspace-write 默认写权)。

### claude -p 必须传 `--permission-mode bypassPermissions`(oneshot 必需)

claude SDK 默认 `permissionMode: 'default'`,即工具调用前弹审批。oneshot `-p` 模式无 UI,默认会挂死。
- 实测 `--permission-mode bypassPermissions` 让 claude 内部工具直接通,Test 1/2 全 PASS
- 备选 `--dangerously-skip-permissions`(同效)— wrapper 用哪个等同(plan §Step 4.3 wrapper body 写时用 `--permission-mode bypassPermissions`,语义更清晰且与 codex SDK `approvalPolicy:'never'` 对仗)

## D3 异构矩阵最终结论(更新 spike3)

✅ **4 种异构矩阵全部 feasible 不变,reviewer-claude (codex 视角) wrapper 功能完整**:

| Lead | Reviewer | spike3 状态 | spike4 状态 | 最终结论 |
|---|---|---|---|---|
| claude lead | reviewer-claude teammate | ✅ 现状已有 | N/A | ✅ |
| claude lead | reviewer-codex teammate | ✅ 现状已有 | N/A | ✅ |
| codex lead | reviewer-codex teammate | 🟢 spike 2 实证 | N/A | ✅ |
| **codex lead** | **reviewer-claude teammate** | 🟢 spike 3 实证 spawn 通 | 🟢 **spike 4 实证内部工具通** | ✅ **wrapper 不阉割** |

## 影响范围

- **P4 Step 4.3** `resources/codex-config/agent-deck-plugin/agents/reviewer-claude.md` (codex 视角 wrapper):**按 plan §Step 4.3 v3/v4 原案正常写,不限「纯文本 review」**;wrapper body 内的 Bash 模板可让 claude 真用 Bash + Read 读源码;关键 flag `--permission-mode bypassPermissions`
- **P4 Step 4.2** `resources/codex-config/agent-deck-plugin/agents/reviewer-codex.md` (codex 视角 teammate):无 spike4 直接影响(reviewer-codex 不嵌套 spawn claude — codex 自己跑 review)
- **codex teammate spawn 默认 option**(P3 已落地的 options-builder default):无需改动 — spike4 用的 `additionalDirectories` 是 spike runner 显式传,生产路径走 options-builder spread default
- **P3 options-builder default 的 additionalDirectories**:已是 `['/Users/apple/.claude', '/Users/apple/.codex']`(P3 Step 3.5 落地的 spike3 推荐值)。**spike4 发现新需求 — 还需加 `/tmp`**(reviewer-claude wrapper 可能写中间文件 `/tmp/<input>.txt` `/tmp/<output>.txt`)。**v4.1 follow-up**:P3 Step 3.5 的 default `additionalDirectories` 可在 P4 Step 4.3 wrapper body 落地时一并补 `/tmp`,或在 P5 Step 5.3 fix review finding 时补
  - 备选:不改 default,reviewer-claude wrapper body 内提示「Bash 用 worktree 内文件交换,不用 /tmp」— 但 wrapper 模板写 worktree 内中间文件更冗长,默认走 /tmp 更简洁
- **不**影响:Spike 1 (transport 注入)/ Spike 2 (per-session Codex) / Spike 3 (sandbox spawn 外部 CLI)— 三 spike 结论独立完整

## 残留风险

- ❓ **bypassPermissions vs claude 内部 hook**:本 spike 测的是 claude SDK 默认 hook 设置(无自定义)。如果生产 reviewer 跑时 claude 加载用户 `~/.claude/settings.json` 里的 hook(`UserPromptSubmit` / `PreToolUse` 等),hook 可能改变工具调用行为。实测 spike4 用户 `~/.claude/settings.json` 实际配置不可知,但 PASS 说明默认链路 OK。**对 P4 Step 4.3 wrapper 内容无影响** — wrapper body 写 Bash 起 claude 命令时可显式 `--setting-sources ''`(claude `--help` 节确认支持)排除用户 hook 干扰;或保持默认让用户 hook 生效(更接近真人跑 claude 体验)。两可,P4 Step 4.3 写 wrapper body 时选一种 + 注释说明
- ❓ **claude -p Write 工具 / Edit 工具 / 其他工具未实测**:本 spike 只测 Bash + Read(reviewer wrapper 核心工具)。Write / Edit / Glob / Grep 等其他工具是否在嵌套 sandbox 内跑通**未测**。对 reviewer-claude wrapper 影响:**轻微** — reviewer 主路径只需 Bash + Read 读源码 + 在 stdout 输出 finding,不需 Write / Edit。但万一 reviewer 主动调 Glob 找文件 / Grep 搜代码,行为未知。**P5 Step 5.4.5 pre-archive smoke test 可补端到端真测**(跑一个 reviewer-claude teammate 让它 grep 后再写 finding,看是否撞内部 Glob/Grep 沙箱问题)
- ❓ **claude SDK 版本依赖**:本 spike claude CLI 是 `/Users/apple/.nvm/versions/node/v24.10.0/bin/claude` 用户安装版。生产 codex teammate wrapper 路径 P3 用 `resolveBundledClaudeBinary()`(打包内置 claude SDK 版本可能不同)。SDK 跨版本嵌套 sandbox 行为如有差异(claude SDK 自己改了 sandbox-exec rule)需重 spike。**M7 helper 应该使用与本机一致 SDK 版本**,若打包内置版本与用户机器有 major 差异,P5 Step 5.4.5 实测确认
- ❓ **`--permission-mode bypassPermissions` 安全语义**:bypassPermissions 让 claude 跳过工具审批 — 在 reviewer wrapper 场景安全可接受(reviewer 只读 review,不改文件;且整体被 codex sandbox-exec workspace-write 兜底)。**双层兜底**:外层 codex sandbox 仍限制 claude 子进程的 fs 写权限到 worktree + additionalDirectories,即使 bypassPermissions 也不能跑出 sandbox。**对 P4 Step 4.3 影响**:wrapper body 可大胆用 bypassPermissions

## 与 Spike 1 / 2 / 3 的衔接

Spike 4 与前 3 个 spike 解的问题正交:
- Spike 1: caller_session_id transport 注入(走 mcp-sdk extra.authInfo)
- Spike 2: codex SDK env snapshot 时机(走 per-session 新建 Codex)
- Spike 3: codex SDK 内 spawn 外部 CLI 子进程的 sandbox 限制
- **Spike 4: claude -p 在 codex sandbox 内嵌套层下 claude 自己工具是否跑通 → P4 Step 4.3 wrapper 不阉割决策**

4 个 spike 各自独立完整 → 可继续 **P4 Step 4.1**(写 CODEX_AGENTS.md)
