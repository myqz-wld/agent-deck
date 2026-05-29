/**
 * 主进程启动时一次性实测用户真实终端 PATH 缓存,让所有后续 spawn(SDK 子进程 + 主进程
 * git 等)在 zsh / bash / sh / dash / ksh(`-ilc` 标准兼容 shell)上自动 inherit 完整
 * PATH。修复 macOS .app 走 launchd 启动时 PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin`
 * 导致 SDK 子进程跑 `pnpm` / `cargo` / `brew` 等用户终端 CLI 撞 `command not found` 的
 * 问题。
 *
 * 详细 design 决策见 plan `sdk-spawn-shell-path-20260529.md`(归档于 `ref/plans/`):
 * - **execFileSync argv API**:用 `execFileSync(shell, ['-ilc', '<nonce-printf>'], ...)`
 *   替代 spike1 §X1 helper 的字符串拼 cmd `execSync` 形式,避免 `$SHELL` 含 quote / space
 *   时命令注入面(plan Round 1 reviewer-codex MED-3 hardening)
 * - **per-startup nonce marker 包围 PATH 输出**:用 `__AD_PATH_<crypto.randomUUID()>__`
 *   nonce marker 包围 PATH,**不依赖 stdout 最后一行** — 防 zsh login shell 在 `-c`
 *   命令结束后读 `~/.zlogout` 输出文本污染 last-line(Step 3.6 reviewer-codex Round 1
 *   MED-1 hardening,/tmp HOME + .zlogout 实测铁证)。
 *
 *   **nonce per-startup 替代 hardcoded sentinel**(Step 3.6 deep-review Round 2 双方共识
 *   INFO 级 hardening):rc 文件无法预知主进程启动时随机生成的 UUID,user PATH 含 nonce
 *   字面量概率 ≈ 0(astronomically small UUID v4 collision)。修法独立可加,不引依赖
 *   (`node:crypto` 是 Node 内置)。理论闭口边界 case:① user PATH 含 hardcoded
 *   `__AGENT_DECK_PATH_END__` substring → endIdx 误匹配;② rc echo 在真实 PATH 行前输出
 *   含 BEGIN+END 假对的伪 sentinel 行 → first-match 取假值。reviewer-codex Round 2 现场
 *   实测 (b) 真实存在(临时 HOME 写 `.zshrc` 输出 `__AGENT_DECK_PATH_BEGIN__/fake/bin
 *   __AGENT_DECK_PATH_END__` 让 parser 取 `/fake/bin`)。改 nonce 后两个 attack vector
 *   同时关闭。
 * - **sentinel 二分 memo**:用独立 `captured: boolean` + `cached: string | null` 区分
 *   「未初始化」vs「已捕获含 null」,失败路径也命中 memo(避免每次调用都重跑 execFileSync
 *   + 重复 console.warn + 重复 3s timeout 风险;plan Round 1 reviewer-codex MED-2)。
 *   memo 设计与 PATH bracketing 的 nonce 正交,本字段是 module-state 控制,与 nonce
 *   marker 概念独立(命名上 "sentinel" 指 captured boolean 哨兵)
 * - **fallback 静默降级**:`$SHELL` 未设走 /bin/zsh 兜底跑成功;shell 跑挂 / 输出空 →
 *   console.warn + 返 null,unionUserShellPath 用 originalPath 兜底(行为与原现状一致,
 *   不退化)
 * - **explicit shell 集合 = zsh/bash/sh/dash/ksh**:tcsh/csh/fish/nu 是 explicit non-goal
 *   (codex Round 2 现场实测 `/bin/tcsh -ilc` 与 `/bin/csh -ilc` 返 `Unknown option: '-lc'`
 *   失败;fish 不支持 `-i`)→ fallback 走 process.env.PATH。fish 等用户的 SDK 子进程
 *   PATH 仍是 launchd minimal,留 follow-up plan
 *   `sdk-spawn-shell-path-other-shells-<YYYYMMDD>` 修法
 * - **dedupePath 保留优先序**:Set 保序去重避免 user PATH 末尾与 process.env.PATH 末尾
 *   重复条目(典型 `agent-deck-plugin/bin`)
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

/**
 * Per-startup nonce marker 包围 PATH 输出,模块加载时一次生成。
 *
 * 形态:`__AD_PATH_<uuid-v4>__`(共 48 字符:固定前缀 `__AD_PATH_`(10) + 36 字符 hex/hyphen
 *  UUID v4 + 固定后缀 `__`(2))。
 * - **Per-startup 唯一**:每次主进程启动 / `vi.resetModules()` 重新 import 都生成新 UUID,
 *   rc 文件无法预知,user PATH 含 nonce 字面量概率 ≈ 0
 * - **同一 marker 包围两侧**:`<marker>%s<marker>` printf 输出后用 `indexOf(marker)` 两次
 *   定位,避免 BEGIN/END 双 marker 各自被误匹配的边界 case
 * - **export 给 test 用**:test 必须用真实 marker 构造 mock stdout(否则 parse 拿不到)
 */
export const NONCE_MARKER = `__AD_PATH_${randomUUID()}__`;

let captured = false;
let cached: string | null = null;

/**
 * 主进程启动时调一次,缓存用户真实终端 PATH。
 *
 * 走用户实际 `$SHELL` 执行 `-ilc 'printf "<NONCE>%s<NONCE>\\n" "$PATH"'`,
 * NONCE 是模块加载时一次性生成的 `__AD_PATH_<uuid-v4>__` per-startup nonce,rc 文件无法
 * 预知 → user PATH 含此字面量概率 ≈ 0。解析时 split lines + 找含 NONCE 的行 + 提取两
 * NONCE 之间的内容(同一 marker 包围两侧,`indexOf` 调两次定位 begin/end)。
 *
 * 失败兜底:
 * - `$SHELL` 未设 → 走 `/bin/zsh` 兜底(macOS 默认 shell)
 * - shell 跑挂 / `-ilc` 不支持(tcsh/csh/fish 等)/ 输出无 NONCE → 返 null + console.warn
 *
 * sentinel 二分 memo:用独立 `captured: boolean` + `cached: string | null` 区分
 * 「未初始化」vs「已捕获含 null」— 失败路径也命中 memo(避免每次调用都重跑 execFileSync
 * + 重复 console.warn + 重复 3s timeout 风险)。
 */
export function captureUserShellPath(): string | null {
  if (captured) return cached;
  captured = true;

  const shell = process.env.SHELL || '/bin/zsh';

  try {
    const out = execFileSync(
      shell,
      ['-ilc', `printf "${NONCE_MARKER}%s${NONCE_MARKER}\\n" "$PATH"`],
      {
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    const lines = out.split('\n');
    let pathValue: string | null = null;
    for (const line of lines) {
      const beginIdx = line.indexOf(NONCE_MARKER);
      if (beginIdx === -1) continue;
      const start = beginIdx + NONCE_MARKER.length;
      const endIdx = line.indexOf(NONCE_MARKER, start);
      if (endIdx === -1) continue;
      pathValue = line.slice(start, endIdx);
      break;
    }

    cached = pathValue;
    if (cached === null) {
      console.warn(
        `[user-shell-path] no nonce-marked PATH line in "${shell} -ilc" output; falling back to process.env.PATH`,
      );
    }
    return cached;
  } catch (err) {
    console.warn(
      `[user-shell-path] failed to capture user shell PATH via "${shell} -ilc": ${(err as Error).message}; falling back to process.env.PATH`,
    );
    cached = null;
    return null;
  }
}

/**
 * Set 保留优先序去重 PATH 字符串(`/a:/b:/a:/c` → `/a:/b:/c`)。
 *
 * 用于 unionUserShellPath 内拼接 user PATH + originalPath 后去重(典型 user PATH 末尾的
 * `agent-deck-plugin/bin` 与 originalPath 末尾同款重复)。OS lookup 遇重复路径 in-order
 * skip 不报错仅多 IO,但 echo $PATH 看起来不干净,dedupe 后更清晰。
 *
 * 输入空字符串 / undefined → 返空字符串(caller 容错)。
 */
export function dedupePath(path: string | undefined): string {
  if (!path) return '';
  const seen = new Set<string>();
  const out: string[] = [];
  for (const seg of path.split(':')) {
    if (!seen.has(seg)) {
      seen.add(seg);
      out.push(seg);
    }
  }
  return out.join(':');
}

/**
 * 用 user shell PATH union(用户 PATH 优先)原 PATH 后 dedupe 保序。
 *
 * 拼接顺序:`<user shell PATH>:<originalPath>` — user PATH 优先 lookup,brew/nvm/cargo
 * 等用户 CLI 优先;originalPath 末尾保留(Electron bundle 路径 `.app/Contents/MacOS` /
 * `Resources/bin` 等不丢)。最后 dedupe 去重。
 *
 * 失败兜底:captureUserShellPath 返 null(shell 跑挂 / 不支持 -ilc / 输出空)→ 直接返
 * originalPath(行为与原现状一致,不退化);originalPath undefined → 返 user PATH 单端;
 * 都为空 → 返 ''。
 */
export function unionUserShellPath(originalPath: string | undefined): string {
  const userPath = captureUserShellPath();
  if (!userPath) return originalPath ?? '';
  if (!originalPath) return userPath;
  return dedupePath(`${userPath}:${originalPath}`);
}

