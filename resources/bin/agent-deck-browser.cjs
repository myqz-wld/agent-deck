#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const PROTOCOL_VERSION = 1;
const CONTEXT_ENV = 'AGENT_DECK_BROWSER_CONTEXT_FILE';
const MAX_CONTEXT_BYTES = 8 * 1024;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 35_000;
const NULL_LIKE = new Set(['null', 'undefined']);

const COMMAND_SPECS = Object.freeze({
  open: { values: ['url'], booleans: ['new-tab', 'show'] },
  tabs: { values: [], booleans: [] },
  navigate: { values: ['tab', 'url'], booleans: ['reload'] },
  wait: {
    values: ['kind', 'selector', 'state', 'timeout-ms', 'idle-ms', 'tab'],
    booleans: [],
  },
  close: { values: ['tab'], booleans: ['all'] },
  snapshot: { values: ['tab', 'limit'], booleans: ['include-text'] },
  screenshot: { values: ['tab', 'max-width'], booleans: ['full-page'] },
  click: { values: ['ref', 'tab'], booleans: [] },
  type: {
    values: ['ref', 'text', 'text-file', 'tab'],
    booleans: ['append', 'submit'],
  },
  press: { values: ['key', 'tab'], booleans: [] },
  scroll: { values: ['tab', 'ref', 'to', 'dx', 'dy'], booleans: [] },
  console: { values: ['tab', 'limit'], booleans: [] },
  network: { values: ['tab', 'limit'], booleans: [] },
  evaluate: {
    values: ['expression', 'expression-file', 'tab'],
    booleans: [],
  },
});

function usageError(message) {
  const error = new Error(message);
  error.code = 'invalid_request';
  return error;
}

function rootHelp() {
  return [
    'Usage: agent-deck-browser <command> [flags]',
    'Commands:',
    '  agent-deck-browser open [--url URL] [--new-tab] [--show]',
    '  agent-deck-browser tabs',
    '  agent-deck-browser navigate [--tab N] (--url URL | --reload)',
    '  agent-deck-browser wait --kind selector|network-idle [flags]',
    '  agent-deck-browser close [--tab N | --all]',
    '  agent-deck-browser snapshot [--tab N] [--include-text] [--limit N]',
    '  agent-deck-browser screenshot [--tab N] [--full-page] [--max-width N]',
    '  agent-deck-browser click --ref REF [--tab N]',
    '  agent-deck-browser type --ref REF (--text TEXT | --text-file FILE) [flags]',
    '  agent-deck-browser press --key KEY [--tab N]',
    '  agent-deck-browser scroll [--tab N] [--ref REF | --to top|bottom | --dx N --dy N]',
    '  agent-deck-browser console [--tab N] [--limit N]',
    '  agent-deck-browser network [--tab N] [--limit N]',
    '  agent-deck-browser evaluate (--expression JS | --expression-file FILE) [--tab N]',
  ].join('\n');
}

function parseFlags(command, argv) {
  const spec = COMMAND_SPECS[command];
  if (!spec) throw usageError(`Unknown command: ${command || '(missing)'}.`);
  const values = new Map();
  const booleans = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw usageError(`Unexpected argument: ${token}.`);
    const equals = token.indexOf('=');
    const name = token.slice(2, equals === -1 ? undefined : equals);
    const inline = equals === -1 ? undefined : token.slice(equals + 1);
    if (spec.booleans.includes(name)) {
      if (inline !== undefined) throw usageError(`Flag --${name} does not take a value.`);
      if (booleans.has(name)) throw usageError(`Duplicate flag: --${name}.`);
      booleans.add(name);
      continue;
    }
    if (!spec.values.includes(name)) throw usageError(`Unknown flag: --${name}.`);
    if (values.has(name)) throw usageError(`Duplicate flag: --${name}.`);
    const next = inline === undefined ? argv[++index] : inline;
    if (next === undefined || (inline === undefined && next.startsWith('--'))) {
      throw usageError(`Flag --${name} requires a value.`);
    }
    values.set(name, next);
  }
  return { values, booleans };
}

function stringFlag(parsed, name, options = {}) {
  const value = parsed.values.get(name);
  if (value === undefined) return undefined;
  if (!options.allowEmpty && value.length === 0) throw usageError(`--${name} cannot be empty.`);
  if (!options.allowNullLike && NULL_LIKE.has(value.trim().toLowerCase())) {
    throw usageError(`--${name} cannot use a null-like value.`);
  }
  if (options.max !== undefined && value.length > options.max) {
    throw usageError(`--${name} exceeds ${options.max} characters.`);
  }
  return value;
}

function integerFlag(parsed, name, minimum, maximum) {
  const raw = stringFlag(parsed, name, { max: 16 });
  if (raw === undefined) return undefined;
  if (!/^-?\d+$/.test(raw)) throw usageError(`--${name} must be an integer.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw usageError(`--${name} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function enumFlag(parsed, name, allowed) {
  const value = stringFlag(parsed, name, { max: 32 });
  if (value !== undefined && !allowed.includes(value)) {
    throw usageError(`--${name} must be one of: ${allowed.join(', ')}.`);
  }
  return value;
}

function tabArg(parsed) {
  const tabId = integerFlag(parsed, 'tab', 1, Number.MAX_SAFE_INTEGER);
  return tabId === undefined ? {} : { tabId };
}

function required(value, name) {
  if (value === undefined) throw usageError(`--${name} is required.`);
  return value;
}

function pathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function readBoundedFile(file, cwd) {
  const lexicalRoot = path.resolve(cwd);
  const root = fs.realpathSync(lexicalRoot);
  const candidate = path.resolve(cwd, file);
  if (!pathInside(lexicalRoot, candidate)) throw usageError('Input file is outside the command cwd.');
  const before = fs.lstatSync(candidate);
  if (before.isSymbolicLink()) throw usageError('Input file cannot be a symbolic link.');
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | noFollow);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw usageError('Input must be a regular file.');
    if (stat.size > MAX_FILE_BYTES) throw usageError('Input file exceeds the byte limit.');
    const real = fs.realpathSync(candidate);
    if (!pathInside(root, real)) throw usageError('Input file is outside the command cwd.');
    const data = fs.readFileSync(descriptor, 'utf8');
    if (Buffer.byteLength(data) > MAX_FILE_BYTES) throw usageError('Input file exceeds the byte limit.');
    return data;
  } finally {
    fs.closeSync(descriptor);
  }
}

function exactlyOne(left, right, message) {
  if ((left === undefined) === (right === undefined)) throw usageError(message);
}

function parseCommandArgs(command, parsed, cwd) {
  const tab = tabArg(parsed);
  switch (command) {
    case 'open': {
      const url = stringFlag(parsed, 'url', { max: 2_048 });
      return {
        ...(url === undefined ? {} : { url }),
        ...(parsed.booleans.has('new-tab') ? { newTab: true } : {}),
        ...(parsed.booleans.has('show') ? { show: true } : {}),
      };
    }
    case 'tabs': return {};
    case 'navigate': {
      const url = stringFlag(parsed, 'url', { max: 2_048 });
      const reload = parsed.booleans.has('reload') ? true : undefined;
      exactlyOne(url, reload, 'Pass exactly one of --url or --reload.');
      return { ...tab, ...(url === undefined ? { reload: true } : { url }) };
    }
    case 'wait': {
      const kind = required(enumFlag(parsed, 'kind', ['selector', 'network-idle']), 'kind');
      const selector = stringFlag(parsed, 'selector', { max: 1_024 });
      const state = enumFlag(parsed, 'state', ['attached', 'visible', 'hidden', 'detached']);
      const timeoutMs = integerFlag(parsed, 'timeout-ms', 100, 30_000);
      const idleMs = integerFlag(parsed, 'idle-ms', 100, 5_000);
      if (kind === 'selector' && selector === undefined) throw usageError('--selector is required.');
      if (kind === 'selector' && idleMs !== undefined) throw usageError('--idle-ms is not valid.');
      if (kind === 'network-idle' && (selector !== undefined || state !== undefined)) {
        throw usageError('--selector and --state are not valid.');
      }
      return { kind, ...tab, ...(selector ? { selector } : {}), ...(state ? { state } : {}),
        ...(timeoutMs === undefined ? {} : { timeoutMs }), ...(idleMs === undefined ? {} : { idleMs }) };
    }
    case 'close': {
      if (parsed.booleans.has('all') && tab.tabId !== undefined) {
        throw usageError('--all and --tab are mutually exclusive.');
      }
      return parsed.booleans.has('all') ? { all: true } : tab;
    }
    case 'snapshot': return { ...tab,
      ...(parsed.booleans.has('include-text') ? { includeText: true } : {}),
      ...(parsed.values.has('limit') ? { limit: integerFlag(parsed, 'limit', 1, 400) } : {}) };
    case 'screenshot': return { ...tab,
      ...(parsed.booleans.has('full-page') ? { fullPage: true } : {}),
      ...(parsed.values.has('max-width') ? { maxWidth: integerFlag(parsed, 'max-width', 240, 2_560) } : {}) };
    case 'click': return { ref: required(stringFlag(parsed, 'ref', { max: 64 }), 'ref'), ...tab };
    case 'type': {
      const text = stringFlag(parsed, 'text', { max: 10_000, allowEmpty: true, allowNullLike: true });
      const file = stringFlag(parsed, 'text-file', { max: 4_096 });
      exactlyOne(text, file, 'Pass exactly one of --text or --text-file.');
      const input = file === undefined ? text : readBoundedFile(file, cwd);
      if (input.length > 10_000) throw usageError('Type input exceeds 10000 characters.');
      return { ref: required(stringFlag(parsed, 'ref', { max: 64 }), 'ref'), text: input,
        ...(parsed.booleans.has('append') ? { clear: false } : {}),
        ...(parsed.booleans.has('submit') ? { submit: true } : {}), ...tab };
    }
    case 'press': return { key: required(stringFlag(parsed, 'key', { max: 16 }), 'key'), ...tab };
    case 'scroll': {
      const modes = [
        parsed.values.has('ref'),
        parsed.values.has('to'),
        parsed.values.has('dx') || parsed.values.has('dy'),
      ].filter(Boolean).length;
      if (modes > 1) throw usageError('--ref, --to, and delta flags are mutually exclusive.');
      return { ...tab,
        ...(parsed.values.has('ref') ? { ref: stringFlag(parsed, 'ref', { max: 64 }) } : {}),
        ...(parsed.values.has('to') ? { to: enumFlag(parsed, 'to', ['top', 'bottom']) } : {}),
        ...(parsed.values.has('dx') ? { dx: integerFlag(parsed, 'dx', -20_000, 20_000) } : {}),
        ...(parsed.values.has('dy') ? { dy: integerFlag(parsed, 'dy', -20_000, 20_000) } : {}) };
    }
    case 'console':
    case 'network': return { ...tab,
      ...(parsed.values.has('limit') ? { limit: integerFlag(parsed, 'limit', 1, 200) } : {}) };
    case 'evaluate': {
      const expression = stringFlag(parsed, 'expression', { max: 8_000, allowNullLike: true });
      const file = stringFlag(parsed, 'expression-file', { max: 4_096 });
      exactlyOne(expression, file, 'Pass exactly one of --expression or --expression-file.');
      const input = file === undefined ? expression : readBoundedFile(file, cwd);
      if (!input || input.length > 8_000) throw usageError('Expression must contain 1 to 8000 characters.');
      return { expression: input, ...tab };
    }
  }
}

function parseCliArguments(argv, options = {}) {
  const command = argv[0];
  const parsed = parseFlags(command, argv.slice(1));
  const args = parseCommandArgs(command, parsed, options.cwd || process.cwd());
  return { protocolVersion: PROTOCOL_VERSION, operation: command, args };
}

function exactObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}.`);
  const actual = Object.keys(value).sort();
  const wanted = [...keys].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

function readContext(environment = process.env) {
  const contextPath = environment[CONTEXT_ENV];
  if (!contextPath) throw new Error('Browser context is unavailable for this runtime.');
  const before = fs.lstatSync(contextPath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error('Browser context is unavailable for this runtime.');
  }
  const descriptor = fs.openSync(
    contextPath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
  );
  let serialized;
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_CONTEXT_BYTES ||
        (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
      throw new Error('Browser context is unavailable for this runtime.');
    }
    serialized = fs.readFileSync(descriptor, 'utf8');
  } finally {
    fs.closeSync(descriptor);
  }
  const raw = exactObject(JSON.parse(serialized),
    ['adapterId', 'endpoint', 'lease', 'protocolVersion', 'runtimeGeneration', 'sourceIdentity'], 'Browser context');
  if (raw.protocolVersion !== PROTOCOL_VERSION || typeof raw.endpoint !== 'string' ||
      typeof raw.lease !== 'string' || typeof raw.adapterId !== 'string' ||
      !Number.isSafeInteger(raw.runtimeGeneration) || typeof raw.sourceIdentity !== 'string') {
    throw new Error('Browser context is unavailable for this runtime.');
  }
  return raw;
}

function encodeFrame(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const header = Buffer.allocUnsafe(4);
  if (os.endianness() === 'LE') header.writeUInt32LE(body.length); else header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

function invokeBroker(context, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(context.endpoint);
    const chunks = [];
    let retained = 0;
    let expected = null;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('Browser broker timed out.')), REQUEST_TIMEOUT_MS);
    timer.unref();
    socket.once('connect', () => socket.write(encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      lease: context.lease,
      proof: {
        adapterId: context.adapterId,
        runtimeGeneration: context.runtimeGeneration,
        sourceIdentity: context.sourceIdentity,
      },
      request,
    })));
    socket.on('data', (chunk) => {
      retained += chunk.length;
      if (retained > MAX_RESPONSE_BYTES + 4) return finish(new Error('Browser response exceeded its limit.'));
      chunks.push(chunk);
      const combined = Buffer.concat(chunks);
      if (expected === null && combined.length >= 4) {
        expected = os.endianness() === 'LE' ? combined.readUInt32LE(0) : combined.readUInt32BE(0);
        if (expected > MAX_RESPONSE_BYTES) return finish(new Error('Browser response exceeded its limit.'));
      }
      if (expected !== null && combined.length >= expected + 4) {
        if (combined.length !== expected + 4) return finish(new Error('Browser response was invalid.'));
        try { finish(null, JSON.parse(combined.subarray(4).toString('utf8'))); }
        catch { finish(new Error('Browser response was invalid.')); }
      }
    });
    socket.once('error', () => finish(new Error('Browser broker is unavailable.')));
    socket.once('close', () => {
      if (!settled) finish(new Error('Browser broker closed before responding.'));
    });
  });
}

function failure(operation, code, message, retryable, nextAction) {
  return { ok: false, protocolVersion: PROTOCOL_VERSION, operation,
    error: { code, message, retryable, nextAction } };
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function safeUsageMessage(error) {
  return error && error.code === 'invalid_request'
    ? String(error.message).slice(0, 512)
    : 'CLI input could not be validated or read.';
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === '--version') {
    writeJson({ ok: true, protocolVersion: PROTOCOL_VERSION, operation: 'version',
      data: { version: '1' }, artifacts: [] });
    return 0;
  }
  if (argv.length === 0 || argv[0] === '--help' || argv.includes('--help')) {
    writeJson({ ok: true, protocolVersion: PROTOCOL_VERSION, operation: 'help',
      data: { usage: rootHelp() }, artifacts: [] });
    return 0;
  }
  let request;
  try { request = parseCliArguments(argv); }
  catch (error) {
    writeJson(failure(argv[0] || 'unknown', 'invalid_request', safeUsageMessage(error), false,
      'Run agent-deck-browser --help and fix the command syntax.'));
    return 2;
  }
  let context;
  try { context = readContext(); }
  catch {
    writeJson(failure(request.operation, 'browser_context_unavailable',
      'Browser context is unavailable for this runtime.', false,
      'Start or restart an interactive Agent Deck session with its Browser skill enabled.'));
    return 3;
  }
  try {
    const response = await invokeBroker(context, request);
    writeJson(response);
    return response && response.ok === true ? 0 : 4;
  } catch {
    writeJson(failure(request.operation, 'transport_unavailable',
      'The Agent Deck Browser broker is unavailable.', true,
      'Retry once; if it still fails, restart the Agent Deck session.'));
    return 5;
  }
}

module.exports = { parseCliArguments, readContext, rootHelp, invokeBroker, main };

if (require.main === module) {
  void main().then((code) => { process.exitCode = code; }, () => { process.exitCode = 1; });
}
