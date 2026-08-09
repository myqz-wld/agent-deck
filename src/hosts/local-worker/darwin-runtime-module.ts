import { lstat, open, realpath } from 'node:fs/promises';
import { createRequire, register } from 'node:module';
import { pathToFileURL } from 'node:url';

import {
  createTrustedRuntimeModuleLoader,
  loadTrustedRuntimeModule,
  type TrustedRuntimeModulePorts,
} from '@hosts/linux-runtime/runtime-module';

const BETTER_SQLITE_SPECIFIER = 'better-sqlite3';

function resolveOriginalFs(): typeof import('node:fs') | null {
  try {
    return createRequire(import.meta.url)('original-fs') as typeof import('node:fs');
  } catch {
    return null;
  }
}

function registerDarwinDescriptorLoader(
  descriptorUrl: string,
  betterSqliteUrl: string,
): void {
  const source = [
    'import { readFile } from "node:fs/promises";',
    `const descriptorUrl = ${JSON.stringify(descriptorUrl)};`,
    `const betterSqliteUrl = ${JSON.stringify(betterSqliteUrl)};`,
    'export async function resolve(specifier, context, nextResolve) {',
    `  if (specifier === ${JSON.stringify(BETTER_SQLITE_SPECIFIER)}) {`,
    '    return { url: betterSqliteUrl, shortCircuit: true };',
    '  }',
    '  return nextResolve(specifier, context);',
    '}',
    'export async function load(url, context, nextLoad) {',
    '  if (url === descriptorUrl) {',
    '    return { format: "module", source: await readFile(new URL(url)), shortCircuit: true };',
    '  }',
    '  return nextLoad(url, context);',
    '}',
  ].join('\n');
  register(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`, {
    parentURL: import.meta.url,
  });
}

const originalFs = resolveOriginalFs();
const DARWIN_PORTS: TrustedRuntimeModulePorts = Object.freeze({
  platform: 'darwin',
  currentUid: () => typeof process.getuid === 'function' ? process.getuid() : null,
  realpath,
  lstat,
  archiveRealpath: originalFs ? originalFs.promises.realpath : realpath,
  archiveLstat: originalFs ? originalFs.promises.lstat : lstat,
  darwinDependencyUrl: (applicationArchivePath: string) => pathToFileURL(
    `${applicationArchivePath}/node_modules/${BETTER_SQLITE_SPECIFIER}/lib/index.js`,
  ).href,
  open: (path: string, flags: number) => open(path, flags),
  importModule: (url: string, betterSqliteUrl?: string) => {
    if (!betterSqliteUrl) throw new Error('macOS runtime dependency URL is missing');
    registerDarwinDescriptorLoader(url, betterSqliteUrl);
    return import(url);
  },
});

const loadTrustedDarwinRuntimeModule = createTrustedRuntimeModuleLoader(DARWIN_PORTS);

export const loadTrustedLocalWorkerRuntimeModule = process.platform === 'darwin'
  ? loadTrustedDarwinRuntimeModule
  : loadTrustedRuntimeModule;
