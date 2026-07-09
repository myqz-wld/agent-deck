---
spike: 1
topic: spawn env.PATH 实测 + $SHELL -ilc 行为验证
plan_id: sdk-spawn-shell-path-20260529
date: 2026-05-29
status: completed
---

# spike1 — SDK 子进程 PATH 实测 + $SHELL -ilc 行为验证

## 动机

User 反馈「reviewer-claude / reviewer-codex teammate spawn 起来后 sandbox 内跑 `pnpm` 撞 `command not found`,但 lead 端 / 直接终端 pnpm 已安装且可用」。RFC 阶段 user 进一步问「这是不是只能解决 pnpm 的问题,有没有更加通用和泛化的解决逻辑」,选定 X1 方案 (主进程启动时实测用户终端 PATH 缓存 + spawn 子进程用之)。

本 spike 验证 X1 方案核心假设:
1. SDK 子进程当前 PATH 实际值是什么?
2. `$SHELL -ilc 'echo $PATH'` 拿到的用户真实终端 PATH 是什么?
3. 两者 diff 多大? pnpm 是不是真在用户 PATH 不在 SDK PATH?
4. 应用层 spawn options.env 当前怎么注入?
5. `$SHELL -ilc` 启动 cost 多少? 跨 shell 兼容性如何?

## 假设

- **H1**: SDK 子进程 PATH 与主进程 process.env.PATH 一致(主进程 spread)
- **H2**: 主进程 PATH ≠ 用户终端 PATH (macOS .app launchd 启动 minimal PATH 已知问题)
- **H3**: pnpm 在用户终端 PATH (corepack-managed via nvm)
- **H4**: pnpm 不在 SDK 子进程 PATH
- **H5**: `$SHELL -ilc` 启动 cost < 1s 可接受
- **H6**: bash/zsh -ilc 都支持,但 bash 不读 zsh 配置文件,所以必须用 user $SHELL

## 实测命令

### Finding A: SDK 子进程 PATH 实际值

```bash
$ echo "$PATH" | tr ':' '\n'
```

输出 (当前 Claude Code SDK 子进程内):
```
/usr/bin
/bin
/usr/sbin
/sbin
/Users/apple/Library/Application Support/agent-deck/agent-deck-plugin/bin
```

**只 5 条路径** — launchd minimal PATH (4 条) + agent-deck plugin bin (1 条,应用安装时注入)。

### Finding B: 用户真实终端 PATH ($SHELL -ilc)

```bash
$ zsh -i -l -c 'echo "$PATH"' | tr ':' '\n'
```

输出:
```
/Users/apple/.mavis/bin
/Users/apple/.opencode/bin
/Users/apple/.bun/bin
/Users/apple/.claude
/Users/apple/.antigravity/antigravity/bin
/Users/apple/.nvm/versions/node/v24.10.0/bin
/Users/apple/.gvm/pkgsets/go1.19/global/bin
/Users/apple/.gvm/gos/go1.19/bin
/Users/apple/.gvm/pkgsets/go1.19/global/overlay/bin
/Users/apple/.gvm/bin
/opt/homebrew/bin
/opt/homebrew/sbin
/usr/local/bin
/System/Cryptexes/App/usr/bin
/usr/bin
/bin
/usr/sbin
/sbin
/var/run/com.apple.security.cryptexd/codex.system/bootstrap/usr/local/bin
/var/run/com.apple.security.cryptexd/codex.system/bootstrap/usr/bin
/var/run/com.apple.security.cryptexd/codex.system/bootstrap/usr/appleinternal/bin
/usr/local/go/bin
/Users/apple/.cargo/bin
/Users/apple/Library/Application Support/agent-deck/agent-deck-plugin/bin
```

**22 条路径** (含 user-defined + system + agent-deck plugin)。

### Finding C: SDK 缺失的 17 条路径

用户终端 PATH ∖ SDK 子进程 PATH:

| 缺失路径 | 用途 |
|---|---|
| /Users/apple/.mavis/bin | 用户自定义 |
| /Users/apple/.opencode/bin | 用户工具 |
| /Users/apple/.bun/bin | Bun 运行时 |
| /Users/apple/.claude | Claude 自家 |
| /Users/apple/.antigravity/antigravity/bin | 用户工具 |
| /Users/apple/.nvm/versions/node/v24.10.0/bin | **nvm Node 24 (含 pnpm corepack shim)** |
| /Users/apple/.gvm/* (4 条) | Go 版本管理 |
| /opt/homebrew/bin | **Homebrew binaries (含 npm/git/cargo/python 等)** |
| /opt/homebrew/sbin | Homebrew sbin |
| /usr/local/bin | 传统 /usr/local |
| /System/Cryptexes/App/usr/bin | macOS Cryptex |
| /var/run/com.apple.security.cryptexd/* (3 条) | macOS Cryptex 引导 |
| /usr/local/go/bin | Go 默认安装 |
| /Users/apple/.cargo/bin | **Rust cargo binaries** |

**核心命中**: nvm Node 24 不在 SDK PATH → corepack pnpm shim 找不到 → `pnpm command not found`。同款问题影响 cargo / brew / bun / go 等任何用户终端可用的 CLI。

### Finding D: pnpm 安装方式

```bash
$ which pnpm 2>&1
pnpm not found  # ← 仅在 SDK 子进程 PATH 不含 nvm 时

$ zsh -i -l -c "which pnpm 2>&1 ; pnpm --version 2>&1"
/Users/apple/.nvm/versions/node/v24.10.0/bin/pnpm
10.33.0
```

- pnpm **未全局可执行二进制安装** (/opt/homebrew/bin/pnpm 不存在 / /usr/local/bin/pnpm 不存在 / ~/Library/pnpm/pnpm 不存在)
- pnpm 走 **nvm Node 24 内置 corepack shim** (典型 corepack-managed pnpm)
- 修复 PATH 加入 ~/.nvm/versions/node/v24.10.0/bin → pnpm 立即可用

### Finding E: 应用 spawn options.env 当前实现

**claude-code adapter** (`src/main/adapters/claude-code/sdk-runtime.ts:40-57`):

```ts
export function getSdkRuntimeOptions(): {
  executable: 'node';
  env: Record<string, string>;
} {
  const baseEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') baseEnv[k] = v;
  }
  return {
    executable: process.execPath as unknown as 'node',
    env: {
      ...baseEnv,
      ELECTRON_RUN_AS_NODE: '1',
    },
  };
}
```

**baseEnv 100% 拷贝 process.env**。SDK 子进程 PATH = process.env.PATH = launchd PATH(双击 .app 启动场景)。

**codex-cli adapter** (`src/main/adapters/codex-cli/sdk-bridge/index.ts:57-63`):

```ts
function snapshotProcessEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}
```

**同款 process.env spread**。

**已知 bug 注释** (`sdk-runtime.ts:6-9`):
> macOS .app 走 launchd 启动时 PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin`，nvm/homebrew 装的 node 都不在里面 → spawn ENOENT。

**评价**: 已知 PATH 缺失问题,但当前修法只通过 `executable: process.execPath` (Electron 二进制) 绕开 Node 找不到,**没修 PATH 本身** — 所以 SDK 子进程内部跑 `pnpm` 等用户终端命令仍然撞 PATH 缺失。

### Finding F: $SHELL -ilc 启动 cost

```bash
$ for i in 1 2 3 4 5; do /usr/bin/time -p zsh -i -l -c 'echo "$PATH" > /dev/null' 2>&1 | grep -E 'real|user' | head -2; done
real 0.51
user 0.19
real 0.46
user 0.18
real 0.46
user 0.18
real 0.46
user 0.18
real 0.44
user 0.17
```

平均 **460ms wall time / 180ms user time**。主进程启动多加 ~460ms,用户感知不到 (Electron 启动本身几秒)。

### Finding G: 跨 shell 兼容性

```bash
$ bash -ilc 'echo "$PATH"' 2>&1 | head -3
bash: no job control in this shell  ← 警告但成功
/Users/apple/.cargo/bin:/usr/local/bin:/System/Cryptexes/App/usr/bin:...

$ sh -lc 'echo "$PATH"' 2>&1 | head -3
/Users/apple/.cargo/bin:/usr/local/bin:/System/Cryptexes/App/usr/bin:...
```

**重要发现**: bash -ilc 输出的 PATH **比 zsh -ilc 少很多** — bash 不读 ~/.zshrc 的 nvm/brew 配置,所以**修法必须用 user `$SHELL` 不假设 zsh**。

/etc/shells 默认列表: /bin/bash, /bin/csh, /bin/dash, /bin/ksh, /bin/sh, /bin/tcsh. **⚠ Round 2 reviewer-codex 现场实测推翻原断言**:zsh/bash/sh/dash/ksh `-ilc` 返 code 0 成功;但 `/bin/tcsh -ilc 'echo ok'` 返 `code=1 err=Unknown option: '-lc'`,`/bin/csh -ilc` 同款失败 — tcsh/csh 不支持 `-ilc` 复合标志,不属于支持集合。本轮 plan §不变量 11 收紧为「zsh/bash/sh/dash/ksh」(spike1 + codex Round 2 双实测 backing);**tcsh/csh** 与 fish/nu 一起进 explicit non-goal(详 plan §已知踩坑 2)。

**fish shell 例外**: fish 不支持 `-i` (用 `-l -c` 替代),需 fallback 处理。

## 结论

### 假设验证结果

| 假设 | 结果 | 证据 |
|---|---|---|
| H1: SDK 子进程 PATH = 主进程 process.env.PATH | ✅ 实证 | Finding E `baseEnv = {...process.env}` |
| H2: 主进程 PATH ≠ 用户终端 PATH (.app launchd minimal) | ✅ 实证 | Finding A (5 条) vs Finding B (22 条),Finding E 注释明文确认 |
| H3: pnpm 在用户终端 PATH | ✅ 实证 | Finding D `which pnpm` → ~/.nvm/.../pnpm |
| H4: pnpm 不在 SDK 子进程 PATH | ✅ 实证 | Finding A 缺 ~/.nvm/.../bin |
| H5: $SHELL -ilc cost < 1s 可接受 | ✅ 实证 | Finding F 平均 460ms |
| H6: bash/zsh -ilc 都支持但 bash 不读 zsh 配置 | ✅ 实证 | Finding G bash/zsh 输出 PATH 不同 |

### X1 修法实施细节

**⚠ EVOLVED**:本 §helper 代码示例为 spike 初版,Step 1 plan 写作 + Step 1.5 Deep-Review 评审后 evolved 到以下变更(SSOT 在 plan `<plan_id>.md` §设计决策 + §不变量 6):
- **memo sentinel 改设计**:用独立 `captured: boolean` + `cached: string | null` 区分「未初始化」vs「已捕获含 null」,**失败路径也命中 memo**(避免每次调用都重跑 execSync + 重复 warn + 重复 3s timeout 风险)。本 spike 示例 L222 `let _cached: string | null = null;` + L250 `_cached = null` 失败路径与 L233 `if (_cached !== null) return _cached;` 条件不命中冲突,**plan 实施时按 sentinel 二分**(reviewer-codex Round 1 MED-2 fix)。
- **execSync → execFileSync**:用 argv API `execFileSync(shell, ['-ilc', 'printf "%s\\n" "$PATH"'], { ... })` 替代字符串拼接 `\`"${shell}" -ilc 'echo "$PATH"'\``,避免 `$SHELL` 含 quote / space 时命令注入面(reviewer-codex Round 1 MED-3 hardening)。
- **修法落点**:plan 简化为单点 `bootstrap-infra.ts` mutate `process.env.PATH`,**不**改 sdk-runtime.ts / codex-cli/sdk-bridge/index.ts(RFC Round 5 Q4 「主进程 process.env.PATH 也 union」决策)。本 spike §2 §3 提议的 adapter 两处改不再实施 — 详 plan §修法落点 §evolved 注脚。

以下原 spike 示例代码保留作历史 reference:

**修法核心**:
1. **`src/main/utils/user-shell-path.ts` 新建 helper** (主进程启动时一次性跑):
   ```ts
   import { execSync } from 'node:child_process';
   let _cached: string | null = null;

   /**
    * 主进程启动时调一次,缓存用户真实终端 PATH。
    * 走用户实际 $SHELL 执行 `-ilc echo $PATH`,以便复现用户终端 PATH 配置
    * (nvm/brew/cargo 等用户 shell rc 文件 sourced 加载的路径)。
    *
    * 失败兜底: $SHELL 未设 / shell 跑挂 / 输出空 → 返 null + console.warn,
    * caller 用 process.env.PATH 兜底 (原始行为不退化)。
    */
   export function captureUserShellPath(): string | null {
     if (_cached !== null) return _cached;
     const shell = process.env.SHELL || '/bin/zsh';
     try {
       // -i interactive + -l login 让 shell rc 文件被加载 (~/.zshrc / ~/.bash_profile)
       // -c 跑 echo PATH 输出最后一行 (避免 rc 文件可能 echo 干扰)
       const out = execSync(`"${shell}" -ilc 'echo "$PATH"'`, {
         encoding: 'utf8',
         timeout: 3000,
         stdio: ['ignore', 'pipe', 'ignore'],
       }).trim();
       const lines = out.split('\n').filter((l) => l.trim());
       _cached = lines.length > 0 ? lines[lines.length - 1] : null;
       return _cached;
     } catch (err) {
       console.warn(
         `[user-shell-path] failed to capture user shell PATH via "${shell} -ilc": ${(err as Error).message}`,
       );
       _cached = null;
       return null;
     }
   }

   /**
    * 用 user shell PATH union (用户 PATH 优先) 原 PATH。
    * 失败兜底直接返原 PATH。
    */
   export function unionUserShellPath(originalPath: string | undefined): string {
     const userPath = captureUserShellPath();
     if (!userPath) return originalPath ?? '';
     if (!originalPath) return userPath;
     return `${userPath}:${originalPath}`;
   }
   ```

2. **`src/main/adapters/claude-code/sdk-runtime.ts` 改 `baseEnv` 构造**:
   ```ts
   const baseEnv: Record<string, string> = {};
   for (const [k, v] of Object.entries(process.env)) {
     if (typeof v === 'string') baseEnv[k] = v;
   }
   // SDK 子进程 PATH 用 user shell PATH union 优先 (修复 .app launchd minimal PATH)
   baseEnv.PATH = unionUserShellPath(process.env.PATH);
   ```

3. **`src/main/adapters/codex-cli/sdk-bridge/index.ts` 改 `snapshotProcessEnv`**:
   ```ts
   function snapshotProcessEnv(): Record<string, string> {
     const out: Record<string, string> = {};
     for (const [k, v] of Object.entries(process.env)) {
       if (v !== undefined) out[k] = v;
     }
     out.PATH = unionUserShellPath(process.env.PATH);
     return out;
   }
   ```

4. **主进程启动时调一次 `captureUserShellPath()` 预热缓存**(避免 spawn 第一次撞 460ms cost):
   - 落 `src/main/index/bootstrap-infra.ts` 或 `src/main/index.ts` 应用启动入口

### 残留风险

1. **fish shell 用户**: fish 不支持 `-i` flag,会 fallback 到 `console.warn + process.env.PATH 兜底`。Fish 用户 SDK 子进程 PATH 仍是 launchd minimal,pnpm 仍找不到。**建议**: 修法第二阶段加 fish-specific fallback (`fish -l -c 'echo $PATH'` 或 macOS path_helper 兜底)。本 spike 不阻塞 — fish 是小众用户。

2. **$SHELL 指向非 shell 程序** (用户恶意 / 误配置): `$SHELL=/usr/bin/something` 不可执行 → execSync throw → 走 console.warn 兜底。安全。

3. **PATH 含重复条目** (union 后): 操作系统 lookup 遇重复路径 in-order skip,**不报错仅多点 IO**。Finding A 末条 agent-deck-plugin/bin 与 Finding B 末条同 — union 后会出现一次重复 (用户 PATH 末尾 + process.env.PATH 末尾)。可接受。

4. **bash -ilc warning "no job control"**: bash interactive mode 在非 TTY stdin 下 emit 此 warning 到 stderr — 用 `stdio: ['ignore', 'pipe', 'ignore']` 抑制 stderr 即可不污染主进程 log。

5. **shell rc 文件耗时**: 用户 ~/.zshrc 跑 oh-my-zsh / nvm slow init / starship prompt 等可能让 cost > 460ms。worst case 几秒。**建议**: timeout 3000ms 保护 + 失败兜底降级 (已在 helper 实现)。

6. **未来 user 切 shell (zsh → fish)**: 应用启动后 cache 永远不重算。**接受** — 切 shell 重启应用即可,符合 macOS 应用约定。

### 不变量

- 不引入新依赖 ✅ (helper 只用 node:child_process)
- process.env 其他字段不动 ✅ (只改 PATH)
- 失败不破坏现状 ✅ (兜底用 process.env.PATH,与现在行为一致)
- 所有 SDK spawn (含 lead) 统一受益 ✅ (sdk-runtime.ts + codex-cli/sdk-bridge/index.ts 两处覆盖)

## inform Step 1 plan 决策

- **修法落点**: 2 文件 (`sdk-runtime.ts` + `codex-cli/sdk-bridge/index.ts`) + 1 新 helper (`user-shell-path.ts`) + 1 启动入口预热 (`bootstrap-infra.ts` or `index.ts`)
- **测试矩阵**: 4 case (corepack pnpm via nvm / brew pnpm / standalone ~/Library/pnpm / 未装 pnpm 底线) — spike 实测 user 是 case 1 (corepack via nvm)
- **不变量**: PATH 只补不替 (union 优先用户 PATH) / 失败兜底 process.env.PATH / 不引依赖 / fish 暂时不支持但 fallback 安全
- **超出 scope follow-up**: fish 兜底 (建议第二阶段) / 应用启动 PATH 预热与否的 UX 权衡 (cold path 460ms vs warm path 0ms) / 用户切 shell 后 cache 失效问题

## 残留待 Step 1 plan 写作时决策的点

1. **PATH union 反向问题**: 用户 PATH 末尾的 `agent-deck-plugin/bin` 与原 process.env.PATH 末尾的同款会重复一次 — 是否要 dedupe? (dedupe 多点 string 比较 cost 但更干净; 不 dedupe 多点 OS lookup IO 但简单) — **倾向不 dedupe** (操作系统 lookup 遇重复 skip 本质无害)
2. **PATH 预热入口**: bootstrap 流程**哪一步**调 `captureUserShellPath()` (让 460ms 在初始化期间消化而非首次 spawn 时延迟)? 启动 splash 之前 / 之后? — **倾向**: settings-env / DB init 之前 (启动早期),让 460ms 与 Electron 启动并行
3. **是否暴露 setting 强制重新 capture**: 用户切 shell / 改 ~/.zshrc 后想立即生效? — **倾向**: 不暴露 setting (符合「切 shell 重启应用」macOS 约定)
4. **是否在 process.env.PATH 上也叠加** (主进程内部 spawn 子进程会受益)? — **倾向**: 是的,union 进 process.env.PATH 让所有主进程子进程 spawn 都受益 (不只 SDK 子进程)
