/**
 * hand-off-session 调 spawn 路径的 spawn-link write guard helper。
 *
 * **核心约束**:hand-off 路径(`handOffMode=true`)**永不写 spawn-link**(`sessions.spawned_by` /
 * `sessions.spawn_depth` 保持 null / 0):caller 单向交出 + 新 session 独立接手
 * (`hand-off-session.ts:21-39` jsdoc 设计意图明文「不是派出小弟干活」),不是 spawn
 * parent-child 关系;数据层不应记录 spawn-link 假装是 spawn 派遣关系。SessionList Phase C
 * (CHANGELOG_77)按 spawnedBy 树形分组渲染 `↳ teammate` badge → hand-off 路径写 spawn-link
 * 会让新 session UI 错挂 caller teammate 关系。
 *
 * **历史名词**:`handOffMode` 历史上叫 `batonMode`(REVIEW_39 / REVIEW_46 / REVIEW_47 / REVIEW_48
 * 出现);plan handoff-no-spawn-guards-20260526 §D6 改名升级语义为「hand-off 路径完全独立于
 * spawn-guards / 永不写 spawn-link」。
 *
 * SSOT 唯一化:spawn.ts 内的 spawn-link 写入条件分支 + spawnDepth fallback 共用此 helper 决定
 * 是否写 spawn-link,避免双处 inline `!opts?.handOffMode` 字面漂移。
 *
 * **Note**: helper 仅判定 handOffMode 维度;调用方仍负责 `callerExists` 的另一层正交条件
 * (caller 不在 sessions 表 = 闭包外 caller 视为顶层,本来就没 parent 可记,不论是否 handOffMode)。
 */

export interface ShouldWriteSpawnLinkOpts {
  handOffMode?: boolean;
}

export function shouldWriteSpawnLink(opts: ShouldWriteSpawnLinkOpts): boolean {
  return opts.handOffMode !== true;
}
