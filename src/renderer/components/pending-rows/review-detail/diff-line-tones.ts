const LCS_CELL_LIMIT = 250_000;

export type AnnotatedLineTone = 'added' | 'deleted';

export function splitDisplayLines(content: string): string[] {
  if (content === '') return [''];
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function splitComparableLines(content: string): string[] {
  if (content === '') return [];
  return splitDisplayLines(content);
}

export function buildPrLineTones(
  before: string,
  after: string,
): { before: Map<number, AnnotatedLineTone>; after: Map<number, AnnotatedLineTone> } {
  const beforeLines = splitComparableLines(before);
  const afterLines = splitComparableLines(after);
  const pairs =
    beforeLines.length * afterLines.length <= LCS_CELL_LIMIT
      ? longestCommonLinePairs(beforeLines, afterLines)
      : prefixSuffixCommonLinePairs(beforeLines, afterLines);
  const keptBefore = new Set(pairs.map(([beforeIndex]) => beforeIndex));
  const keptAfter = new Set(pairs.map(([, afterIndex]) => afterIndex));
  const beforeTones = new Map<number, AnnotatedLineTone>();
  const afterTones = new Map<number, AnnotatedLineTone>();

  beforeLines.forEach((_line, index) => {
    if (!keptBefore.has(index)) beforeTones.set(index + 1, 'deleted');
  });
  afterLines.forEach((_line, index) => {
    if (!keptAfter.has(index)) afterTones.set(index + 1, 'added');
  });

  return { before: beforeTones, after: afterTones };
}

function longestCommonLinePairs(
  before: string[],
  after: string[],
): Array<[number, number]> {
  const dp = Array.from({ length: before.length + 1 }, () =>
    Array<number>(after.length + 1).fill(0),
  );
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      dp[i][j] =
        before[i] === after[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

function prefixSuffixCommonLinePairs(
  before: string[],
  after: string[],
): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) {
    pairs.push([start, start]);
    start += 1;
  }

  let beforeEnd = before.length - 1;
  let afterEnd = after.length - 1;
  const suffix: Array<[number, number]> = [];
  while (beforeEnd >= start && afterEnd >= start && before[beforeEnd] === after[afterEnd]) {
    suffix.push([beforeEnd, afterEnd]);
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  return [...pairs, ...suffix.reverse()];
}

export function diffLineToneClass(tone: AnnotatedLineTone | undefined): string {
  if (tone === 'added') return 'bg-status-working/[0.10]';
  if (tone === 'deleted') return 'bg-status-error/[0.10]';
  return '';
}

export function diffLineMarkerClass(tone: AnnotatedLineTone | undefined): string {
  if (tone === 'added') return 'text-status-working';
  if (tone === 'deleted') return 'text-status-error';
  return 'text-deck-muted/30';
}
