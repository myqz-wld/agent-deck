/**
 * spawn-link write guard helper —— REVIEW_39 方案 1（hand-off-mcp-teammate-bug-20260515）+
 * plan hand-off-session-adopt-teammates-20260520 §不变量 N2.a / §设计决策 D8 防御性 invariant。
 *
 * baton 路径**不写 spawn-link**：caller 单向交出 + 新 session 独立接手（hand-off-session.ts:21-39
 * jsdoc 设计意图明文「不是派出小弟干活」），不是 spawn parent-child 关系；数据层不应记录
 * spawn-link 假装是 spawn 派遣关系。SessionList Phase C（CHANGELOG_77）按 spawnedBy 树形分组渲染
 * `↳ teammate` badge → baton 路径写 spawn-link 会让新 session UI 错挂 caller teammate 关系。
 *
 * SSOT 唯一化：spawn.ts:315（条件分支跳 setSpawnLink）+ spawn.ts:481（spawnDepth fallback）共用
 * 此 helper 决定是否写 spawn-link，避免双处 inline `!opts?.batonMode` 字面漂移。
 *
 * **Note**: helper 仅判定 batonMode 维度；调用方仍负责 `callerExists` 的另一层正交条件（caller
 * 不在 sessions 表 = 闭包外 caller 视为顶层，本来就没 parent 可记，不论是否 batonMode）。
 */

export interface ShouldWriteSpawnLinkOpts {
  batonMode?: boolean;
}

export function shouldWriteSpawnLink(opts: ShouldWriteSpawnLinkOpts): boolean {
  return opts.batonMode !== true;
}
