#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const FEISHU_RUNTIME_ARCHITECTURES = Object.freeze(['amd64', 'arm64']);
export const FEISHU_RUNTIME_NODE_IMAGES = Object.freeze({
  amd64: 'docker.io/library/node@sha256:16d364eebf6b62da439dc993d9b80940c78b0ca38438452f011ab9a25c752644',
  arm64: 'docker.io/library/node@sha256:111d09056e51bb52d1bfca06a3e73476d6022b156dc4c36c5379503cd307660b',
});

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeSource = resolve(repoRoot, 'deploy/linux/feishu/runtime');
const bundle = resolve(repoRoot, 'build/linux-headless/feishu/index.mjs');
const outputRoot = resolve(repoRoot, 'build/feishu-runtime');

function fail(message) {
  throw new Error(`Feishu runtime build failed: ${message}`);
}

export function parseFeishuRuntimeArchitectures(argv) {
  if (argv.length === 0) return [...FEISHU_RUNTIME_ARCHITECTURES];
  if (argv.length !== 2 || argv[0] !== '--arch') fail('usage: --arch amd64|arm64|all');
  if (argv[1] === 'all') return [...FEISHU_RUNTIME_ARCHITECTURES];
  if (!FEISHU_RUNTIME_ARCHITECTURES.includes(argv[1])) {
    fail('usage: --arch amd64|arm64|all');
  }
  return [argv[1]];
}

export function runtimeArtifactNames(architecture) {
  if (!FEISHU_RUNTIME_ARCHITECTURES.includes(architecture)) fail('unsupported architecture');
  const artifact = `agent-deck-feishu-runtime-linux-${architecture}.tgz`;
  return Object.freeze({ artifact, descriptor: `${artifact.slice(0, -4)}.json`, checksum: `${artifact}.sha256` });
}

export function validateRuntimeDescriptor(value, architecture) {
  const names = runtimeArtifactNames(architecture);
  const expectedKeys = [
    'architecture', 'artifact', 'baseImage', 'betterSqlite3Version', 'libc', 'nodeAbi',
    'nodeVersion', 'platform', 'releaseVersion', 'schemaVersion', 'sha256', 'size',
  ];
  if (
    !value || typeof value !== 'object' || Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys) ||
    value.schemaVersion !== 1 || value.artifact !== names.artifact ||
    value.platform !== 'linux' || value.architecture !== architecture || value.libc !== 'glibc' ||
    value.nodeVersion !== '22.22.3' || value.nodeAbi !== 127 ||
    value.betterSqlite3Version !== '11.10.0' ||
    value.baseImage !== FEISHU_RUNTIME_NODE_IMAGES[architecture] ||
    typeof value.releaseVersion !== 'string' || value.releaseVersion.length === 0 ||
    typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256) ||
    !Number.isSafeInteger(value.size) || value.size <= 0
  ) fail('runtime descriptor is invalid');
  return value;
}

export function validateRuntimeArchiveEntries(entries) {
  const required = [
    './SHA256SUMS', './app/index.mjs', './bin/node',
    './node_modules/better-sqlite3/build/Release/better_sqlite3.node',
    './node_modules/better-sqlite3/lib/index.js', './runtime.json',
  ];
  const allowedRoots = ['./app/', './bin/', './node_modules/', './runtime.json', './SHA256SUMS'];
  if (new Set(entries).size !== entries.length || required.some((path) => !entries.includes(path))) {
    fail('runtime archive is incomplete or contains duplicate entries');
  }
  for (const path of entries) {
    if (
      path.startsWith('/') || path.includes('../') ||
      path !== './' && !allowedRoots.some((root) => path === root || path.startsWith(root)) ||
      /(^|\/)(src|test|tests|deps)(\/|$)|\.(c|cc|cpp|h|hpp|gyp|ts)$/u.test(path) ||
      /(secret|credential|known-host)/iu.test(path)
    ) fail(`runtime archive contains forbidden entry: ${path}`);
  }
}

function docker(args, options = {}) {
  return execFileSync('docker', args, {
    cwd: repoRoot,
    encoding: options.encoding ?? 'utf8',
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
  });
}

function buildContext() {
  const root = realpathSync(mkdtempSync(resolve(realpathSync(tmpdir()), 'agent-deck-feishu-runtime-')));
  for (const name of ['Containerfile', 'package.json', 'package-lock.json']) {
    copyFileSync(resolve(runtimeSource, name), resolve(root, name));
  }
  copyFileSync(bundle, resolve(root, 'index.mjs'));
  return root;
}

function verifyOutput(architecture, directory) {
  const names = runtimeArtifactNames(architecture);
  const descriptor = validateRuntimeDescriptor(
    JSON.parse(readFileSync(resolve(directory, names.descriptor), 'utf8')),
    architecture,
  );
  const artifact = resolve(directory, names.artifact);
  if (!statSync(artifact).isFile() || statSync(artifact).size !== descriptor.size) {
    fail(`runtime artifact size is invalid for ${architecture}`);
  }
  const checksum = readFileSync(resolve(directory, names.checksum), 'utf8');
  if (checksum !== `${descriptor.sha256}  ${names.artifact}\n`) {
    fail(`runtime checksum file is invalid for ${architecture}`);
  }
  validateRuntimeArchiveEntries(execFileSync('/usr/bin/tar', ['-tzf', artifact], {
    encoding: 'utf8',
  }).trim().split('\n'));
}

function buildArchitecture(architecture, releaseVersion) {
  const context = buildContext();
  const tag = `agent-deck-feishu-runtime-build:${architecture}-${randomUUID()}`;
  let container = null;
  try {
    docker([
      'build', '--pull', '--platform', `linux/${architecture}`,
      '--build-arg', `NODE_IMAGE=${FEISHU_RUNTIME_NODE_IMAGES[architecture]}`,
      '--build-arg', `TARGET_ARCH=${architecture}`,
      '--build-arg', `RELEASE_VERSION=${releaseVersion}`,
      '--file', resolve(context, 'Containerfile'), '--tag', tag, context,
    ], { stdio: 'inherit' });
    container = docker(['create', tag]).trim();
    if (!/^[a-f0-9]{64}$/.test(container)) fail('Docker returned an invalid container id');
    const directory = resolve(outputRoot, `linux-${architecture}`);
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(directory, { recursive: true, mode: 0o755 });
    docker(['cp', `${container}:/out/.`, directory]);
    verifyOutput(architecture, directory);
  } finally {
    if (container) {
      try { docker(['container', 'rm', '--force', container]); } catch {}
    }
    try { docker(['image', 'rm', '--force', tag]); } catch {}
    rmSync(context, { recursive: true, force: true });
  }
}

export function buildFeishuRuntimes(argv = process.argv.slice(2)) {
  if (!statSync(bundle, { throwIfNoEntry: false })?.isFile()) {
    fail('build/linux-headless/feishu/index.mjs is missing; run build:linux-headless first');
  }
  const project = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
  for (const architecture of parseFeishuRuntimeArchitectures(argv)) {
    buildArchitecture(architecture, String(project.version));
  }
  process.stdout.write('Feishu Linux 固定运行时构建已完成。\n');
}

const invokedAsEntrypoint = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;
if (invokedAsEntrypoint) buildFeishuRuntimes();
