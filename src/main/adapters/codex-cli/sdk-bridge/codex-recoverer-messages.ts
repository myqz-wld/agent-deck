/**
 * codex recoverer.ts emit `payload.text` 文案 builder（REVIEW_60 R4 §D 抽法 #2 mirror claude
 * `recoverer-messages.ts` / file-size-guardrail.md SOP §档 2 强）。
 *
 * **抽离动机**（cross-adapter parity 维护漂移成本驱动 — reviewer-claude R4 §D 论据）:
 * - 改 claude `recoverer-messages.ts` builder (如调整 cwd fallback 文案) 时容易忘 sync codex inline text
 *   → 用户体感「同款情况两 adapter 给的提示话语不同」
 * - 同款 emit text 两份独立维护 → 修一边漏修另一边
 * - codex recoverer.ts 把 3 处 emit text inline 在 recoverAndSend 主路径 控制流与文案交织,
 *   复审「分支控制流」「文案措辞」耦合度高
 *
 * **形态**（与 claude `recoverer-messages.ts` 同款）:
 * - module-level pure function,**不依赖** recoverer class state — 让单测可以直接 input/output
 *   验证文案,不用起 facade / TestCodexBridge
 * - emit 时机 / payload 结构 (sessionId / agentId / kind / source / ts / error 字段) 由 caller
 *   在 recoverer.ts 内组装
 *
 * **4 个分支对应**（codex recoverer.ts outer + codex-jsonl-fallback inner）:
 * 1. `buildCodexCwdMissingErrorText` — cwd 不存在且 fallback 全 miss (emit error: true, throw 前)
 * 2. `buildCodexCwdFallbackInfoText` — cwd 不存在但 fallback 找到 (emit info,不带 error: true)
 * 3. context restored — jsonl missing fallback + 续接上下文包含历史
 * 4. instruction only — jsonl missing fallback + 无可信历史可保留
 *
 * **不变量**:
 * - 纯函数,无副作用,输入决定输出
 * - 不引入新文案 (行为零变化,仅平移 + 参数化)
 * - 与 claude `recoverer-messages.ts` 同款 builder 接口形态 (cross-adapter parity 维护单点)
 *
 * **不抽** 的 emit (与 claude 同款):
 * - `⚠ Codex 通道已断开,正在自动恢复…` 单行字面量,无参数化空间,留 recoverer.ts 内
 * - `⚠ 自动恢复失败：${err}` 单行 + err.message 内联,留 recoverer.ts 内
 * - `⚠ Codex 30 秒内未发出 thread.started 事件...` 在 resume-path-await.ts 内(spawn 路径文案,不属 recoverer scope)
 */

/**
 * 1. cwd 不存在且 fallback 全 miss:emit error: true 然后 throw。
 *
 * 用于 codex recoverer.ts L271-273 分支。caller emit 时 `error: true`。
 * 与 claude `buildCwdMissingErrorText` 文案不同 — claude 提启发式 fallback 细节 (含 .claude/worktrees/
 * 路径反推 / 父目录 walk),codex 当前文案更简短只提目录被删除 / 跨设备同步丢失。本 builder 保持
 * codex 原文案不动 (行为零变化原则),如需对齐 claude 详细程度走 `agent-deck:simple-review` 三态裁决独立 follow-up。
 */
export function buildCodexCwdMissingErrorText(badCwd: string): string {
  return (
    `⚠ 会话 cwd 不存在且无可用 fallback：${badCwd}。` +
    `请检查目录是否被删除 / 跨设备同步丢失，或新建会话。`
  );
}

/**
 * 2. cwd 不存在但 fallback 找到:emit info,不带 error: true。
 *
 * 用于 codex recoverer.ts L296-300 分支。caller emit 时不带 error (info 性质)。
 *
 * **codex jsonl 独立于 cwd**:codex jsonl 在 `~/.codex/sessions/<YYYY>/<MM>/<DD>/` date-based
 * 目录,完全独立于 cwd (与 claude `~/.claude/projects/<encoded-cwd>/<sid>.jsonl` 不同 — 详
 * recoverer.ts L38-40 节注释)。symmetry-plan P3 R2-2 修法删 cwdFellBack 强制 fresh thread
 * 改 codex resumeThread + workingDirectory:effectiveCwd 正常进 SDK 保留对话历史。本文案重点
 * 是「文件引用可能不再指向同一文件」(SDK turn 内引用 cwd 内相对路径会失效)。
 *
 * **与 claude 文案差异**:claude `buildCwdFallbackInfoText` 含 sandbox 边界变化警告 (workspace-write
 * 档下写权限边界可能扩大);codex 当前未含 — codex sandbox 模型与 claude 不同,sandbox.allowWrite
 * 概念不存在,无对应警告必要。保持原差异。
 */
export function buildCodexCwdFallbackInfoText(badCwd: string, fallbackCwd: string): string {
  return (
    `⚠ 会话原 cwd 不存在 (${badCwd}),已切到 fallback (${fallbackCwd}) 继续 ` +
    `(对话历史保留)。注意:历史中对原 cwd 文件的相对引用 (如 "edit foo.ts at line 10") ` +
    `可能不再指向同一文件,如需精确恢复请新建会话。`
  );
}

/**
 * 3. jsonl missing fallback + 续接上下文包含历史：emit info，不带 error: true。
 *
 * 用于 codex-jsonl-fallback.ts 的非 instruction-only quality 分支。
 */
export function buildCodexJsonlMissingContextRestoredText(effectiveCwd: string): string {
  return (
    `⚠ 此会话的 Codex 内部对话历史(jsonl)已丢失: ${effectiveCwd}\n` +
    `应用已自动生成会话续接上下文(结构化检查点 + 保留的原始用户输入),Codex 应能续上前情。\n` +
    `如答非所问,请下条消息补充关键背景。`
  );
}

/**
 * 4. jsonl missing fallback + instruction-only degradation：emit info，不带 error: true。
 *
 * DB 没有可验证检查点或可保留的原始历史时，文案保留「请下条消息把背景给 Codex 一次」。
 */
export function buildCodexJsonlMissingInstructionOnlyText(effectiveCwd: string): string {
  return (
    `⚠ 此会话的 Codex 内部对话历史(jsonl)已丢失: ${effectiveCwd}\n` +
    `典型原因: 用户清理 ~/.codex/sessions / 跨设备同步未带 jsonl / Codex 自身清理 / 应用重装。\n` +
    `应用 DB 的 SessionDetail 历史完整保留,但本次会话续接上下文只能保留当前指令。` +
    `如要继续之前话题,请在下条消息里补充背景。`
  );
}
