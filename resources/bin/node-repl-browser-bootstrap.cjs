'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

const BROWSER_PROCESS_PRELOAD = path.join(
  __dirname,
  'node-repl-browser-process-compat.cjs',
);

function decodeTarget(encoded) {
  let target;
  try {
    target = JSON.parse(Buffer.from(encoded || '', 'base64url').toString('utf8'));
  } catch {
    throw new Error('invalid target payload');
  }
  if (!target || typeof target.command !== 'string' || target.command.trim() === '') {
    throw new Error('target command is missing');
  }
  if (!Array.isArray(target.args) || target.args.some((arg) => typeof arg !== 'string')) {
    throw new Error('target args must be a string array');
  }
  return target;
}

function appendNodeRequireOption(existing, preloadPath) {
  const requireOption = `--require=${JSON.stringify(preloadPath)}`;
  return typeof existing === 'string' && existing.trim() !== ''
    ? `${existing} ${requireOption}`
    : requireOption;
}

function buildTargetEnv(target, sourceEnv) {
  const targetEnv = { ...sourceEnv };
  delete targetEnv.ELECTRON_RUN_AS_NODE;
  if (typeof target.electronRunAsNode === 'string') {
    targetEnv.ELECTRON_RUN_AS_NODE = target.electronRunAsNode;
  }
  // node_repl passes NODE_OPTIONS to its JavaScript kernel, before the Browser client loads.
  targetEnv.NODE_OPTIONS = appendNodeRequireOption(
    targetEnv.NODE_OPTIONS,
    BROWSER_PROCESS_PRELOAD,
  );
  return targetEnv;
}

function startProxy(target) {
  const child = spawn(target.command, target.args, {
    env: buildTargetEnv(target, process.env),
    stdio: 'inherit',
  });
  let finished = false;
  const finish = (code) => {
    if (finished) return;
    finished = true;
    process.exitCode = code;
  };
  child.on('error', (error) => {
    process.stderr.write(`Agent Deck node_repl Browser bootstrap failed: ${error.message}\n`);
    finish(1);
  });
  child.on('exit', (code, signal) => {
    finish(typeof code === 'number' ? code : signal ? 1 : 0);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      if (!child.killed) child.kill(signal);
    });
  }
}

if (require.main === module) {
  try {
    startProxy(decodeTarget(process.argv[2]));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Agent Deck node_repl Browser bootstrap configuration error: ${detail}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  appendNodeRequireOption,
  buildTargetEnv,
  decodeTarget,
};
