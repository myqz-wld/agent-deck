import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

/** Only provider-observed output references may reach this main-only reader; never client paths. */
export async function readOwnedNativeOutput(path: string): Promise<{ text: string; truncated: boolean }> {
  if (!isAbsolute(path)) throw new Error('Native output must be an absolute provider reference');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('Native output is not a regular file');
    const limit = 1024 * 1024;
    const buffer = Buffer.alloc(Math.min(stat.size, limit));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    // Stream decoding drops an incomplete trailing code point until the next snapshot.
    const text = new TextDecoder().decode(buffer.subarray(0, bytesRead), { stream: bytesRead < stat.size });
    return { text, truncated: bytesRead < stat.size };
  } finally { await file.close(); }
}
