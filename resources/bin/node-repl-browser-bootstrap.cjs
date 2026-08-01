'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

const BROWSER_PROCESS_PRELOAD = path.join(
  __dirname,
  'node-repl-browser-process-compat.cjs',
);
const DEFAULT_FORCE_KILL_TIMEOUT_MS = 5_000;
const TERMINATION_SIGNALS = ['SIGINT', 'SIGTERM'];

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

function attachProxyLifecycle(child, options = {}) {
  const hostProcess = options.hostProcess || process;
  const scheduleTimeout = options.scheduleTimeout || setTimeout;
  const cancelTimeout = options.cancelTimeout || clearTimeout;
  const forceKillTimeoutMs = Number.isFinite(options.forceKillTimeoutMs)
    && options.forceKillTimeoutMs >= 0
    ? options.forceKillTimeoutMs
    : DEFAULT_FORCE_KILL_TIMEOUT_MS;
  const signalHandlers = new Map();
  let childFinished = false;
  let proxyFinished = false;
  let terminationRequested = false;
  let forceKillTimer = null;

  const clearForceKillTimer = () => {
    if (forceKillTimer === null) return;
    cancelTimeout(forceKillTimer);
    forceKillTimer = null;
  };
  const removeSignalHandlers = () => {
    for (const [signal, handler] of signalHandlers) {
      hostProcess.removeListener(signal, handler);
    }
    signalHandlers.clear();
  };
  const finishProxy = (code, releaseChild = false) => {
    if (proxyFinished) return;
    proxyFinished = true;
    clearForceKillTimer();
    removeSignalHandlers();
    hostProcess.exitCode = code;
    if (releaseChild && typeof child.unref === 'function') child.unref();
  };
  const finishFromChild = (code, releaseChild = false) => {
    if (childFinished) return;
    childFinished = true;
    finishProxy(code, releaseChild);
  };
  const forwardSignal = (signal) => {
    if (childFinished || proxyFinished) return;
    if (!terminationRequested) {
      terminationRequested = true;
      forceKillTimer = scheduleTimeout(() => {
        forceKillTimer = null;
        if (childFinished || proxyFinished) return;
        try {
          child.kill('SIGKILL');
        } finally {
          // SIGKILL cannot be handled by the child. Releasing its handle also prevents a failed
          // kill submission from leaving this signal-handling wrapper alive forever.
          finishProxy(1, true);
        }
      }, forceKillTimeoutMs);
    }
    child.kill(signal);
  };

  child.once('error', (error) => {
    if (childFinished) return;
    hostProcess.stderr.write(
      `Agent Deck node_repl Browser bootstrap failed: ${error.message}\n`,
    );
    finishFromChild(1, true);
  });
  child.once('exit', (code, signal) => {
    finishFromChild(typeof code === 'number' ? code : signal ? 1 : 0);
  });
  for (const signal of TERMINATION_SIGNALS) {
    const handler = () => forwardSignal(signal);
    signalHandlers.set(signal, handler);
    hostProcess.on(signal, handler);
  }
}

function startProxy(target, lifecycleOptions) {
  const child = spawn(target.command, target.args, {
    env: buildTargetEnv(target, process.env),
    stdio: 'inherit',
  });
  attachProxyLifecycle(child, lifecycleOptions);
  return child;
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
  attachProxyLifecycle,
  appendNodeRequireOption,
  buildTargetEnv,
  decodeTarget,
  startProxy,
};
