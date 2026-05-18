# Spike 3 Report: codex SDK 默认 sandbox 是否允许 spawn 外部 CLI 子进程

**Date**: 2026-05-18
**Status**: ✅ Complete
**Drives**: D3 异构矩阵决策(4 种 vs 3 种) + reviewer-claude.md (codex 视角) wrapper 路径可行性
**codex-sdk version**: 0.120.0

## 问题

应用 SDK 在 P3/P4 计划写 `reviewer-claude.md (codex 视角)` —— 让 codex teammate 通过 Bash 起外部 `claude -p` 子进程拿 oneshot 输出当 reviewer 结论(同 user CLAUDE.md §决策对抗 主路径中 reviewer-claude.sh.tmpl 套路反向版本)。但 codex SDK 默认走 sandbox 限制 (`workspace-write`)，需要回答:

1. **sandbox 是否阻塞 spawn 外部 CLI 子进程?**(macOS sandbox-exec 内任意 exec 都被拒还是只拦特定路径?)
2. **3 档 sandbox(workspace-write / read-only / danger-full-access) 各档行为如何?**
3. **完整 reviewer-claude wrapper 路径**(claude CLI 需 spawn + 网络 + 读 OAuth creds + 写 session jsonl)**在 sandbox 内能跑通吗?**

结论分流:
- 3 档全跑通 → D3 4 种异构矩阵 feasible(claude lead × {claude, codex} reviewer + codex lead × {claude, codex} reviewer)
- 只 danger-full-access 能跑通 → 生产不能用 → D3 退化 3 种矩阵, reviewer-claude.md (codex 视角) wrapper 放弃, codex lead 只能配 reviewer-codex teammate(同源)
- workspace-write 能跑通 + 其他档不行 → D3 4 种 feasible 但生产强制 workspace-write 一档(其他档不支持 reviewer-claude wrapper)

## 验证手段

写 `spike3-runner.mjs`(本目录) —— 与 spike2-runner 同款架构(file:// 绝对路径 import codex-sdk + 绝对路径 node + 中性变量名 + `low` reasoning effort + webSearchEnabled=false)。3 个 sandbox mode 串行各跑一遍 4 step 探测 prompt:

- Step 1: `/bin/ls -la /tmp/hello.txt` —— spawn 外部 ls(纯 read)
- Step 2: `/bin/cat /tmp/hello.txt` —— spawn 外部 cat(纯 read fs)
- Step 3: `claude --version` —— spawn node + claude.mjs(无网络,只读 install dir)
- Step 4: `claude -p "say hi"` —— spawn + 网络 + 读 OAuth creds + 写 session jsonl(完整 reviewer-claude wrapper 路径)

`startThread` 关键 option:
- `approvalPolicy: 'never'` —— 避 codex SDK 在 spawn 外部 CLI 时弹审批(SDK 无 UI 会挂)
- `networkAccessEnabled: true` —— claude CLI 需 HTTP 调 Anthropic API
- `additionalDirectories: ['/Users/apple/.claude']` —— claude 读 OAuth `~/.claude/.credentials.json` + 写 session jsonl 到 `~/.claude/projects/`
- `workingDirectory: <worktree-abs-path>` + `skipGitRepoCheck: true`

## 结论

✅ **codex SDK 0.120.0 sandbox 不阻塞 spawn 外部 CLI 子进程本身;workspace-write(SDK 默认档)完整支持 reviewer-claude wrapper 路径 → D3 4 种异构矩阵 feasible。**

### 3 档实测结果矩阵

| Sandbox Mode | 耗时 | Step 1 ls | Step 2 cat | Step 3 claude --version | Step 4 claude -p "say hi" | 结论 |
|---|---|---|---|---|---|---|
| **workspace-write** | 33s | ✅ EXIT=0 | ✅ EXIT=0 | ✅ EXIT=0 | ✅ EXIT=0 (返回 "你好 👋") | **完整支持 reviewer wrapper** |
| **read-only** | 107s | ✅ EXIT=0 | ✅ EXIT=0 | ✅ EXIT=0 | 🟡 spawn 成功但进程挂起无 stdout/stderr → 推测某非 spawn 资源被沙箱拒 | spawn 本身允许;但 reviewer wrapper 完整链路不跑通 |
| **danger-full-access** | 34s | ✅ EXIT=0 | ✅ EXIT=0 | ✅ EXIT=0 | ✅ EXIT=0 (返回 "你好 👋") | 对照基线正常 |

### read-only Step 4 hang 根因诊断(不影响 D3 结论)

read-only 档 Step 1-3 全 PASS(包括 Step 3 `claude --version` spawn 外部 CLI)→ **证明 sandbox 不阻 spawn 行为本身**。

Step 4 `claude -p "say hi"` 失败模式:codex SDK 报 `write_stdin failed: stdin is closed for this session; rerun exec_command with tty=true to keep stdin open` —— 子进程已 spawn 成功但 hang 无输出;耗时 107s 远超 workspace-write 的 33s 即 codex 多轮等待重试后才放弃。

未深究根因(超出 spike 范围),按可能性排序推测:
1. claude CLI 启动后试写 session jsonl 到 `~/.claude/projects/<encoded-cwd>/` —— **read-only 沙箱拒 fs write** → claude 等待写完成挂起
2. claude CLI 通过 HTTP 调 Anthropic API —— read-only 默认 network blocked? 待 P4 实施时实测确认
3. claude CLI OAuth flow 试写 token refresh —— 同 1
4. 其他(不像 spawn 本身被拒 —— Step 3 已证 spawn 允许)

**对 D3 结论无影响** —— 生产环境 codex teammate adapter 走 SDK 默认档 `workspace-write`(不走 read-only),完整 reviewer-claude wrapper 路径已实测通。read-only 档行为留 P4 实施时如有需要再补 spike。

### 关键观察:codex shell tool 的 spawn 能力

3 档全 PASS Step 1-3(`/bin/ls` / `/bin/cat` / `claude --version` 均 spawn 外部子进程)证明:**codex 的 shell tool 在所有 sandbox 档都允许 spawn 外部 CLI**;sandbox 限制只在子进程内部行为(读 / 写 / 网络)层面 enforce,不在 exec 调用本身 enforce。这对 D3 4 种异构矩阵决策是**强证据**。

## D3 异构矩阵结论

✅ **4 种异构矩阵全部 feasible**:

| Lead | Reviewer | 实现方式 | 状态 |
|---|---|---|---|
| **claude lead** | reviewer-claude teammate | 现有 `resources/claude-config/agent-deck-plugin/agents/reviewer-claude.md`(SDK 直接 spawn claude-code SDK 子 session) | ✅ 现状已有 |
| **claude lead** | reviewer-codex teammate | 现有 `resources/claude-config/agent-deck-plugin/agents/reviewer-codex.md`(SDK spawn claude-code 子 session, 子 session Bash 起外部 codex CLI 拿 oneshot 输出) | ✅ 现状已有 |
| **codex lead** | reviewer-codex teammate | P3/P4 新建 `resources/codex-config/agent-deck-plugin/agents/reviewer-codex.md`(codex SDK 直接 spawn codex SDK 子 session) | 🟢 Spike 2 实证 codex SDK 子进程模型 OK |
| **codex lead** | reviewer-claude teammate | P3/P4 新建 `resources/codex-config/agent-deck-plugin/agents/reviewer-claude.md`(codex SDK spawn codex 子 session, 子 session Bash 起外部 claude CLI 拿 oneshot 输出) | 🟢 **本 spike 实证 feasible** |

`reviewer-claude.md (codex 视角)` 实现要求:
- codex teammate 在 SDK spawn 时必须配 `sandboxMode: 'workspace-write'`(SDK 默认档,无需特殊)+ `additionalDirectories: ['~/.claude']`(关键! 否则 claude CLI 起不来或挂)+ `networkAccessEnabled: true`(SDK 默认在 workspace-write 下大概率是 true,P3 实施时实测确认)
- agent body prompt 写 Bash 起 claude 命令模板用 `PATH="$(dirname $(which node)):$PATH" /abs/path/to/claude -p < /tmp/<input>.txt > /tmp/<output>.txt 2>&1` 类似套路(参考 user CLAUDE.md §决策对抗 主路径 reviewer-claude.sh.tmpl 反向版本)
- 同步 `approvalPolicy: 'never'` 防 SDK 在 spawn 外部 CLI 时弹审批(P3 spawn handler 实施时确认 codex-cli adapter teammate spawn 已默认 'never' 或显式传)

## 影响范围

- **新增**(D3 4 种 feasible 落地): 
  - `resources/codex-config/agent-deck-plugin/agents/reviewer-claude.md`(P3/P4 写,codex 视角 wrapper)
  - `resources/codex-config/agent-deck-plugin/agents/reviewer-codex.md`(P3/P4 写,codex 视角 teammate)
  - codex-cli adapter 的 startThread option 必须加 `additionalDirectories: ['~/.claude', '~/.codex']`(P3 实施,reviewer-claude wrapper 路径必需 + codex 自己 config 路径双覆盖)
- **codex teammate spawn 默认 option 调整**(P3 spawn handler):
  - 强制 `sandboxMode: 'workspace-write'`(SDK 默认)+ `approvalPolicy: 'never'`(防审批挂) + `networkAccessEnabled: true`(显式 true 兜底,reviewer-claude wrapper 需 claude CLI 网络)+ `additionalDirectories: ['~/.claude', '~/.codex']`(reviewer-claude wrapper + codex config 双覆盖)
- **不**影响:Spike 1 + Spike 2 已定的 transport 注入 / per-session Codex 实例修法

## 残留风险

- ❓ **read-only Step 4 根因未确定**:本 spike 未深究 claude -p 在 read-only 下挂的具体根因(jsonl write / network / OAuth flow)。**对 D3 结论无影响**(生产走 workspace-write);若 P4 实施时遇到 reviewer-claude wrapper 偶发 hang,可作为排查方向参考
- ❓ **codex SDK approvalPolicy='never' + claude CLI 行为耦合**:本 spike 设 `'never'` 直接通过未撞拒;若未来 codex SDK 升级把 spawn 外部 CLI 类操作划进 "永远要审批" 白名单,需重 spike
- ❓ **codex CLI 在 sandbox 内的 child_process spawn 实现细节**:本 spike 黑盒测得 sandbox 不阻 spawn 行为本身,未读 codex CLI 源码确认 spawn 实现走什么 sandbox-exec rule 集。若 P4 实施时调试需深入,可读 `~/.codex/dist/` codex CLI 源码 + 看 sandbox-exec config 反推 rule 集
- ❓ **网络限制行为档差异**:本 spike 显式设 `networkAccessEnabled: true`,但 SDK 默认值未实测(workspace-write 默认 true? read-only 默认 false?)。P3 实施时建议 codex teammate spawn 默认显式传 `true`(reviewer-claude wrapper 必需),不依赖隐式默认

## 与 Spike 1 / Spike 2 的衔接

Spike 3 与 Spike 1/2 解的问题正交:
- Spike 1 解 caller_session_id transport 注入(走 mcp-sdk extra.authInfo)
- Spike 2 解 codex SDK env snapshot 时机(走 per-session 新建 Codex 实例)
- **Spike 3 解 codex SDK 内 spawn 外部 CLI 子进程的沙箱限制 → D3 矩阵决策**

3 个 spike 各自独立完整 → 可进 **P0.5 plan v3 综合重写**(综合 3 个 spike 结果重写 P1/P2/P3 详细 step)。
