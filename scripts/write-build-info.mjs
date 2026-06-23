#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outputPath = join(repoRoot, 'build', 'build-info.json');

function git(args) {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const status = git(['status', '--porcelain']);
const info = {
  name: pkg.name,
  version: pkg.version,
  commit: git(['rev-parse', 'HEAD']) ?? 'unknown',
  shortCommit: git(['rev-parse', '--short=12', 'HEAD']) ?? 'unknown',
  branch: git(['rev-parse', '--abbrev-ref', 'HEAD']) ?? 'unknown',
  dirty: Boolean(status),
  builtAt: new Date().toISOString(),
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(info, null, 2)}\n`);
console.log(`wrote ${outputPath}`);
