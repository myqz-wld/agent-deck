/** Default Claude transcript and cwd probes used by SessionRecoverer. */
import {
  defaultCwdExistsCore,
  defaultResumeJsonlExistsCore,
  defaultResumeJsonlMtimeMsCore,
} from './jsonl-discovery-core';
import { desktopClaudeJsonlDiscoveryHost } from './jsonl-discovery-host';

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
  return defaultResumeJsonlExistsCore(cwd, sessionId, desktopClaudeJsonlDiscoveryHost);
}

/**
 * 读取 Claude Code CLI resume jsonl 的 mtime。
 *
 * 只用于 read-side 幻影 fork 自愈的 freshness gate：若 applicationSid.jsonl 明显早于 DB
 * lastEventAt，说明它可能是真实 fork 前的旧历史，不能拿它替代缺失的 cliSessionId.jsonl。
 */
export function defaultResumeJsonlMtimeMs(cwd: string, sessionId: string): number | null {
  return defaultResumeJsonlMtimeMsCore(cwd, sessionId, desktopClaudeJsonlDiscoveryHost);
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
  return defaultCwdExistsCore(cwd, desktopClaudeJsonlDiscoveryHost);
}
