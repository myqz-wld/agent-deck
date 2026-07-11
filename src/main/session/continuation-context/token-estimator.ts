const UTF8_BYTES_PER_TOKEN = 4;
const CALIBRATION_FACTOR = 1.15;

export interface TokenEstimateOptions {
  structuralOverhead?: number;
}

export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** Provider-neutral conservative estimate aligned with Codex's UTF-8-byte approximation. */
export function estimateContinuationTokens(
  text: string,
  options: TokenEstimateOptions = {},
): number {
  const structuralOverhead = options.structuralOverhead ?? 0;
  if (!Number.isSafeInteger(structuralOverhead) || structuralOverhead < 0) {
    throw new Error('structuralOverhead must be a non-negative safe integer');
  }
  return Math.ceil((utf8ByteLength(text) / UTF8_BYTES_PER_TOKEN) * CALIBRATION_FACTOR) +
    structuralOverhead;
}

export function estimateContinuationJsonTokens(
  value: unknown,
  options: TokenEstimateOptions = {},
): number {
  return estimateContinuationTokens(JSON.stringify(value), options);
}

function prefixAtUtf8Boundary(bytes: Buffer, length: number): Buffer {
  let end = Math.min(bytes.length, Math.max(0, length));
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end);
}

function suffixAtUtf8Boundary(bytes: Buffer, length: number): Buffer {
  let start = Math.max(0, bytes.length - Math.max(0, length));
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start);
}

export interface MiddleTruncationResult {
  text: string;
  truncated: boolean;
  originalBytes: number;
  retainedBytes: number;
  omittedBytes: number;
  omittedEstimatedTokens: number;
  estimatedTokens: number;
}

function buildTruncatedText(bytes: Buffer, retainedBytes: number): MiddleTruncationResult {
  const prefixBudget = Math.ceil(retainedBytes / 2);
  const suffixBudget = Math.floor(retainedBytes / 2);
  const prefix = prefixAtUtf8Boundary(bytes, prefixBudget);
  const suffix = suffixAtUtf8Boundary(bytes, suffixBudget);
  const retained = prefix.length + suffix.length;
  const omittedBytes = Math.max(0, bytes.length - retained);
  const omittedEstimatedTokens = Math.ceil(
    (omittedBytes / UTF8_BYTES_PER_TOKEN) * CALIBRATION_FACTOR,
  );
  const marker = `\n[~${omittedEstimatedTokens} estimated tokens omitted]\n`;
  const text = `${prefix.toString('utf8')}${marker}${suffix.toString('utf8')}`;
  return {
    text,
    truncated: true,
    originalBytes: bytes.length,
    retainedBytes: retained,
    omittedBytes,
    omittedEstimatedTokens,
    estimatedTokens: estimateContinuationTokens(text),
  };
}

/** Keep the largest UTF-8-safe 50/50 prefix/suffix that fits an estimated-token budget. */
export function truncateContinuationTextMiddle(
  text: string,
  tokenBudget: number,
): MiddleTruncationResult {
  if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 1) {
    throw new Error('tokenBudget must be a positive safe integer');
  }
  const bytes = Buffer.from(text, 'utf8');
  const fullEstimate = estimateContinuationTokens(text);
  if (fullEstimate <= tokenBudget) {
    return {
      text,
      truncated: false,
      originalBytes: bytes.length,
      retainedBytes: bytes.length,
      omittedBytes: 0,
      omittedEstimatedTokens: 0,
      estimatedTokens: fullEstimate,
    };
  }

  let low = 0;
  let high = bytes.length;
  let best: MiddleTruncationResult | null = null;
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const candidate = buildTruncatedText(bytes, midpoint);
    if (candidate.estimatedTokens <= tokenBudget) {
      best = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }
  if (!best) {
    throw new Error(`tokenBudget ${tokenBudget} cannot fit an explicit truncation marker`);
  }
  return best;
}
