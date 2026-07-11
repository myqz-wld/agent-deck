/** Preserve up to four compact display-summary lines while removing Markdown wrappers/noise. */
export function cleanCompactResult(raw: string, maxLen: number): string | null {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^```/.test(line))
    .map((line, index) => {
      const withoutMarkdown = line.replace(/^(?:[-*#]+|\d+[.)])\s*/, '');
      const normalized = withoutMarkdown.replace(/\s+/g, ' ').trim();
      return index === 0 ? normalized.replace(/^标题[：:]\s*/, '') : normalized;
    })
    .filter(Boolean)
    .slice(0, 4)
    .map((line) => (line.length > 220 ? `${line.slice(0, 220)}…` : line));
  const cleaned = lines.join('\n').trim();
  return cleaned ? cleaned.slice(0, maxLen) : null;
}
