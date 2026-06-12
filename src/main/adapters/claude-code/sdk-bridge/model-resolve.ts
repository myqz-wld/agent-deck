/**
 * Claude SDK model 解析（plan model-wiring-and-handoff-20260514 Step 2.2）。
 *
 * 抽自 ClaudeSdkBridge.createSession 内 model 计算段。把 fallback 链统一收口，
 * 让 facade createSession 用一行 `resolveClaudeModel(opts)` 拿到 effective model。
 *
 * fallback 链（与 sandbox-resolve.ts 不同 — model 没有 settings 全局默认）：
 * 1. opts.model（spawn handler 解 adapter-native agent config `model` 字段后传入；未来 caller 显式
 *    传入也走此分支）
 * 2. resume 路径下 sessionRepo.model（重启应用 resume 历史会话还原 + dormant 唤醒一致）
 * 3. undefined（让 SDK 自己读 ANTHROPIC_MODEL env / 用默认 model）
 *
 * 设计取舍：
 * - **不**查 settings.summaryModel / settings.handOffModel — 那两字段只在 oneshot summary /
 *   hand-off 路径用，spawn / resume 路径不查 settings 全局值（详 plan D2 / types.ts model 字段
 *   注释 / settings UI label「只对 oneshot 总结路径生效」）
 * - **不**兜底 'opus' / 'sonnet' alias — 与 sandbox 'off' 兜底不同：sandbox 必须有具体值
 *   才能传给 SDK；model undefined 让 SDK 自己 fallback 到 ANTHROPIC_MODEL 才是正确语义
 */

import { sessionRepo } from '@main/store/session-repo';

export function resolveClaudeModel(opts: {
  resume?: string;
  model?: string;
}): string | undefined {
  const persisted: string | null = opts.resume
    ? (sessionRepo.get(opts.resume)?.model ?? null)
    : null;
  return opts.model ?? persisted ?? undefined;
}
