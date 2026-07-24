import { access } from 'node:fs/promises';
import path from 'node:path';

export async function resolveGrokBinary(configuredPath: string | null): Promise<string> {
  const candidate = configuredPath?.trim();
  if (!candidate) return 'grok';
  if (!path.isAbsolute(candidate)) {
    throw new Error('Grok binary path must be absolute, or leave it empty to use PATH.');
  }
  try {
    await access(candidate);
  } catch {
    throw new Error(`Grok binary was not found at ${candidate}.`);
  }
  return candidate;
}
