import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const relayRoot = dirname(fileURLToPath(import.meta.url));
const sourceExtensions = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts']);

function productionFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...productionFiles(path));
    else if (
      entry.isFile() &&
      sourceExtensions.has(extname(path)) &&
      !path.endsWith('.test.ts') &&
      !path.endsWith('.spec.ts')
    ) {
      files.push(path);
    }
  }
  return files;
}

function importsFrom(source: string): string[] {
  const imports = new Set<string>();
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) imports.add(match[1]);
  }
  return [...imports];
}

describe('relay-only production boundary', () => {
  it('imports no Core, provider, Browser, repository, Git/worktree, session store, or summarizer', () => {
    const forbidden = [
      /^electron$/,
      /^better-sqlite3$/,
      /sqlite/i,
      /^@core(?:\/|$)/,
      /^@main\/adapters(?:\/|$)/,
      /^@main\/browser-use(?:\/|$)/,
      /^@main\/(?:session|store)(?:\/|$)/,
      /(?:^|\/)(?:core|providers?|browser|repos?|repository|repositories|git|worktrees?|sessions?|stores?|summarizers?)(?:\/|$)/i,
      /^@anthropic-ai\//,
      /^@openai\/codex$/,
      /^@xai-official\//,
    ];
    const violations: string[] = [];
    for (const path of productionFiles(relayRoot)) {
      for (const specifier of importsFrom(readFileSync(path, 'utf8'))) {
        if (forbidden.some((pattern) => pattern.test(specifier))) {
          violations.push(`${path}: ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
