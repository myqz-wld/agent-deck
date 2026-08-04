#!/usr/bin/env node

import { builtinModules } from 'node:module';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceExtensions = new Set(['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx']);
const nodeBuiltins = new Set(
  builtinModules.flatMap((name) => [name, name.replace(/^node:/, ''), `node:${name}`]),
);

const rules = [
  {
    name: 'contracts',
    root: 'src/contracts',
    forbiddenTargets: [
      'src/clients',
      'src/composition',
      'src/core',
      'src/gateways',
      'src/hosts',
      'src/main',
      'src/preload',
      'src/protocol',
      'src/renderer',
    ],
    forbidNodeBuiltins: true,
    forbiddenPackages: ['electron'],
  },
  {
    name: 'core',
    root: 'src/core',
    forbiddenTargets: [
      'src/clients',
      'src/composition',
      'src/gateways',
      'src/hosts',
      'src/main',
      'src/preload',
      'src/protocol',
      'src/renderer',
    ],
    forbidNodeBuiltins: true,
    forbiddenPackages: ['electron'],
  },
  {
    name: 'protocol',
    root: 'src/protocol',
    forbiddenTargets: [
      'src/clients',
      'src/composition',
      'src/core',
      'src/gateways',
      'src/hosts',
      'src/main',
      'src/preload',
      'src/renderer',
    ],
    forbidNodeBuiltins: true,
    forbiddenPackages: ['electron'],
  },
  {
    name: 'relay',
    root: 'src/hosts/relay',
    forbiddenTargets: [
      'src/core',
      'src/main/adapters',
      'src/main/browser-use',
      'src/main/session',
      'src/main/store',
    ],
    forbidNodeBuiltins: false,
    forbiddenPackages: ['electron'],
  },
];

const aliasTargets = new Map([
  ['@clients', 'src/clients'],
  ['@composition', 'src/composition'],
  ['@contracts', 'src/contracts'],
  ['@core', 'src/core'],
  ['@gateways', 'src/gateways'],
  ['@hosts', 'src/hosts'],
  ['@main', 'src/main'],
  ['@preload', 'src/preload'],
  ['@protocol', 'src/protocol'],
  ['@renderer', 'src/renderer'],
  ['@shared', 'src/shared'],
]);

function normalizePath(path) {
  return path.split(sep).join('/');
}

function isProductionFile(path) {
  const normalized = normalizePath(path);
  return (
    sourceExtensions.has(extname(path)) &&
    !normalized.includes('/__tests__/') &&
    !normalized.endsWith('.test.ts') &&
    !normalized.endsWith('.test.tsx') &&
    !normalized.endsWith('.spec.ts') &&
    !normalized.endsWith('.spec.tsx')
  );
}

function walk(root) {
  try {
    if (!statSync(root).isDirectory()) return [];
  } catch {
    return [];
  }

  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.isFile() && isProductionFile(path)) files.push(path);
  }
  return files;
}

function importsFrom(source) {
  const imports = new Set();
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) imports.add(match[1]);
  }
  return imports;
}

function resolveTarget(file, specifier) {
  if (specifier.startsWith('.')) {
    return normalizePath(relative(repoRoot, resolve(dirname(file), specifier)));
  }
  for (const [alias, target] of aliasTargets) {
    if (specifier === alias) return target;
    if (specifier.startsWith(`${alias}/`)) {
      return `${target}/${specifier.slice(alias.length + 1)}`;
    }
  }
  return null;
}

const violations = [];
for (const rule of rules) {
  for (const file of walk(resolve(repoRoot, rule.root))) {
    const source = readFileSync(file, 'utf8');
    for (const specifier of importsFrom(source)) {
      const packageRoot = specifier.split('/')[0];
      if (rule.forbiddenPackages.includes(packageRoot)) {
        violations.push(`${relative(repoRoot, file)} imports forbidden package ${specifier}`);
        continue;
      }
      if (rule.forbidNodeBuiltins && nodeBuiltins.has(specifier)) {
        violations.push(`${relative(repoRoot, file)} imports Node builtin ${specifier}`);
        continue;
      }
      const target = resolveTarget(file, specifier);
      if (
        target &&
        rule.forbiddenTargets.some(
          (forbidden) => target === forbidden || target.startsWith(`${forbidden}/`),
        )
      ) {
        violations.push(
          `${relative(repoRoot, file)} crosses the ${rule.name} boundary via ${specifier}`,
        );
      }
    }
  }
}

if (violations.length > 0) {
  console.error('[architecture-boundaries] failed');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log('[architecture-boundaries] passed');
