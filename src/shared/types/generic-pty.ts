/**
 * Generic-PTY adapter / aider preset 共用配置 schema（R4·F1）。
 *
 * 数据流：
 * - UI（NewSessionDialog → renderer）：用户选 preset 或自定义命令 → submit 前 `parseGenericPtyConfig(input)`
 *   → IPC 传到 main → adapter.createSession 入参 → 持久化到 sessions.generic_pty_config
 *   （v012 migration JSON 字符串列）。
 * - main：adapter init 时同样 `parseGenericPtyConfig` 二次校验（防 IPC bypass）。
 * - aider preset：UI 默认选 'aider' 时把 GENERIC_PTY_PRESETS[0].config 填进 form；用户可二次 fine-tune。
 *
 * 与 adapters/types.ts 的关系：CreateSessionOptions 透传一个 `genericPtyConfig` 字段（F2 加），
 * 仅 generic-pty / aider 两个 adapter 接收并起效；其它 adapter 忽略。
 *
 * 设计决策（plan §F-bonus 选项 B 落地）：
 * - aider 与 generic-pty 各自是独立 adapter（UI 暴露差异）
 * - 但 backend 共享 GenericPtyBridge 类（F2 落）
 * - aider session 自带 preset='aider' config；generic-pty session 用户填 config（也可基于 preset 微调）
 */

import { z } from 'zod';

// =============================================================================
// Zod schema
// =============================================================================

/**
 * GenericPtyConfig 校验 schema。
 *
 * 字段语义：
 * - command：可执行名（PATH 内）或绝对路径。空字符串 fail（无意义）
 * - args：argv 数组，**不**走 shell 解释（node-pty spawn 直接 exec）
 * - env：与 process.env 合并的额外 env
 * - cwd：工作目录；空字符串 = 跟 session.cwd（adapter 兜底）
 * - idleQuietMs：stdout 静默 N ms 后 emit waiting-for-user（默认 3000ms，aider 实测充裕）
 * - promptSuffixRegex：可选 idle 二次校验。空字符串 = 不校验，纯 idleQuietMs 触发
 *
 * 所有字段都有 default，partial 输入也能 parse；caller 想强校验 command 非空仍会触发 min(1)。
 */
export const genericPtyConfigSchema = z.object({
  command: z.string().min(1, 'command must be non-empty'),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  cwd: z.string().default(''),
  idleQuietMs: z.number().int().min(0).default(3000),
  promptSuffixRegex: z.string().default(''),
});

// =============================================================================
// Types
// =============================================================================

/**
 * Generic-PTY adapter 单 session 配置。
 *
 * 持久化：sessions.generic_pty_config (v012 migration) JSON 字符串列。
 * 读取：sessionRepo.get(sid).genericPtyConfig?: GenericPtyConfig
 *
 * 注意：本文件只定义 type；持久化路径由 F2 加的 v012 migration + sessionRepo 字段读写实现。
 */
export type GenericPtyConfig = z.infer<typeof genericPtyConfigSchema>;

/** UI 暴露的 preset（NewSessionDialog 下拉 + Settings 默认）。 */
export interface GenericPtyPreset {
  /** preset slug，UI 下拉用 */
  id: string;
  /** 用户可见名 */
  displayName: string;
  /** 一行说明 */
  description: string;
  /** 默认 GenericPtyConfig（用户可在此基础上 fine-tune） */
  config: GenericPtyConfig;
}

// =============================================================================
// Presets
// =============================================================================

/**
 * 内置 preset 列表。
 *
 * 设计取舍：
 * - aider 默认 `--no-stream --no-pretty`：让 stdout 一段一段来，对 ANSI strip + idle detect 友好
 *   （aider 默认 stream + pretty 颜色对 PTY 解析压力大，且 idle 触发不稳）
 * - aider promptSuffixRegex `'\\>\\s*$'`：aider 的 `> ` prompt 末尾匹配（regex 字面 `\>\s*$`）
 * - continue 暂不知 prompt suffix 规律，留空让 idleQuietMs 单独触发；用户可在 UI 自定义
 *
 * preset 增减属约定升级（影响默认 UX）：走「决策对抗」三态裁决；运行时仅作为 UI 默认值，不做强约束。
 */
export const GENERIC_PTY_PRESETS: readonly GenericPtyPreset[] = [
  {
    id: 'aider',
    displayName: 'Aider',
    description: 'aider chat (assumes `aider` in PATH; auto --no-stream + --no-pretty)',
    config: {
      command: 'aider',
      args: ['--no-stream', '--no-pretty'],
      env: {},
      cwd: '',
      idleQuietMs: 3000,
      promptSuffixRegex: '\\>\\s*$',
    },
  },
  {
    id: 'continue',
    displayName: 'Continue CLI',
    description: 'continue CLI (assumes `continue` in PATH)',
    config: {
      command: 'continue',
      args: [],
      env: {},
      cwd: '',
      idleQuietMs: 3000,
      promptSuffixRegex: '',
    },
  },
] as const;

/** 按 id 取 preset；找不到返回 undefined。 */
export function getGenericPtyPreset(id: string): GenericPtyPreset | undefined {
  return GENERIC_PTY_PRESETS.find((p) => p.id === id);
}

/**
 * Validate + return parsed config。fail 时 throw zod error（caller 自己 catch 显示）。
 *
 * 入口：
 * - main: adapter.createSession 启动前 parse（防脏 / 防 ts-bypass）
 * - renderer: NewSessionDialog submit 前 parse（防脏 / inline error）
 *
 * partial 输入能 parse（全字段 default），但 command 必须非空（schema min(1) 约束）。
 */
export function parseGenericPtyConfig(input: unknown): GenericPtyConfig {
  return genericPtyConfigSchema.parse(input);
}
