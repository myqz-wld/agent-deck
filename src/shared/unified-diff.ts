export function reconstructUnifiedDiffSnapshots(
  unifiedDiff: string,
): { before: string; after: string } | null {
  const before: string[] = [];
  const after: string[] = [];
  let inHunk = false;
  let sawHunkLine = false;
  const lines = unifiedDiff.replace(/\r\n/g, '\n').split('\n');

  for (const line of lines) {
    if (line.startsWith('@@ ')) {
      if (sawHunkLine) {
        before.push('...');
        after.push('...');
      }
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('\\ No newline at end of file')) continue;

    const marker = line[0];
    const body = line.slice(1);
    if (marker === ' ') {
      before.push(body);
      after.push(body);
      sawHunkLine = true;
    } else if (marker === '-') {
      before.push(body);
      sawHunkLine = true;
    } else if (marker === '+') {
      after.push(body);
      sawHunkLine = true;
    } else if (line.startsWith('diff --git ') || line.startsWith('--- ') || line.startsWith('+++ ')) {
      inHunk = false;
    }
  }

  if (!sawHunkLine) return null;
  return {
    before: before.join('\n'),
    after: after.join('\n'),
  };
}

export function reverseUnifiedDiffSnapshot(
  afterContent: string,
  unifiedDiff: string,
): string | null {
  const hunks = parseUnifiedDiffHunks(unifiedDiff);
  if (hunks.length === 0) return null;

  const after = splitContent(afterContent);
  const beforeLines: string[] = [];
  let cursor = 0;

  for (const hunk of hunks) {
    const targetIndex = Math.max(0, hunk.newStart - 1);
    if (targetIndex < cursor || targetIndex > after.lines.length) return null;
    beforeLines.push(...after.lines.slice(cursor, targetIndex));
    cursor = targetIndex;

    for (const line of hunk.lines) {
      if (line.startsWith('\\ No newline at end of file')) continue;
      const marker = line[0];
      const body = line.slice(1);
      if (marker === ' ') {
        if (after.lines[cursor] !== body) return null;
        beforeLines.push(body);
        cursor += 1;
      } else if (marker === '+') {
        if (after.lines[cursor] !== body) return null;
        cursor += 1;
      } else if (marker === '-') {
        beforeLines.push(body);
      }
    }
  }

  beforeLines.push(...after.lines.slice(cursor));
  return joinContent(beforeLines, after.trailingNewline);
}

interface ParsedHunk {
  newStart: number;
  lines: string[];
}

function parseUnifiedDiffHunks(unifiedDiff: string): ParsedHunk[] {
  const hunks: ParsedHunk[] = [];
  let current: ParsedHunk | null = null;
  const lines = unifiedDiff.replace(/\r\n/g, '\n').split('\n');

  for (const line of lines) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      current = { newStart: Number(header[1]), lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('diff --git ') || line.startsWith('--- ') || line.startsWith('+++ ')) {
      current = null;
      continue;
    }
    current.lines.push(line);
  }

  return hunks;
}

function splitContent(value: string): { lines: string[]; trailingNewline: boolean } {
  const normalized = value.replace(/\r\n/g, '\n');
  if (normalized === '') return { lines: [], trailingNewline: false };
  const lines = normalized.split('\n');
  const trailingNewline = lines.length > 1 && lines[lines.length - 1] === '';
  if (trailingNewline) lines.pop();
  return { lines, trailingNewline };
}

function joinContent(lines: string[], trailingNewline: boolean): string {
  const joined = lines.join('\n');
  return trailingNewline && joined ? `${joined}\n` : joined;
}
