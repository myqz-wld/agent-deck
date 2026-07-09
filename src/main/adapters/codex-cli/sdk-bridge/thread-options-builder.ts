/**
 * Codex thread options builder（REVIEW_60 R4 §B 抽法 #2 / file-size-guardrail.md SOP §档 2 强）。
 *
 * 抽自 codex-cli/sdk-bridge/index.ts createSession L499-L526 双分支 spread (resumeThread /
 * startThread 入参字面重复)，7 字段 (workingDirectory / sandboxMode / approvalPolicy /
 * skipGitRepoCheck / model / networkAccessEnabled / additionalDirectories) 只 workingDirectory
 * 与上层调用形态 (resumeThread vs startThread) 无关,builder 统一返回。
 *
 * **设计要点**:
 * - 纯函数,零闭包,零 side effect — caller 调一次拿一个 fresh ThreadOptions object
 * - approvalPolicy default 'never' (与原 inline 同款,caller 缺省时 bridge 不主动 enforce default)
 * - model / networkAccessEnabled / additionalDirectories 用 spread spread 进 object 保持
 *   「caller 缺省 → 不写字段 → runtime 走默认值」的语义 (与 plan §P3 Step 3.5 + §不变量 6 一致)
 * - additionalDirectories 用 [...arr] 浅拷贝防 caller 后续 mutate 入参影响 SDK 内部
 *
 * **测试**: 见 codex-cli/sdk-bridge/__tests__/thread-options-builder.test.ts (待补 R4 follow-up)
 */
import { toCodexModelOverride } from '../sdk-model';
import type { CodexConfigObject } from '@main/codex-config/agent-deck-mcp-injector';
import type { CodexThinkingLevel } from '@shared/session-metadata';

export type CodexReasoningEffort = CodexThinkingLevel;
export type CodexReasoningSummary = 'none' | 'auto';

export interface BuildCodexThreadOptionsArgs {
  /** Codex 子进程 chdir 目标 (resume 路径:effectiveCwd / spawn 路径:cwd) */
  workingDirectory: string;
  /** opts.codexSandbox ?? sessionRepo.codexSandbox ?? settingsStore default 三层 fallback 链解析后值 */
  sandboxMode: 'workspace-write' | 'read-only' | 'danger-full-access';
  /** caller 显式传 / 'never' 默认 (bridge 不主动 enforce) */
  approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never';
  /** spawn handler custom-agent TOML `model` 字段 */
  model?: string;
  /** options-builder 在 reviewer-* 路径下 spread reviewer runtime default;普通 codex session 缺省 */
  networkAccessEnabled?: boolean;
  /** 同上,caller 缺省 → 不写字段 → SDK 走默认值 */
  additionalDirectories?: readonly string[];
  /** Resolved per-session reasoning effort; the provider validates model-specific support. */
  modelReasoningEffort?: CodexReasoningEffort;
  /** live session 默认请求 Codex 产出可展示的 reasoning summary；用户 config 可显式覆盖。 */
  modelReasoningSummary?: CodexReasoningSummary;
  /** Codex app-server thread/start + thread/resume developerInstructions passthrough. */
  developerInstructions?: string;
  /** Additional config layer parsed from custom-agent TOML. */
  configOverrides?: CodexConfigObject;
}

export interface CodexThreadOptions {
  workingDirectory: string;
  sandboxMode: 'workspace-write' | 'read-only' | 'danger-full-access';
  approvalPolicy: 'untrusted' | 'on-failure' | 'on-request' | 'never';
  skipGitRepoCheck: boolean;
  model?: string;
  modelReasoningEffort?: CodexReasoningEffort;
  modelReasoningSummary?: CodexReasoningSummary;
  developerInstructions?: string;
  configOverrides?: CodexConfigObject;
  networkAccessEnabled?: boolean;
  additionalDirectories?: string[];
}

export function buildCodexThreadOptions(args: BuildCodexThreadOptionsArgs): CodexThreadOptions {
  const model = toCodexModelOverride(args.model);
  return {
    workingDirectory: args.workingDirectory,
    sandboxMode: args.sandboxMode,
    approvalPolicy: args.approvalPolicy ?? 'never',
    skipGitRepoCheck: true,
    ...(model !== undefined ? { model } : {}),
    ...(args.modelReasoningEffort !== undefined
      ? { modelReasoningEffort: args.modelReasoningEffort }
      : {}),
    modelReasoningSummary: args.modelReasoningSummary ?? 'auto',
    ...(args.developerInstructions !== undefined && args.developerInstructions.trim().length > 0
      ? { developerInstructions: args.developerInstructions.trim() }
      : {}),
    ...(args.configOverrides !== undefined ? { configOverrides: args.configOverrides } : {}),
    ...(args.networkAccessEnabled !== undefined
      ? { networkAccessEnabled: args.networkAccessEnabled }
      : {}),
    ...(args.additionalDirectories !== undefined
      ? { additionalDirectories: [...args.additionalDirectories] }
      : {}),
  };
}
