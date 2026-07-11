/**
 * LLM oneshot 输出文本清洗 helper（R37 P2-H Step 3.2）。
 *
 * **抽出动机**（reviewer 双对抗 R1 H4 finding）：
 * 4 个 runner 都做最后一步「raw → cleaned → null|sliced」，但 summarize 路径与 handoff
 * 路径有截然不同的清洗策略：
 *
 * - **summarize**（30 字 tag-line）：`replace(/\s+/g, ' ').trim()` 把多行换行折成单空格，
 *   再 slice(120)。tag-line 显示在 SessionList / 顶部 chip，必须单行。
 * - **handoff**（六节压缩检查点）：仅 `trim()`，**保留 \n 换行**让 textarea preview 直接渲染分段。
 *   再 slice(4000) 防超长（六节检查点通常 800-2000 字，4000 给 outliers）。
 *
 * 两种策略不能混用（summarize 用 trim 会让换行进 SessionList chip 撑变形；handoff 用
 * replace 会把六节模板的 `\n【已完成与验证】\n- ...` 折成单行不可读）。抽 2 个具名 helper 强约束
 * 区分。
 *
 * **空字符串语义**：cleaned 为空（仅空白 trim 后空）→ 返回 null（与原 4 runner 一致：
 * `cleaned ? cleaned.slice(...) : null`），让上层走 fallback / null 路径。
 */

/**
 * 一句话总结清洗：折所有空白为单空格 + trim + slice(maxLen)。
 *
 * @param raw - LLM 原始输出
 * @param maxLen - 最大字符数（典型 120 = 30 字中文 + buffer）
 * @returns 清洗后字符串；raw 全空白 → null
 */
export function cleanCompactResult(raw: string, maxLen: number): string | null {
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, maxLen) : null;
}

/**
 * 结构化简报清洗：仅 trim 首尾空白 + 可选 slice(maxLen)，**保留中间 \n**。
 *
 * **maxLen 可选 / undefined 不 slice**（REVIEW_37 R2 MED-1 修法 — codex handoff 旧版有意
 * 不 slice，理由见 R37 base codex handoff commit message：「hand-off 六节检查点通常 800-2000 字，
 * 不像 30 字 tag-line 要 slice 到 120 char」codex 输出偶尔超 4000 char 截断会切断结构节）。
 * 调用约束：
 * - claude handoff: 传 4000（与 K3 旧版字面一致 — 给 sonnet outliers 留余量但仍兜底防超长）
 * - codex handoff: 不传（恢复 a748af1 旧版「不限长度」的有意 trade-off）
 *
 * @param raw - LLM 原始输出
 * @param maxLen - 最大字符数；undefined 不 slice（保留全文 trim 后）
 * @returns 清洗后字符串；raw 全空白 → null
 */
export function cleanStructuredResult(raw: string, maxLen?: number): string | null {
  const cleaned = raw.trim();
  if (!cleaned) return null;
  return maxLen !== undefined ? cleaned.slice(0, maxLen) : cleaned;
}
