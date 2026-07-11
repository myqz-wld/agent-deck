/** 周期性一句话总结清洗：折所有空白为单空格 + trim + slice。 */
export function cleanCompactResult(raw: string, maxLen: number): string | null {
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, maxLen) : null;
}
