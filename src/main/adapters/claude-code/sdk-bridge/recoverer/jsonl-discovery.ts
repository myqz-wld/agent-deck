/**
 * SessionRecoverer jsonl / cwd 存在性默认探测 — Step 4.4 拆分子模块。
 *
 * **抽出范围**（原 recoverer.ts:630-668 ~38 LOC）：
 * - `defaultResumeJsonlExists` — Claude Code CLI `~/.claude/projects/<encoded-cwd>/<sid>.jsonl` 探测
 * - `defaultCwdExists` — fs.existsSync wrapper（fail-safe 退化返回 true）
 *
 * **签名 / 约束**：
 * - 两个 export free fn（与 codex 端 recoverer/jsonl-discovery.ts 同款拆分粒度）
 * - facade `recoverer.ts` re-export 保 import path byte-identical（caller 仍按
 *   `import { defaultResumeJsonlExists } from '@main/adapters/claude-code/sdk-bridge/recoverer'`
 *   方式 import）
 *
 * **抽出动机**：与 Step 4.3 codex 端 jsonl-discovery.ts 模式对齐 — 让 facade
 * `recoverer.ts` 不再含 fs / os / path 直接 import,仅留 SessionRecoverer class shell +
 * 复用本子模块的 default fn 作 thunk 默认值。
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { encodeClaudeProjectDir } from '@main/platform';

/**
 * 预检 CLI resume 用的 jsonl 文件是否存在。
 *
 * Claude Code CLI 把会话历史落在 `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`，
 * encoded-cwd 规则见 `@main/platform` 的 `encodeClaudeProjectDir`（macOS/Linux 用 `/`
 * split + `-` join；Win 推测同模式但用 `\` split）。
 *
 * 不存在时 CLI `--resume <sid>` 会 hard fail 抛 "No conversation found"，必须走不带
 * resume 的新建路径（CHANGELOG_28）。如果 CLI 内部规则未来改了 / Win 实际规则与推测
 * 不符，预检会假阴性 → 退化到原 try-and-fail 行为（catch 兜底返 true，让上层 SDK
 * 自己 try）。
 *
 * 这是 facade.resumeJsonlExists 的默认实现；test 通过 extend facade override 该方法
 * 让单测不依赖真 ~/.claude/projects 目录。
 */
export function defaultResumeJsonlExists(cwd: string, sessionId: string): boolean {
  try {
    const encodedDir = encodeClaudeProjectDir(cwd);
    const jsonlPath = join(homedir(), '.claude', 'projects', encodedDir, `${sessionId}.jsonl`);
    return existsSync(jsonlPath);
  } catch {
    // 任意异常（cwd 解析失败 / FS 权限）→ 退化让 createSession 自己 try，最差不过原行为
    return true;
  }
}

/**
 * CHANGELOG_99:cwd 存在性 thunk 的默认实现 — 直接走 fs.existsSync。
 *
 * 这是 facade.cwdExists 的默认实现;test 通过 extend facade override 让单测不依赖真 fs。
 *
 * **fail-safe 退化**:任意异常退化返回 true(让 createSession 自己 try),最差不过原行为
 * (撞 SDK "Path does not exist")。这与 defaultResumeJsonlExists 同款防御策略。
 */
export function defaultCwdExists(cwd: string): boolean {
  try {
    return existsSync(cwd);
  } catch {
    return true;
  }
}
